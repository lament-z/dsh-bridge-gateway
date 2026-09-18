import { spawn, execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, stat, unlink, rename } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { cloudflaredDir } from './paths.js';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { get as httpsGet } from 'node:https';

const CLOUDFLARED_VERSION = '2024.10.0';
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5 分钟
const MIN_BINARY_SIZE = 5 * 1024 * 1024; // 最小 5MB，防止下到 HTML 错误页
// 意外退出后的指数退避重启策略（5s 起步、翻倍、封顶 5min、最多 12 次）
const CLOUDFLARED_RESTART_BASE_MS = 5000;
const CLOUDFLARED_RESTART_MAX_MS = 5 * 60 * 1000;
const CLOUDFLARED_MAX_RESTARTS = 12;

function getCloudflaredInfo() {
  const os = platform();
  const cpuArch = arch();

  const platformMap = {
    'win32-x64':   { file: 'cloudflared-windows-amd64.exe', name: 'cloudflared.exe' },
    'win32-arm64': { file: 'cloudflared-windows-arm64.exe', name: 'cloudflared.exe' },
    'darwin-x64':  { file: 'cloudflared-darwin-amd64.tgz',  name: 'cloudflared' },
    'darwin-arm64':{ file: 'cloudflared-darwin-arm64.tgz',  name: 'cloudflared' },
    'linux-x64':   { file: 'cloudflared-linux-amd64',       name: 'cloudflared' },
    'linux-arm64': { file: 'cloudflared-linux-arm64',       name: 'cloudflared' },
  };

  const key = `${os}-${cpuArch}`;
  const info = platformMap[key];
  if (!info) throw new Error(`不支持的平台: ${os}-${cpuArch}`);

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${info.file}`;
  return { url, name: info.name };
}

async function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('下载超时（5分钟）')), DOWNLOAD_TIMEOUT);

    function doGet(targetUrl, redirects = 0) {
      if (redirects > 5) {
        clearTimeout(timer);
        return reject(new Error('重定向次数过多'));
      }
      httpsGet(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          return doGet(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          clearTimeout(timer);
          return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.round(downloaded / total * 100), downloaded, total);
          }
        });

        const fileStream = createWriteStream(dest);
        pipeline(res, fileStream)
          .then(() => { clearTimeout(timer); resolve(); })
          .catch((err) => { clearTimeout(timer); reject(err); });
      }).on('error', (err) => { clearTimeout(timer); reject(err); });
    }

    doGet(url);
  });
}

function findSystemCloudflared() {
  const isWin = platform() === 'win32';
  const candidates = [];
  if (isWin) {
    candidates.push('cloudflared.exe', 'cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe');
  } else {
    candidates.push('cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/bin/cloudflared');
  }

  for (const bin of candidates) {
    try {
      if (bin.includes('/') || bin.includes('\\')) {
        if (!existsSync(bin)) continue;
      }
      execSync(`"${bin}" --version`, { stdio: 'ignore', timeout: 3000 });
      return bin;
    } catch {}
  }
  return null;
}

export class CloudflaredManager {
  constructor({ port, home, token, hostname, onStateChange, logger }) {
    this.port = port;
    this.home = home || cloudflaredDir();
    this.token = token ? String(token).trim() : null;
    this.hostname = hostname ? String(hostname).trim() : null;
    this.onStateChange = onStateChange;
    this.logger = logger;

    this.process = null;
    this.url = null;
    this.binaryPath = null;
    this._stopped = false;
    // 自愈状态：意外退出后按指数退避重启
    this._restartTimer = null;
    this._restartAttempts = 0;
  }

  // 意外退出后的指数退避重启计划。
  // 5s 起步、每次翻倍、封顶 5min，最多 12 次；用户手动关闭（stop()）或已恢复时取消。
  _scheduleRestart(reason) {
    if (this._stopped) return;
    if (this._restartAttempts >= CLOUDFLARED_MAX_RESTARTS) {
      this.logger?.error('cloudflared 连续退出 %d 次，停止自动重连', this._restartAttempts);
      this._setState('error', `隧道连续异常退出 ${this._restartAttempts} 次，已停止自动重连，请检查网络或 token 后手动开启。`);
      return;
    }
    const delay = Math.min(
      CLOUDFLARED_RESTART_BASE_MS * (2 ** this._restartAttempts),
      CLOUDFLARED_RESTART_MAX_MS,
    );
    this._restartAttempts += 1;
    this.logger?.warn('cloudflared %s，%dms 后第 %d 次自动重连', reason, delay, this._restartAttempts);
    this._setState('connecting', `隧道意外退出，${Math.round(delay / 1000)}s 后自动重连（第 ${this._restartAttempts} 次）`);
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._stopped) return;
      this._run().catch((err) => {
        this.logger?.error('cloudflared 自动重连失败: %s', err.message);
        this._scheduleRestart('重连失败');
      });
    }, delay);
    // 不要阻止进程退出（Node 下 long timer 会挂住事件循环）
    this._restartTimer.unref?.();
  }

  // 异步启动，立即返回——调用方不需要 await
  start() {
    this._stopped = false;
    this._run().catch((err) => {
      this.logger?.error('cloudflared 启动失败: %s', err.message);
      this._setState('error', err.message);
    });
  }

  async _run() {
    await this._ensureBinary();
    if (this._stopped) return;
    await this._startProcess();
  }

  async _ensureBinary() {
    // 1. 优先使用系统环境变量或 Homebrew / 包管理器已安装的全局二进制
    const systemBin = findSystemCloudflared();
    if (systemBin) {
      this.binaryPath = systemBin;
      this.logger?.info('优先使用系统全局 cloudflared: %s', systemBin);
      return;
    }

    const { url, name } = getCloudflaredInfo();
    const binDir = join(this.home, 'bin');
    const binPath = join(binDir, name);
    this.binaryPath = binPath;

    // 2. 检查本地 cloudflared 缓存（默认 ~/.dsh-bridge-cloudflared/bin）里是否已存在且可用
    if (existsSync(binPath)) {
      try {
        const s = await stat(binPath);
        if (s.size > MIN_BINARY_SIZE) { // >5MB 才视为有效二进制
          // 检查是否为历史残留未解压的 gzip 压缩包 (0x1f 0x8b)
          const fd = readFileSync(binPath);
          const isGzip = fd.length >= 2 && fd[0] === 0x1f && fd[1] === 0x8b;
          if (isGzip) {
            this.logger?.warn('检测到历史残留的未解压 cloudflared.tgz 压缩包，正在清理重新准备...');
            await unlink(binPath).catch(() => {});
          } else {
            // macOS / Linux 赋予可执行权限并清除 Gatekeeper 隔离属性
            if (platform() !== 'win32') {
              await chmod(binPath, 0o755).catch(() => {});
              if (platform() === 'darwin') {
                try { execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' }); } catch {}
              }
            }
            // 执行一次 --version 验证是否能正常 spawn
            execSync(`"${binPath}" --version`, { stdio: 'ignore', timeout: 3000 });
            this.logger?.info('cloudflared 已存在且验证通过: %s', binPath);
            return;
          }
        }
      } catch (verifyErr) {
        this.logger?.warn('现有 cloudflared 二进制验证失败 (%s)，准备重新下载', verifyErr.message);
      }
      // 损坏文件，删掉重下
      await unlink(binPath).catch(() => {});
    }

    this._setState('downloading', '正在下载 cloudflared (~30MB)...');
    this.logger?.info('从 %s 下载 cloudflared', url);

    mkdirSync(binDir, { recursive: true });
    const tempPath = `${binPath}.tmp`;

    try {
      await downloadFile(url, tempPath, (percent, downloaded, total) => {
        if (this._stopped) return;
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        this._setState('downloading', `下载 cloudflared: ${mb}/${totalMb} MB (${percent}%)`);
      });

      if (url.endsWith('.tgz') || url.endsWith('.tar.gz')) {
        try {
          execSync(`tar -xzf "${tempPath}" -C "${binDir}"`);
          await unlink(tempPath).catch(() => {});
        } catch (tarErr) {
          this.logger?.error('解压 cloudflared 压缩包失败: %s', tarErr.message);
          throw new Error(`解压 cloudflared 失败: ${tarErr.message}`);
        }
      } else {
        if (existsSync(binPath)) await unlink(binPath).catch(() => {});
        await rename(tempPath, binPath);
      }

      if (platform() !== 'win32') {
        await chmod(binPath, 0o755).catch(() => {});
        if (platform() === 'darwin') {
          try { execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' }); } catch {}
        }
      }

      // 执行 --version 最终确认
      execSync(`"${binPath}" --version`, { stdio: 'ignore', timeout: 3000 });
      this.logger?.info('cloudflared 下载并准备完成');
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw new Error(`准备 cloudflared 失败: ${err.message}`);
    }
  }

  _startProcess() {
    return new Promise((resolve, reject) => {
      if (this._stopped) return reject(new Error('已取消'));

      this._setState('connecting', '正在连接 Cloudflare...');

      // --no-autoupdate 兜底：cloudflared 的 24h 自动更新会在运行中把自身替换成新版本
      //   （进程自我替换 → 连接静默中断，且版本控制权落到 cloudflared 手里）。
      //   这里在参数层禁用，配合 spawn 的 NO_AUTOUPDATE 环境变量双保险。
      const args = this.token
        ? ['tunnel', '--no-autoupdate', 'run', '--token', this.token]
        : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];

      // 隐藏日志中的 token 敏感字段
      const safeArgs = this.token ? ['tunnel', '--no-autoupdate', 'run', '--token', '***'] : args;
      this.logger?.info('启动 cloudflared: %s %s', this.binaryPath, safeArgs.join(' '));

      this.process = spawn(this.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_AUTOUPDATE: 'true' },
      });

      let resolved = false;

      let timeoutTimer = null;

      const tryResolve = () => {
        if (!resolved) {
          resolved = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          // 连接成功 → 清零自愈计数，下次意外退出重新从 5s 起步
          this._restartAttempts = 0;
          resolve();
        }
      };

      // 1. 命名/Token 隧道：通过握手日志判定就绪，使用预设固定域名
      const parseNamedTunnel = (text) => {
        if (!this.token) return;
        if (
          (text.includes('Registered tunnel') ||
           text.includes('registered connIndex') ||
           text.includes('Connection') && text.includes('registered') ||
           text.includes('Updated to new configuration') ||
           text.includes('Route propagated')) &&
          !resolved
        ) {
          let fixedUrl = this.hostname
            ? (this.hostname.startsWith('http') ? this.hostname : `https://${this.hostname}`)
            : null;
          this.url = fixedUrl;
          this._setState('ready', fixedUrl ? `固定隧道已建立 (${fixedUrl})` : '固定隧道已建立');
          this.logger?.info('cloudflared 固定隧道就绪: %s', this.url || 'Token 模式');
          tryResolve();
        }
      };

      // 2. 免费临时隧道：从 stdout/stderr 解析随机分配的 trycloudflare.com 域名
      const parseUrl = (text) => {
        if (this.token) {
          parseNamedTunnel(text);
          return;
        }
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          this.url = match[0];
          this._setState('ready', '临时隧道已建立');
          this.logger?.info('cloudflared 临时隧道就绪: %s', this.url);
          tryResolve();
        }
      };

      this.process.stdout.on('data', (d) => parseUrl(d.toString()));
      this.process.stderr.on('data', (d) => {
        const text = d.toString();
        this.logger?.debug('cloudflared: %s', text.trim());
        parseUrl(text);
        if (text.includes('Registered tunnel') && !resolved) {
          this._setState('connecting', '隧道已注册，等待就绪...');
        }
      });

      this.process.on('exit', (code) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.process = null;
        this.url = null;
        if (!resolved) {
          reject(new Error(`cloudflared 退出，code=${code}`));
          return;
        }
        // 已就绪后意外退出（崩溃 / OOM / 被误杀 / autoupdate 自替换）：
        // 此前只把状态置为 idle 就"死透无人管"，公网入口失联且不会自行恢复。
        // 现按指数退避自动重启（5s 起步、封顶 5min、最多 12 次），恢复连接后计数清零。
        this._setState('idle', '');
        this._scheduleRestart(`cloudflared 意外退出 (code=${code})`);
      });

      this.process.on('error', (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (!resolved) reject(err);
      });

      // 连接超时 90 秒
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          this.stop();
          reject(new Error('等待隧道 URL 超时（90秒）'));
        }
      }, 90000);
    });
  }

  _setState(phase, detail) {
    this.onStateChange?.({ phase, detail });
  }

  stop() {
    this._stopped = true;
    // 取消待执行的自愈重连：用户主动关闭 / 重置后不应被自动拉起
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartAttempts = 0;
    if (this.process) {
      this.logger?.info('停止 cloudflared...');
      try {
        if (platform() === 'win32') {
          // Windows 不支持 SIGTERM，用 taskkill 强制终止
          spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          this.process.kill('SIGTERM');
        }
      } catch {}
      this.process = null;
    }
    this.url = null;
  }
}
