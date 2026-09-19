// dsh-bridge 主插件（Host）
//
// 多渠道访问桥：
//   1. 局域网访问代理（自动启动，零配置）
//   2. Cloudflare 隧道（一键获取公网地址）
//   3. 自建隧道（WebSocket 反向隧道 + Token 认证）

import { createServer, request as httpRequest, get as httpGet } from 'node:http';
import { get as httpsGet, createServer as createHttpsServer } from 'node:https';
import { networkInterfaces, homedir, totalmem, freemem, cpus, loadavg, platform, arch, release, hostname, uptime } from 'node:os';
import { join, dirname, basename, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, unlink, readdir, stat, access, appendFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { installBridgeRpc } from './bridge-rpc.js';
import { CustomTunnelClient } from './tunnel-client.mjs';
import { CloudflaredManager } from './cloudflared-manager.mjs';
import { PlatformManager } from './platform/manager.js';
import { WechatService } from './wechat/index.js';
import { QqService } from './qq/index.js';
import { FeishuService } from './feishu/index.js';
import { TelegramService } from './telegram/index.js';
import { AuthManager } from './auth/manager.js';
import { renderLoginPage } from './auth/login-template.js';
import { isSafeWorkspacePath, isSensitiveFolderName } from './security/path-validator.js';
import { applyRestoredPlatformConfig, RESTORED_STRING_FIELDS, PLATFORM_TIMING_FIELDS } from './platform/config-restore.js';
import {
  dataDir,
  configFile as configFilePath,
  resetAuthFile as resetAuthPath,
  certDir as certDirFor,
  migrateLegacyDataDir,
  migrateLegacyCloudflaredDir,
} from './paths.js';
import { getOrCreateSelfSignedCert } from './gateway/cert.js';

const name = 'dsh-bridge-gateway';
// 公网直连网关默认监听端口（自带 HTTPS 自签证书）
const DEFAULT_GATEWAY_PORT = 7443;
// Tailscale Serve 探测缓存 TTL：面板每 3s 轮询 getStatus，探测结果必须缓存，
// 否则每轮都会起 tailscale 子进程。用户显式点击「自动探测」时绕过缓存（force）。
const TAILNET_TTL_MS = 30_000;
// 微信 Bot 会话桥依赖 DSH 提供的会话/agent/审批/工作区/持久化服务，需显式 inject
// loader 用于挂载目录选择器的 host 后端与浏览器 UI 面（见 mountDirectoryPicker）
const inject = ['connection', 'webServer', 'sessions', 'agents', 'approval', 'workspaceRegistry', 'sessionPersistence', 'loader'];

// 目录选择器：DSH 原生的 dsh-host-directory-picker-auto 按 webServer.host 解析，
// 而 `dsh web` 只允许绑 127.0.0.1（--host 0.0.0.0 在启动时被拒绝），故在 macOS 上
// 它恒为 native —— 只在主机屏幕弹系统对话框，远程/手机浏览器看不到也点不到。
// 这里仿 auto 的做法，改挂 browse 后端 + 配套浏览器 UI 面，使本机与远程统一使用
// 网页版目录树（该组件本身已做窄屏适配）。
// 注意：这两面必须成对挂载 —— dsh-host-directory-picker-browse 是纯 host 包
// （package.json 无 dsh.client），它的 UI 面只由该 client 包自己的 apply 注册。
const DIRECTORY_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse';
const DIRECTORY_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse';

// 从 package.json 动态读取版本号，发版只需改 package.json 一处
const PACKAGE_JSON = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version ?? '0.0.0';

const VIRTUAL_KEYWORDS = [
  'vethernet', 'wsl', 'hyper-v', 'virtual', 'vmware', 'vbox', 'docker',
  'tailscale', 'zerotier', 'tap', 'tun', 'utun', 'wireguard', 'loopback', 'bridge',
];

/**
 * 列出所有可用的局域网 IPv4 网卡与 IP 地址（按推荐优先级排序）
 */
function listAllLanIPv4() {
  const interfaces = networkInterfaces();
  const list = [];

  for (const [ifname, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const lower = ifname.toLowerCase();
    const isVirtual = VIRTUAL_KEYWORDS.some((kw) => lower.includes(kw));

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      let score = 0;
      // 1. IP 网段优先（家庭/企业物理局域网最常用网段）
      if (addr.address.startsWith('192.168.')) score += 100;
      else if (addr.address.startsWith('10.')) score += 90;
      else if (addr.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) score += 70;
      else score += 10;

      // 2. 物理网卡与名称特征优先
      if (isVirtual) {
        score -= 200; // 虚拟网卡大幅降权
      } else {
        score += 100;
        if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) score += 50;
        else if (lower.includes('ethernet') || lower.includes('以太网') || lower.includes('eth') || lower.includes('en')) score += 40;
      }

      let label = ifname;
      if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) label += ' (Wi-Fi 无线网卡)';
      else if (lower.includes('ethernet') || lower.includes('以太网') || lower.includes('eth') || lower.includes('en')) label += ' (有线网卡)';
      else if (isVirtual) label += ' (虚拟网卡 / WSL / 虚拟机)';

      list.push({
        name: ifname,
        label,
        address: addr.address,
        netmask: addr.netmask,
        isVirtual,
        score,
      });
    }
  }

  return list.sort((a, b) => b.score - a.score);
}

/**
 * 选择最佳默认局域网 IP
 */
function selectLanIPv4() {
  const list = listAllLanIPv4();
  return list[0]?.address || null;
}

/**
 * 二维码缓存（带 TTL + LRU）
 */
class QrCache {
  constructor(ttl = 30 * 60 * 1000, maxSize = 8) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  async get(text) {
    const cached = this.cache.get(text);
    if (cached && Date.now() - cached.time < this.ttl) {
      return cached.data;
    }

    const qr = await QRCode.toDataURL(text, {
      width: 300,
      margin: 2,
      color: { dark: '#1F2421', light: '#FFFFFF' },
    });

    this.cache.set(text, { data: qr, time: Date.now() });

    if (this.cache.size > this.maxSize) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].time - b[1].time)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }

    return qr;
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * PWA Web App Manifest 与 App 启动图标
 */
const PWA_MANIFEST = JSON.stringify({
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  description: 'DeepSeek Harness Remote & Mobile Workspace',
  start_url: '/',
  display: 'standalone',
  background_color: '#181825',
  theme_color: '#1e1e2e',
  orientation: 'any',
  icons: [
    {
      src: '/__dsh_bridge__/pwa-icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable'
    }
  ]
}, null, 2);

const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4f6ef7"/>
      <stop offset="100%" stop-color="#24388a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="128" fill="url(#g)"/>
  <path d="M150 170 C150 140, 362 140, 362 170 L362 330 C362 360, 150 360, 150 330 Z" fill="#ffffff" fill-opacity="0.12"/>
  <circle cx="206" cy="220" r="28" fill="#ffffff"/>
  <circle cx="306" cy="220" r="28" fill="#ffffff"/>
  <path d="M200 290 Q256 340 312 290" stroke="#ffffff" stroke-width="24" stroke-linecap="round" fill="none"/>
  <rect x="236" y="90" width="40" height="60" rx="10" fill="#ffffff"/>
  <circle cx="256" cy="80" r="16" fill="#4f6ef7"/>
</svg>`;


function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * 读取 DSH 本地凭证并生成 loopback dsh-auth 认证签名 Cookie (适配 DSH 新版原生认证)
 */
function getDshLoopbackCookie(targetPort) {
  try {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const credPath = join(dshHome, '.credentials.yaml');
    if (!existsSync(credPath)) return '';
    const content = readFileSync(credPath, 'utf8');
    const match = content.match(/secret:\s*([A-Za-z0-9_-]+)/);
    if (!match) return '';
    const secret = Buffer.from(match[1], 'base64url');

    const authority = `127.0.0.1:${targetPort}`;
    const name = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest());
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 30 * 24 * 3600 * 1000;
    const body = encodeBase64Url(Buffer.from(JSON.stringify({
      version: 1, authority, issuedAt, expiresAt,
    }), 'utf8'));
    const sig = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
    return `${name}=v1.${body}.${sig}`;
  } catch {
    return '';
  }
}

/** points-checkin 本机 host bridge 的候选端口（与其 client 端探测顺序一致） */
const POINTS_CHECKIN_PORTS = [27182, 27183, 27184, 27185, 27186, 27187, 27188, 27189, 27190, 27191];

/** 把请求头中的 Host 和 Origin 改写成 loopback，让 DSH 的安全栅栏放行 */
function loopbackHeaders(headers, targetPort) {
  const authority = `127.0.0.1:${targetPort}`;
  const out = { ...headers };
  out['host'] = authority;
  if (out['origin']) out['origin'] = `http://${authority}`;
  if (out['Origin']) out['Origin'] = `http://${authority}`;

  // 1. 注入 DSH 本地认证签名（若有）
  const dshCookie = getDshLoopbackCookie(targetPort);
  if (dshCookie) {
    const existing = out['cookie'] || out['Cookie'] || '';
    out['cookie'] = existing ? `${existing}; ${dshCookie}` : dshCookie;
    delete out['Cookie'];
  }

  // 2. 禁用内部代理流量压缩，确保代理层拿到未压缩 HTML 以稳定注入 ownsHost 和 Polyfill
  delete out['accept-encoding'];
  delete out['Accept-Encoding'];

  return out;
}

// ---- 公网直连网关：连接台账 / WebSocket 保活 / 访问日志 ----
//
// 为什么需要：WebSocket 一旦 upgrade 成功就脱离了 HTTP 解析器，server.timeout /
// keepAliveTimeout / headersTimeout 对它全部失效。此时若客户端静默消失（进电梯断网、
// 被系统杀进程、NAT 表项过期），服务端收不到任何通知，连接会一直挂到内核 TCP 保活兜底
// （macOS 默认 net.inet.tcp.keepidle = 7200s，最长两小时），期间 socket、内存与上游
// 管道全部被占住。这里补上应用层保活：空闲到期先发 WebSocket ping 探活，一个字节都
// 收不回来就判定死链并回收；同时把每个来访 IP 与鉴权方式写进访问日志，事后可追溯。
const GW_WS_PING_IDLE_MS = 60 * 1000; // 连续无入向字节达此时长 -> 发 ping 探活
const GW_WS_PING_WAIT_MS = 30 * 1000; // 发 ping 后此时长内仍无入向字节 -> 判定死链
const GW_WS_MAX_IDLE_MS = 0; // 绝对空闲上限（0 = 不启用，仅靠 ping/pong 判活）
const GW_HEALTH_TICK_MS = 15 * 1000; // 保活巡检周期
const GW_ACCESS_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 去掉 IPv4-mapped IPv6 前缀，让日志里的 IP 可读、可比对 */
function normalizeClientIp(raw) {
  const ip = String(raw ?? '');
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** 网关数据目录（与 config.json 同处） */
function gatewayDataDir() {
  return dataDir();
}

/**
 * 追加一条网关访问记录（JSONL，超限滚动保留一份历史）。
 * 任何失败都静默吞掉——日志绝不能影响代理主流程。
 */
function appendGatewayAccessLog(entry) {
  const dir = gatewayDataDir();
  const file = join(dir, 'access.log');
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      try {
        const info = await stat(file);
        if (info.size > GW_ACCESS_LOG_MAX_BYTES) await rename(file, join(dir, 'access.log.1'));
      } catch {
        /* 首次写入，文件尚不存在 */
      }
      await appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* 日志不可写时保持静默 */
    }
  })();
}

/** 发送一个零载荷 WebSocket ping 控制帧（服务端 -> 客户端，不加掩码） */
function writeWsPing(socket) {
  try {
    socket.write(Buffer.from([0x89, 0x00]));
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP + WebSocket 代理服务器（带安全认证守门）
 * 关键：改写 Host + Origin，注入 crypto.randomUUID polyfill
 * 并在未授权时拦截并展示 DSH 风格登录页，阻止未授权 WebSocket 与 API 调用
 */
class ProxyServer {
  /**
   * @param {object} opts
   * @param {number} opts.localPort 监听端口
   * @param {number} opts.targetPort 上游 DSH web(loopback) 端口
   * @param {object} [opts.authManager] 认证管理器
   * @param {object} [opts.logger]
   * @param {{ key: string|Buffer, cert: string|Buffer }} [opts.tls] 若提供则启用 HTTPS（公网直连网关）
   * @param {string} [opts.tag] 日志标签（如 '网关'）
   * @param {Array<{prefix:string,targetPort:number,stripPrefix?:boolean}>} [opts.extraTargets] 额外的本机插件 host 反代目标（如 points-checkin 的本地 bridge），鉴权通过后按前缀转发
   */
  constructor({ localPort, targetPort, authManager, logger, tls, tag = '', extraTargets = [] }) {
    this.localPort = localPort;
    this.targetPort = targetPort;
    this.authManager = authManager;
    this.logger = logger;
    this.tls = tls ?? null;
    this.tag = tag ? `[${tag}] ` : '';
    this.extraTargets = Array.isArray(extraTargets) ? extraTargets : [];
    this.server = null;
    this.clientSockets = new Set();
    this.wsSockets = new Map(); // socket -> 已 upgrade 的长连接台账
    this.activeConnections = 0;
    this.healthTimer = null;
  }

  async start() {
    if (this.server) return;

    const handler = (req, res) => {
      const pathname = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

      // 0. PWA Web App Manifest 与 App 图标支持
      if (pathname === '/manifest.webmanifest' || pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(PWA_MANIFEST);
        return;
      }
      if (pathname === '/__dsh_bridge__/pwa-icon.svg' || pathname === '/apple-touch-icon.png') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(PWA_ICON_SVG);
        return;
      }

      // 1. 处理登录 API: POST /__dsh_bridge__/login
      if (pathname === '/__dsh_bridge__/login' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const clientIp = normalizeClientIp(req.socket?.remoteAddress);
            const verify = this.authManager?.verifyPassword(body.password, clientIp);
            if (verify?.success) {
              appendGatewayAccessLog({
                ev: 'login-ok', ip: clientIp, ua: String(req.headers?.['user-agent'] ?? '').slice(0, 200),
              });
              const sessionToken = this.authManager.createSession();
              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Set-Cookie': `dsh_bridge_auth=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
              });
              res.end(JSON.stringify({ ok: true }));
            } else {
              appendGatewayAccessLog({
                ev: 'login-fail', ip: clientIp, ua: String(req.headers?.['user-agent'] ?? '').slice(0, 200),
                error: verify?.error || '访问密码错误',
              });
              res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: verify?.error || '访问密码错误' }));
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '无效请求' }));
          }
        });
        return;
      }

      // 2. 处理登出 API: POST /__dsh_bridge__/logout
      if (pathname === '/__dsh_bridge__/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'dsh_bridge_auth=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 3. 处理鉴权状态 API: GET /__dsh_bridge__/auth-status (严格脱敏，不暴露 secretToken)
      if (pathname === '/__dsh_bridge__/auth-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this.authManager?.getPublicStatus() ?? { enabled: false }));
        return;
      }

      // 3.1 本机特权 Token 签发：仅限真正物理回环连接（127.0.0.1 / ::1，严禁隧道转发流量伪造）
      if (pathname === '/__dsh_bridge__/loopback-token') {
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const remote = req.socket?.remoteAddress || '';
        const isLoopback = (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
        const internalTunnelHeader = req.headers?.['x-dsh-internal-tunnel'];
        const isCustomTunnel = Boolean(isLoopback && internalTunnelHeader && internalTunnelHeader === this.authManager?.internalTunnelSecret);
        const isCloudflare = Boolean(isLoopback && (req.headers?.['cf-ray'] || req.headers?.['cf-connecting-ip']));
        const isPublicTunnel = isCustomTunnel || isCloudflare;

        if (isLoopback && !isPublicTunnel && this.authManager) {
          const adminToken = this.authManager.createAdminSession();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, adminToken }));
          return;
        }

        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden: loopback only' }));
        return;
      }

      // 4. 核心鉴权拦截
      const auth = this.authManager?.verifyRequest(req) ?? { authenticated: true };

      // 4.1 若从 URL Token 认证通过：下发 Cookie 并 302 重定向到干净 URL (去掉 ?auth=)
      if (auth.fromToken) {
        appendGatewayAccessLog({
          ev: 'token-login',
          ip: normalizeClientIp(req.socket?.remoteAddress),
          ua: String(req.headers?.['user-agent'] ?? '').slice(0, 200),
        });
        const sessionToken = this.authManager.createSession();
        try {
          const urlObj = new URL(req.url, 'http://localhost');
          urlObj.searchParams.delete('auth');
          urlObj.searchParams.delete('token');
          const cleanPath = (urlObj.pathname || '/') + (urlObj.search || '');
          res.writeHead(302, {
            'Location': cleanPath,
            'Set-Cookie': `dsh_bridge_auth=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          });
          res.end();
          return;
        } catch {
          res.writeHead(302, {
            'Location': '/',
            'Set-Cookie': `dsh_bridge_auth=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          });
          res.end();
          return;
        }
      }

      // 4.2 若未通过认证：根据请求类型渲染 DSH 登录页或返回 401 JSON
      if (!auth.authenticated) {
        const accept = String(req.headers['accept'] || '');
        const isHtml = accept.includes('text/html') || (!req.url.startsWith('/api/') && !req.url.includes('.'));
        if (isHtml) {
          const clientIp = req.socket?.remoteAddress || '';
          const isLocked = this.authManager?.isIpBlocked(clientIp);
          const html = renderLoginPage({
            hasPassword: this.authManager?.hasPassword,
            locked: isLocked,
            error: isLocked ? '尝试次数过多，请 60 秒后再试' : '',
          });
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized', message: '需要访问认证，请先登录' }));
          return;
        }
      }

      // 4.3 认证通过：可选插件 host 反向代理（如 points-checkin 本地 bridge，供远程 HTTPS 网关的页面同源调用）
      if (this.extraTargets && this.extraTargets.length) {
        const extra = this.extraTargets.find(
          (t) => pathname === t.prefix || pathname.startsWith(`${t.prefix}/`)
        );
        if (extra) {
          const qIndex = (req.url || '').indexOf('?');
          const qs = qIndex >= 0 ? (req.url || '').slice(qIndex) : '';
          const upstreamPath = extra.stripPrefix
            ? (pathname.slice(extra.prefix.length) || '/') + qs
            : req.url;
          const headers = loopbackHeaders(req.headers, extra.targetPort);
          const extraReq = httpRequest(
            {
              host: '127.0.0.1',
              port: extra.targetPort,
              method: req.method,
              path: upstreamPath,
              headers,
              agent: false,
            },
            (extraRes) => {
              const out = { ...extraRes.headers };
              delete out['transfer-encoding'];
              delete out['content-length'];
              res.writeHead(extraRes.statusCode ?? 502, out);
              extraRes.pipe(res);
              res.on('close', () => extraRes.destroy());
              extraRes.on('error', () => {
                if (!res.writableEnded) res.destroy();
              });
            }
          );
          extraReq.on('error', (err) => {
            this.logger.error('插件 host 代理请求失败(%s): %s', extra.prefix, err.message);
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
              res.end(
                `dsh-bridge: 无法连接插件 host 服务 (127.0.0.1:${extra.targetPort}) — ${err.message}`
              );
            } else {
              res.destroy();
            }
          });
          req.pipe(extraReq);
          return;
        }
      }

      // 5. 认证通过：纯透明反向代理转发（不再改写响应体；PWA 注入改由
      //    DSH 官方 webserver/index-inject 机制在 apply() 中贡献）
      const headers = loopbackHeaders(req.headers, this.targetPort);
      const proxyReq = httpRequest(
        { host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url, headers, agent: false },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
          res.on('close', () => proxyRes.destroy());
          proxyRes.on('error', () => res.destroy());
          proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
        },
      );
      proxyReq.on('error', (err) => {
        this.logger.error('代理请求失败: %s', err.message);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`dsh-bridge: 无法连接 dsh web (127.0.0.1:${this.targetPort}) — ${err.message}`);
      });
      req.pipe(proxyReq);
    };

    // 依据是否配置 TLS 选择 HTTPS 或 HTTP 服务器（HTTPS 用于公网直连网关）
    this.server = this.tls ? createHttpsServer(this.tls, handler) : createServer(handler);

    // 显式锁定 HTTP 层超时。已 upgrade 的 WebSocket 不受这些值约束，保留它们只为拦住
    // 「握手前的慢速攻击」，不因存在长连接而放宽。
    this.server.headersTimeout = 60 * 1000;
    this.server.requestTimeout = 300 * 1000;
    this.server.keepAliveTimeout = 5 * 1000;

    // WebSocket upgrade 鉴权与代理
    this.server.on('upgrade', (req, socket, head) => {
      const clientIp = normalizeClientIp(socket.remoteAddress);
      const userAgent = String(req.headers?.['user-agent'] ?? '').slice(0, 200);
      const auth = this.authManager?.verifyRequest(req) ?? { authenticated: true };
      if (!auth.authenticated) {
        appendGatewayAccessLog({ ev: 'ws-denied', ip: clientIp, path: req.url, ua: userAgent });
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized\r\n');
        socket.destroy();
        return;
      }
      if (auth.delegated) {
        appendGatewayAccessLog({ ev: 'ws-auth-delegated', ip: clientIp, path: pathname, ua: userAgent });
      }

      const authVia = auth.fromToken ? 'token'
        : auth.loopback ? 'loopback'
          : auth.lanBypass ? 'lan-bypass'
            : auth.publicBypass ? 'public-bypass'
              : 'session';

      // 连接台账：探活只看「有没有入向字节」，任何来自客户端的字节（含 pong）都算活着
      const conn = {
        id: randomUUID().slice(0, 8),
        ip: clientIp,
        ua: userAgent,
        via: authVia,
        path: String(req.url ?? '').slice(0, 200),
        startedAt: Date.now(),
        lastInboundAt: Date.now(),
        pingSentAt: 0,
        closeReason: '',
        closed: false,
      };
      socket.on('data', () => {
        conn.lastInboundAt = Date.now();
        conn.pingSentAt = 0; // 收到 pong 或任何业务帧，解除探活状态
      });
      socket.on('close', () => {
        if (conn.closed) return;
        conn.closed = true;
        this.wsSockets.delete(socket);
        appendGatewayAccessLog({
          ev: 'ws-close',
          ip: conn.ip,
          via: conn.via,
          conn: conn.id,
          durSec: Math.round((Date.now() - conn.startedAt) / 1000),
          rx: socket.bytesRead ?? 0,
          tx: socket.bytesWritten ?? 0,
          reason: conn.closeReason || 'closed',
        });
      });
      this.wsSockets.set(socket, conn);
      appendGatewayAccessLog({ ev: 'ws-open', ip: clientIp, via: authVia, conn: conn.id, path: conn.path, ua: userAgent });

      const headers = loopbackHeaders(req.headers, this.targetPort);
      const proxyReq = httpRequest({
        host: '127.0.0.1', port: this.targetPort, method: req.method, path: req.url, headers, agent: false,
      });
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n');
        const raw = [];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        socket.write(`${raw.join('\r\n')}\r\n\r\n`);
        if (proxyHead?.length) socket.write(proxyHead);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        const teardown = (why) => {
          if (why && !conn.closeReason) conn.closeReason = why;
          try { proxySocket.destroy(); } catch {}
          try { socket.destroy(); } catch {}
        };
        proxySocket.on('close', () => teardown('upstream-close'));
        socket.on('close', () => teardown('peer-close'));
      });
      proxyReq.on('response', (proxyRes) => {
        if (proxyRes.statusCode === 101) return;
        conn.closeReason = conn.closeReason || 'upstream-status';
        try {
          const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
          }
          socket.end(raw.join('\r\n') + '\r\n\r\n');
          proxyRes.resume();
        } catch { socket.destroy(); }
      });
      proxyReq.on('error', () => {
        conn.closeReason = conn.closeReason || 'upstream-error';
        socket.destroy();
      });
      if (head?.length) proxyReq.write(head);
      proxyReq.end();
      socket.on('error', () => socket.destroy());
    });

    // 跟踪所有连接以便 stop() 时强制关闭；顺带让面板的「活动连接数」有真实台账
    this.server.on('connection', (sock) => {
      this.clientSockets.add(sock);
      this.activeConnections = this.clientSockets.size;
      sock.on('close', () => {
        this.clientSockets.delete(sock);
        this.activeConnections = this.clientSockets.size;
      });
      sock.on('error', () => {});
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.localPort, '0.0.0.0', () => {
        const proto = this.tls ? 'https' : 'http';
        this.logger.info('dsh-bridge: %s代理已启动 %s://0.0.0.0:%d -> 127.0.0.1:%d', this.tag, proto, this.localPort, this.targetPort);
        resolve();
      });
    });
    this.startHealthWatch();
  }

  /** 启动长连接保活巡检（幂等） */
  startHealthWatch() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.healthTick(), GW_HEALTH_TICK_MS);
    this.healthTimer.unref?.();
  }

  /**
   * 保活巡检：对静默连接先发 ping 探活，探不到任何回音即判定死链并回收；
   * 顺带清掉已经销毁却仍留在台账里的残留。
   */
  healthTick() {
    const now = Date.now();
    for (const [socket, conn] of this.wsSockets) {
      if (!socket || socket.destroyed) {
        this.wsSockets.delete(socket);
        continue;
      }
      const idleMs = now - conn.lastInboundAt;
      if (conn.pingSentAt) {
        if (now - conn.pingSentAt >= GW_WS_PING_WAIT_MS) {
          this.recycleGatewaySocket(socket, 'dead-peer', idleMs);
          continue;
        }
      } else if (idleMs >= GW_WS_PING_IDLE_MS) {
        if (writeWsPing(socket)) conn.pingSentAt = now;
      }
      if (GW_WS_MAX_IDLE_MS > 0 && idleMs >= GW_WS_MAX_IDLE_MS) {
        this.recycleGatewaySocket(socket, 'idle-timeout', idleMs);
      }
    }
  }

  /** 回收一条外网长连接，并把回收原因写进访问日志 */
  recycleGatewaySocket(socket, reason, idleMs) {
    const conn = this.wsSockets.get(socket);
    if (conn) conn.closeReason = reason;
    this.logger?.warn?.(
      'dsh-bridge: %s回收外网长连接 %s（%s，静默 %ds，鉴权方式 %s）',
      this.tag, conn?.ip ?? '未知', reason, Math.round((idleMs ?? 0) / 1000), conn?.via ?? '未知',
    );
    try { socket.destroy(); } catch {}
  }

  async stop() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (!this.server) return;
    for (const s of this.clientSockets) { try { s.destroy(); } catch {} }
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.clientSockets.clear();
    this.wsSockets.clear();
    this.activeConnections = 0;
  }

  /** 当前外网长连接台账摘要（供面板显示） */
  connectionSummary() {
    const byIp = new Map();
    for (const conn of this.wsSockets.values()) {
      const item = byIp.get(conn.ip) ?? { ip: conn.ip, count: 0, via: conn.via, oldestSec: 0, paths: [] };
      item.count += 1;
      item.oldestSec = Math.max(item.oldestSec, Math.round((Date.now() - conn.startedAt) / 1000));
      if (conn.path && !item.paths.includes(conn.path)) item.paths.push(conn.path);
      byIp.set(conn.ip, item);
    }
    return [...byIp.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * 强制断开指定来源 IP 的所有连接（WS + HTTP socket）。
   * @returns {{ kicked: number }} 实际断开的连接数
   */
  kickByIp(ip) {
    const target = String(ip ?? '').trim();
    if (!target) return { kicked: 0 };
    let kicked = 0;
    for (const [socket, conn] of this.wsSockets) {
      if (conn.ip !== target || conn.closed) continue;
      conn.closeReason = 'kicked-by-admin';
      try { socket.destroy(); } catch { }
      kicked += 1;
    }
    for (const socket of this.clientSockets) {
      const remote = normalizeClientIp(socket.remoteAddress);
      if (remote === target && !socket.destroyed) {
        try { socket.destroy(); } catch { }
        kicked += 1;
      }
    }
    this.logger?.warn?.(`dsh-bridge: 管理员强制断开 ${target} 的 ${kicked} 条连接`);
    return { kicked };
  }

  get port() {
    return this.localPort;
  }
}

/**
 * Bridge Service
 */
class BridgeService {
  constructor({ dshPort, proxyPort, home, cloudflaredConfig, customTunnelConfig, tailscaleConfig, lanConfig, gatewayConfig, authManager, onPersist, logger }) {
    this.dshPort = dshPort;
    this.proxyPort = proxyPort;
    this.home = home;
    this.cloudflaredConfig = cloudflaredConfig ?? { token: '', hostname: '', autoStart: false };
    this.customTunnelConfig = customTunnelConfig ?? null;
    this.tailscaleConfig = tailscaleConfig ?? null;
    this.selectedLanIp = lanConfig?.selectedIp ?? null;
    this.gatewayConfig = gatewayConfig ?? null;
    this.authManager = authManager ?? null;
    this.onPersist = onPersist ?? null;
    this.logger = logger;

    this.qrCache = new QrCache();
    this.proxy = null;

    this.customTunnel = null;
    this.customTunnelState = { phase: 'idle', detail: '' };

    this.cloudflared = null;
    this.cloudflaredState = { phase: 'idle', detail: '' };

    // Tailscale Serve 探测快照（30s TTL；由 refreshTailnet 刷新，getStatus 只读）
    this.tailnet = null;

    // 公网直连网关（0.0.0.0:port 自带 HTTPS 自签证书 + 强制 public_only 门禁）
    this.gateway = null;
    this.gatewayAuth = null; // 网关专用认证实例：always enabled + scope=all，仅环回可免密
  }

  async setLanIp({ ip } = {}) {
    const trimmed = ip ? String(ip).trim() : null;
    this.selectedLanIp = trimmed || null;
    await this.onPersist?.({ lan: { selectedIp: this.selectedLanIp } });
    this.logger?.info('局域网选定 IP 更新为: %s', this.selectedLanIp || '自动推荐');
    return this.getStatus();
  }

  // 探测 points-checkin 本机 host bridge 端口（供网关反代 /points-checkin/*，实现远程 HTTPS 下积分签到可用）
  async _resolvePointsCheckinPort() {
    if (this._pcPortResolved) return this._pcPort ?? null;
    this._pcPortResolved = true;
    this._pcPort = null;
    for (const port of POINTS_CHECKIN_PORTS) {
      const ok = await new Promise((resolve) => {
        const req = httpGet(
          { host: '127.0.0.1', port, path: '/ping', timeout: 500, headers: { 'User-Agent': 'dsh-bridge-gateway' } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                resolve(body?.ok === true && body.plugin === 'points-checkin');
              } catch {
                resolve(false);
              }
            });
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) {
        this._pcPort = port;
        this.logger?.info?.('已发现 points-checkin host bridge: 127.0.0.1:%d', port);
        break;
      }
    }
    return this._pcPort ?? null;
  }

  async startProxy() {
    if (this.proxy) return this.proxy;

    const pcPort = await this._resolvePointsCheckinPort();
    this.proxy = new ProxyServer({
      localPort: this.proxyPort,
      targetPort: this.dshPort,
      authManager: this.authManager,
      logger: this.logger,
      tag: '局域网',
      extraTargets: pcPort ? [{ prefix: '/points-checkin', targetPort: pcPort, stripPrefix: true }] : [],
    });

    await this.proxy.start();
    return this.proxy;
  }

  async getStatus({ adminAuthValid = false } = {}) {
    const allInterfaces = listAllLanIPv4();
    const isSelectedValid = Boolean(this.selectedLanIp && allInterfaces.some(i => i.address === this.selectedLanIp));
    const lanIp = isSelectedValid ? this.selectedLanIp : selectLanIPv4();
    const token = adminAuthValid ? this.authManager?.secretToken : null;
    const isAuthEnabled = Boolean(this.authManager?.enabled && this.authManager?.mode !== 'password_only' && token);

    const isLanProtected = isAuthEnabled && this.authManager?.scope !== 'public_only';
    const isPublicProtected = isAuthEnabled && this.authManager?.scope !== 'lan_only';

    const appendToken = (url, shouldAppend) => {
      if (!url || !shouldAppend || !token) return url;
      try {
        const u = new URL(url);
        u.searchParams.set('auth', token);
        return u.toString();
      } catch {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}auth=${encodeURIComponent(token)}`;
      }
    };

    const baseLanUrl = lanIp ? `http://${lanIp}:${this.proxyPort}` : null;
    const lanUrl = appendToken(baseLanUrl, isLanProtected);

    const baseCloudflaredUrl = this.cloudflared?.url || null;
    const cloudflaredUrl = appendToken(baseCloudflaredUrl, isPublicProtected);

    const baseCustomUrl = this.customTunnel?.publicUrl || null;
    const customUrl = appendToken(baseCustomUrl, isPublicProtected);

    // Tailscale 入口地址：用户保存的优先（二维码只用它），否则回落到探测结果。
    // 探测快照由 refreshTailnet 定期刷新，此处只读，零进程开销。
    const savedTailscaleUrl = this.getTailscaleUrl();
    const detectedTailscaleUrl = this.tailnet?.available ? (this.tailnet.endpoint || '') : '';
    const baseTailscaleUrl = savedTailscaleUrl || detectedTailscaleUrl || null;
    const tailscaleUrl = appendToken(baseTailscaleUrl, isPublicProtected);

    return {
      version: VERSION,

      auth: this.authManager?.getStatus({ masked: !adminAuthValid }) ?? { enabled: false },

      proxy: {
        running: !!this.proxy,
        port: this.proxyPort,
        activeConnections: this.proxy?.activeConnections ?? 0,
      },

      lan: {
        ip: lanIp,
        selectedIp: this.selectedLanIp || '',
        interfaces: allInterfaces,
        url: lanUrl,
        rawUrl: baseLanUrl,
        qr: lanUrl ? await this.qrCache.get(lanUrl) : null,
      },

      cloudflared: {
        running: !!this.cloudflared,
        url: cloudflaredUrl,
        rawUrl: baseCloudflaredUrl,
        qr: cloudflaredUrl
          ? await this.qrCache.get(cloudflaredUrl)
          : null,
        state: this.cloudflaredState,
        tokenConfigured: !!this.cloudflaredConfig?.token,
        token: adminAuthValid ? (this.cloudflaredConfig?.token || '') : (this.cloudflaredConfig?.token ? '******' : ''),
        hostname: this.cloudflaredConfig?.hostname || '',
        autoStart: Boolean(this.cloudflaredConfig?.autoStart),
      },

      customTunnel: {
        configured: !!(this.customTunnelConfig?.serverUrl && this.customTunnelConfig?.accessToken),
        serverUrl: this.customTunnelConfig?.serverUrl ?? '',
        running: !!this.customTunnel?.connected,
        url: customUrl,
        rawUrl: baseCustomUrl,
        qr: customUrl
          ? await this.qrCache.get(customUrl)
          : null,
        state: this.customTunnelState,
        autoStart: Boolean(this.customTunnelConfig?.autoStart),
      },

      // Tailscale 隧道（Serve 发布本机反代端口；TLS 由 tailscale 提供）
      tailscale: {
        savedUrl: savedTailscaleUrl,
        detectedUrl: detectedTailscaleUrl,
        // 地址来自探测但未保存：UI 提示用户保存，避免 tailscale 离线后二维码失效
        unsaved: !savedTailscaleUrl && Boolean(detectedTailscaleUrl),
        running: Boolean(baseTailscaleUrl),
        online: Boolean(this.tailnet?.online),
        dnsName: this.tailnet?.dnsName ?? '',
        reason: this.tailnet?.reason ?? '',
        hint: this.tailnet?.hint ?? '',
        serveCommand: this.tailnet?.serveCommand ?? `tailscale serve --bg ${this.proxyPort}`,
        detected: Boolean(this.tailnet?.at),
        url: tailscaleUrl,
        rawUrl: baseTailscaleUrl,
        qr: tailscaleUrl
          ? await this.qrCache.get(tailscaleUrl)
          : null,
        autoStart: false, // Serve 由 tailscale 自身常驻，不随 DSH 启停
      },

      // 公网直连网关（0.0.0.0:port HTTPS + 强制登录门禁）
      gateway: this.gatewayStatus({ adminAuthValid }),

      // 轻量摘要，供 UI Tab 状态点使用（完整状态由 wechatGetStatus 提供）
      wechat: this.wechat ? { status: this.wechat.gateway?.status ?? 'idle' } : null,

      // 宿主系统运行监控指标
      system: this.getSystemMetrics(),
    };
  }

  async saveCloudflaredConfig({ token, hostname }) {
    this.cloudflaredConfig = {
      ...(this.cloudflaredConfig ?? {}),
      token: token ? String(token).trim() : '',
      hostname: hostname ? String(hostname).trim() : '',
    };
    await this.onPersist?.({ cloudflared: this.cloudflaredConfig });
  }

  async setTunnelAutoStart({ tunnel, autoStart }) {
    const isAuto = Boolean(autoStart);
    if (tunnel === 'cloudflared') {
      this.cloudflaredConfig = {
        ...(this.cloudflaredConfig ?? {}),
        autoStart: isAuto,
      };
      await this.onPersist?.({ cloudflared: this.cloudflaredConfig });
    } else if (tunnel === 'customTunnel' || tunnel === 'custom') {
      this.customTunnelConfig = {
        ...(this.customTunnelConfig ?? {}),
        autoStart: isAuto,
      };
      await this.onPersist?.({ customTunnel: this.customTunnelConfig });
    }
  }

  async startCustomTunnel({ autoStart = true } = {}) {
    if (this.customTunnel) {
      throw new Error('自建隧道已在运行');
    }

    const serverUrl = this.customTunnelConfig?.serverUrl;
    const accessToken = this.customTunnelConfig?.accessToken;

    if (!serverUrl || !accessToken) {
      throw new Error('缺少配置：请在控制台配置 customTunnel.serverUrl 和 customTunnel.accessToken');
    }

    this.customTunnelConfig = {
      ...(this.customTunnelConfig ?? {}),
      autoStart: Boolean(autoStart),
    };
    await this.onPersist?.({ customTunnel: this.customTunnelConfig });

    this.customTunnel = new CustomTunnelClient({
      serverUrl,
      accessToken,
      localPort: this.proxyPort,
      internalTunnelSecret: this.authManager?.internalTunnelSecret,
      onStateChange: (state) => {
        this.customTunnelState = state;
      },
      logger: this.logger,
    });

    await this.customTunnel.connect();
  }

  async stopCustomTunnel() {
    if (this.customTunnel) {
      this.customTunnel.disconnect();
      this.customTunnel = null;
      this.customTunnelState = { phase: 'idle', detail: '' };
    }
    this.customTunnelConfig = {
      ...(this.customTunnelConfig ?? {}),
      autoStart: false,
    };
    await this.onPersist?.({ customTunnel: this.customTunnelConfig });
  }

  async startCloudflared({ autoStart = true } = {}) {
    if (this.cloudflared) {
      throw new Error('Cloudflare 隧道已在运行');
    }

    this.cloudflaredConfig = {
      ...(this.cloudflaredConfig ?? {}),
      autoStart: Boolean(autoStart),
    };
    await this.onPersist?.({ cloudflared: this.cloudflaredConfig });

    this.cloudflaredState = { phase: 'connecting', detail: '正在初始化...' };
    this.cloudflared = new CloudflaredManager({
      port: this.proxyPort,
      home: this.home,
      token: this.cloudflaredConfig?.token,
      hostname: this.cloudflaredConfig?.hostname,
      onStateChange: (state) => {
        this.cloudflaredState = state;
        // 出错时自动清理，让用户可以重新开启
        if (state.phase === 'error') {
          this.cloudflared = null;
        }
      },
      logger: this.logger,
    });

    // 非阻塞启动，立即返回——下载/连接进度通过 onStateChange 推送
    this.cloudflared.start();
  }

  async stopCloudflared() {
    if (this.cloudflared) {
      this.cloudflared.stop();
      this.cloudflared = null;
      this.cloudflaredState = { phase: 'idle', detail: '' };
    }
    this.cloudflaredConfig = {
      ...(this.cloudflaredConfig ?? {}),
      autoStart: false,
    };
    await this.onPersist?.({ cloudflared: this.cloudflaredConfig });
  }

  // 重置 Cloudflare 隧道：关闭隧道 + 删除已下载的 cloudflared 二进制
  async resetCloudflared() {
    await this.stopCloudflared();
    const binDir = join(this.home ?? join(homedir(), '.dsh-bridge'), 'bin');
    const candidates = ['cloudflared.exe', 'cloudflared'];
    for (const name of candidates) {
      const p = join(binDir, name);
      try { await unlink(p); } catch {}
    }
    this.cloudflaredState = { phase: 'idle', detail: '' };
  }

  // ---- 公网直连网关（0.0.0.0:port 自带 HTTPS 自签证书 + 强制登录门禁）----

  getGatewayPort() {
    return Math.min(65535, Math.max(1024, Number(this.gatewayConfig?.port) || DEFAULT_GATEWAY_PORT));
  }

  async saveGatewayConfig({ port, autoStart } = {}) {
    const next = {
      ...(this.gatewayConfig ?? {}),
      port: this.getGatewayPortWith(port),
      autoStart: autoStart !== undefined ? Boolean(autoStart) : Boolean(this.gatewayConfig?.autoStart),
    };
    this.gatewayConfig = next;
    await this.onPersist?.({ gateway: this.gatewayConfig });
    return this.getStatus();
  }

  // ---- Tailscale 隧道（访问配置 Tab）----
  // Serve 把本机反代端口发布到 tailnet，自带 TLS，扫码即可访问 WebUI。
  // 地址来源有二：
  //   1. 用户手动保存（tailscale.url）—— 二维码只用它，所有权明确；
  //   2. 自动探测（tailscale serve status 反查）—— 兜底显示 + 可填入草稿。
  // 探测为只读：只查状态，绝不代用户执行 serve 改配置。

  /** 保存用户确认的 Tailscale 入口地址（自动探测后填入或手动编辑）。 */
  async saveTailscaleUrl({ url } = {}) {
    const value = typeof url === 'string' ? url.trim() : '';
    if (value) {
      if (value.length > 2048) throw new Error('地址过长（最多 2048 字符）');
      if (!/^https?:\/\//.test(value)) throw new Error(`地址必须以 http:// 或 https:// 开头: ${value}`);
      if (value.includes('?') || value.includes('#')) throw new Error('地址不能包含查询参数或片段');
    }
    this.tailscaleConfig = { ...(this.tailscaleConfig ?? {}), url: value };
    await this.onPersist?.({ tailscale: this.tailscaleConfig });
    return { url: value };
  }

  getTailscaleUrl() {
    const value = this.tailscaleConfig?.url;
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  /**
   * 探测本机 Tailscale Serve 入口地址（只读）。
   * 前提：本机已运行 tailscaled 且已执行 `tailscale serve --bg <反代端口>`。
   * 探测步骤：
   *   1. `tailscale status --json` 取 Self.DNSName（剥尾部根点）—— 不可用即返回 null；
   *   2. `tailscale serve status --json` 的 Web 表中找 Proxy 指向本机反代端口的 host；
   *      找到 → https://<host>（serve 自带 TLS，标准 443 无需端口）；
   *   3. 找不到 serve 规则 → 返回 { dnsName, hint } 引导用户执行 serve 命令。
   */
  async probeTailnet() {
    const lanPort = this.proxyPort; // serve 应指向基底反代端口
    const runTailscale = async (args) => {
      const { execFile } = await import('node:child_process');
      return new Promise((resolve) => {
        execFile('tailscale', args, { timeout: 5000 }, (err, stdout) => {
          if (err) resolve(null);
          else {
            try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
          }
        });
      });
    };

    const status = await runTailscale(['status', '--json']);
    if (!status?.Self?.DNSName) {
      return { available: false, online: false, dnsName: '', endpoint: '', reason: 'tailscale 未安装、未运行或未登录', hint: '' };
    }
    const dnsName = String(status.Self.DNSName).replace(/\.$/, '');
    if (!status.Self?.Online) {
      return { available: false, online: false, dnsName, endpoint: '', reason: 'tailscale 已登录但当前离线', hint: '' };
    }

    const serveStatus = await runTailscale(['serve', 'status', '--json']);
    const web = serveStatus?.Web ?? {};
    let serveHost = null;
    for (const [hostPort, cfg] of Object.entries(web)) {
      const proxy = String(cfg?.Handlers?.['/']?.Proxy ?? '');
      const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(proxy);
      if (m && Number(m[1]) === Number(lanPort)) {
        const port = hostPort.split(':').pop();
        serveHost = port === '443' ? hostPort.replace(/:443$/, '') : hostPort; // 443 隐含
        break;
      }
    }

    if (!serveHost) {
      return {
        available: false,
        online: true,
        dnsName,
        endpoint: '',
        reason: '',
        hint: `已登录（${dnsName}），尚未把本机端口转发出去。请在终端执行：tailscale serve --bg ${lanPort}`,
        serveCommand: `tailscale serve --bg ${lanPort}`,
      };
    }
    return {
      available: true,
      online: true,
      dnsName,
      endpoint: `https://${serveHost}`,
      reason: '',
      hint: '',
      serveCommand: `tailscale serve --bg ${lanPort}`,
    };
  }

  /**
   * 带 TTL 的探测缓存：getStatus() 被面板每 3s 轮询，绝不能在里面起进程。
   * 后台定时刷新；用户显式点击时 force 立即刷新。
   */
  async refreshTailnet({ force = false } = {}) {
    if (!force && this.tailnet && Date.now() - this.tailnet.at < TAILNET_TTL_MS) return this.tailnet;
    const probe = await this.probeTailnet().catch((err) => ({
      available: false, online: false, dnsName: '', endpoint: '', reason: err?.message ?? String(err), hint: '',
    }));
    this.tailnet = { ...probe, at: Date.now() };
    return this.tailnet;
  }

  /** 用户点击「自动探测并填入」：强制刷新缓存后返回结果。 */
  async detectTailnetEndpoint() {
    const snapshot = await this.refreshTailnet({ force: true });
    return {
      available: snapshot.available,
      online: snapshot.online,
      dnsName: snapshot.dnsName,
      endpoint: snapshot.endpoint,
      reason: snapshot.reason,
      hint: snapshot.hint,
      serveCommand: snapshot.serveCommand ?? '',
    };
  }

  getGatewayPortWith(port) {
    const p = port === undefined ? null : Number(port);
    if (p === null || !Number.isFinite(p)) return this.getGatewayPort();
    return Math.min(65535, Math.max(1024, Math.round(p)));
  }

  async setGatewayAutoStart({ autoStart } = {}) {
    this.gatewayConfig = {
      ...(this.gatewayConfig ?? {}),
      autoStart: Boolean(autoStart),
    };
    await this.onPersist?.({ gateway: this.gatewayConfig });
    return this.getStatus();
  }

  // 刷新网关认证：把宿主最新访问密码/Secure Token 同步到网关，但强制 enabled=true + scope=all
  _refreshGatewayAuth() {
    if (!this.gatewayAuth) {
      this.gatewayAuth = new AuthManager({
        config: {
          enabled: true,
          mode: this.authManager?.mode || 'token_and_password',
          scope: 'all',
          adminPolicy: this.authManager?.adminPolicy || 'password_unlock',
          allowLoopback: true,
        },
        logger: this.logger,
      });
    }
    const g = this.gatewayAuth;
    g.enabled = true;
    g.scope = 'all';
    g.allowLoopback = true;
    g.mode = this.authManager?.mode || g.mode;
    g.adminPolicy = this.authManager?.adminPolicy || g.adminPolicy;
    g.passwordHash = this.authManager?.passwordHash || '';
    g.passwordSalt = this.authManager?.passwordSalt || '';
    g.adminPasswordHash = this.authManager?.adminPasswordHash || '';
    g.adminPasswordSalt = this.authManager?.adminPasswordSalt || '';
    if (this.authManager?.secretToken) g.secretToken = this.authManager.secretToken;
    return g;
  }

  async startGateway() {
    if (this.gateway) return this.gateway;

    const port = this.getGatewayPort();
    this.gatewayConfig = { ...(this.gatewayConfig ?? {}), port };
    await this.onPersist?.({ gateway: this.gatewayConfig });

    const certDir = certDirFor(port);
    const certFile = join(certDir, 'cert.pem');
    const keyFile = join(certDir, 'key.pem');

    let tls;
    try {
      tls = await getOrCreateSelfSignedCert({ certFile, keyFile, logger: this.logger });
    } catch (err) {
      throw new Error(`无法生成 HTTPS 自签证书: ${err?.message ?? err}`);
    }

    const gatewayAuth = this._refreshGatewayAuth();
    const pcPort = await this._resolvePointsCheckinPort();
    this.gateway = new ProxyServer({
      localPort: port,
      targetPort: this.dshPort,
      authManager: gatewayAuth,
      logger: this.logger,
      tls: { key: tls.key, cert: tls.cert },
      tag: '公网直连',
      extraTargets: pcPort ? [{ prefix: '/points-checkin', targetPort: pcPort, stripPrefix: true }] : [],
    });

    await this.gateway.start();
    this.logger?.info?.('dsh-bridge: 公网直连网关已启用 0.0.0.0:%d (HTTPS + 强制登录门禁)', port);
    return this.gateway;
  }

  async stopGateway() {
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    this.gatewayConfig = { ...(this.gatewayConfig ?? {}), autoStart: false };
    await this.onPersist?.({ gateway: this.gatewayConfig });
  }

  gatewayStatus({ adminAuthValid = false } = {}) {
    const port = this.getGatewayPort();
    return {
      configured: Boolean(this.gatewayConfig),
      port,
      running: Boolean(this.gateway),
      autoStart: Boolean(this.gatewayConfig?.autoStart),
      forcedLogin: true,
      havePassword: Boolean(this.authManager?.hasPassword),
      // 直连网关地址取决于宿主机公网 IP/域名，本机仅能给出端口说明；启动后根据实际可达地址访问
      url: this.gateway ? `https://<公网IP或域名>${port === 443 ? '' : `:${port}`}` : null,
      // 当前外网长连接台账：总条数 + 按来源 IP 聚合明细（来源 IP 仅管理员可见）
      wsConnections: this.gateway?.wsSockets?.size ?? 0,
      clients: adminAuthValid ? (this.gateway?.connectionSummary() ?? []) : [],
      // 持久黑名单（仅管理员可见）
      blacklist: adminAuthValid ? (this.authManager?.blacklistList() ?? []) : [],
    };
  }

  /**
   * 远程连接监控数据（访客管理 Tab 的「远程连接」卡）。
   * 聚合三条通道的实时连接：局域网代理 / 直连网关 / 隧道（隧道流量最终也走
   * 代理或网关入口，故以前两者台账为准）。含隧道转发的真实来源 IP。
   *
   * 权限口径：**查看对所有已通过访问门禁的访客开放**——「谁正连着本机」是
   * 只读事实，不是管理凭据；把它锁在管理员后面会让普通访客无法自查连接。
   * 写操作（断开 / 拉黑）是另一回事：由 RPC 层的 checkAdminAuth 单独把关，
   * 这里只用 canManage 回报管理员身份，供 UI 决定是否渲染按钮。
   */
  async getConnections({ adminAuthValid = false } = {}) {
    const summarize = (proxy) => {
      if (!proxy) return [];
      return (proxy.connectionSummary?.() ?? []).map((c) => ({ ...c, source: proxy.tag ? proxy.tag.trim() : 'gateway' }));
    };
    const connections = [
      ...summarize(this.gateway),
      ...summarize(this.proxy),
    ];
    // 去重：同一 IP 同时出现在多条通道时合并计数
    const merged = new Map();
    for (const c of connections) {
      const item = merged.get(c.ip) ?? { ip: c.ip, count: 0, via: c.via, oldestSec: 0, paths: [], sources: [] };
      item.count += c.count;
      item.oldestSec = Math.max(item.oldestSec, c.oldestSec);
      if (!item.sources.includes(c.source)) item.sources.push(c.source);
      for (const p of c.paths ?? []) if (!item.paths.includes(p)) item.paths.push(p);
      merged.set(c.ip, item);
    }
    return {
      allowed: true,
      // canManage：管理员身份（决定 UI 是否显示断开/拉黑等写操作入口）。
      // 与 allowed 分离：查看始终允许，管理能力才需要 adminToken。
      canManage: Boolean(adminAuthValid),
      connections: [...merged.values()].sort((a, b) => b.count - a.count),
      blacklist: this.authManager?.blacklistList() ?? [],
    };
  }

  /** 踢除 + 可选拉黑（blacklist=true 时同时写入持久黑名单） */
  async kickIp({ ip, blacklist = false } = {}) {
    const target = String(ip ?? '').trim();
    if (!target) throw new Error('ip is required');
    const kicked = this.gateway?.kickByIp(target)?.kicked ?? 0;
    const viaProxy = this.proxy?.kickByIp(target)?.kicked ?? 0;
    let blacklisted = false;
    if (blacklist) blacklisted = await this.authManager?.blacklistAdd(target);
    appendGatewayAccessLog({ ev: 'admin-kick', ip: target, kicked: kicked + viaProxy, blacklisted });
    return { kicked: kicked + viaProxy, blacklisted };
  }

  async setBlacklist({ ip, action } = {}) {
    const target = String(ip ?? '').trim();
    if (!target) throw new Error('ip is required');
    if (action === 'add') await this.authManager?.blacklistAdd(target);
    else if (action === 'remove') await this.authManager?.blacklistRemove(target);
    else throw new Error("action must be 'add' or 'remove'");
    return { blacklist: this.authManager.blacklistList() };
  }

  async checkVersion() {
    const fetchRegistry = (url, timeoutMs = 4000) => new Promise((resolve, reject) => {
      const req = httpsGet(url, { timeout: timeoutMs, headers: { 'User-Agent': 'dsh-bridge-gateway' } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              version: data.version ?? null,
              releaseNotes: data.releaseNotes ?? data.description ?? null,
            });
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });

    try {
      const latestData = await fetchRegistry('https://registry.npmmirror.com/dsh-bridge-gateway/latest', 3500)
        .catch(() => fetchRegistry('https://registry.npmjs.org/dsh-bridge-gateway/latest', 5000));
      return {
        current: VERSION,
        latest: latestData?.version ?? null,
        releaseNotes: latestData?.releaseNotes ?? null,
      };
    } catch (e) {
      return { current: VERSION, latest: null, error: e.message ?? '检查失败' };
    }
  }

  // 一键直接升级插件（执行 dsh / npx / npm 自动升级，使用安全的参数数组彻底杜绝 shell 注入）
  async upgradePlugin({ version } = {}) {
    const targetVersion = version ? String(version).trim() : 'latest';
    // 严格 SemVer 白名单正则校验
    if (!/^(latest|\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?)$/.test(targetVersion)) {
      return { ok: false, error: `非法的版本号格式: ${targetVersion}`, version: targetVersion };
    }
    const pkgSpec = `dsh-bridge-gateway@${targetVersion}`;
    const isWin = process.platform === 'win32';

    // 自动构建包含 Homebrew / NVM / Node 兄弟目录的全量 PATH 环境变量
    const nodeDir = dirname(process.execPath);
    const home = homedir();
    const extraPaths = isWin ? [
      nodeDir,
    ] : [
      nodeDir,
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      join(home, '.nvm/current/bin'),
      join(home, '.fnm/current/bin'),
      join(home, '.local/bin'),
      join(home, '.cargo/bin'),
    ];

    const separator = isWin ? ';' : ':';
    const existingPath = process.env.PATH || process.env.Path || '';
    const augmentedEnv = {
      ...process.env,
      PATH: [...extraPaths, existingPath].filter(Boolean).join(separator),
    };
    if (isWin) augmentedEnv.Path = augmentedEnv.PATH;

    // 寻找与当前 node 配对的 npm/npx 绝对路径
    const siblingNpm = join(nodeDir, isWin ? 'npm.cmd' : 'npm');
    const siblingNpx = join(nodeDir, isWin ? 'npx.cmd' : 'npx');

    const tasks = [
      { cmd: 'dsh', args: ['plugin', '--profile', 'web', 'add', pkgSpec] },
      { cmd: existsSync(siblingNpx) ? siblingNpx : 'npx', args: ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', pkgSpec] },
      { cmd: existsSync(siblingNpm) ? siblingNpm : 'npm', args: ['install', pkgSpec] },
    ];

    let lastError = null;

    for (const task of tasks) {
      try {
        const res = await new Promise((resolve, reject) => {
          let cp;
          try {
            cp = spawn(task.cmd, task.args, {
              windowsHide: true,
              shell: true,
              env: augmentedEnv,
              timeout: 120000,
            });
          } catch (spawnErr) {
            return reject(spawnErr);
          }
          let stdout = '';
          let stderr = '';
          cp.stdout?.on('data', (d) => { stdout += d.toString(); });
          cp.stderr?.on('data', (d) => { stderr += d.toString(); });
          cp.on('error', (err) => {
            reject(err);
          });
          cp.on('close', (code) => {
            if (code === 0) {
              resolve({ stdout, stderr });
            } else {
              reject(new Error(stderr || stdout || `进程退出码 ${code}`));
            }
          });
        });

        const output = res.stdout || res.stderr || '升级成功';
        return { ok: true, command: `${task.cmd} ${task.args.join(' ')}`, output, version: targetVersion };
      } catch (err) {
        lastError = err;
      }
    }

    return { ok: false, error: lastError?.message ?? '升级命令执行失败', version: targetVersion };
  }

  // 优雅重启 DSH 服务（支持守护进程自动拉起或独立派生子进程重启）
  async restartDsh() {
    this.logger?.info('收到 DSH 重启请求，正在调度重启...');
    setTimeout(() => {
      try {
        if (process.env.DSH_DAEMON || process.env.PM2_HOME) {
          process.exit(0);
        } else {
          // 常规 Node/CLI 模式：派生与当前参数一致的独立后台子进程并退出当前进程
          const child = spawn(process.execPath, process.argv.slice(1), {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          child.unref();
          process.exit(0);
        }
      } catch (err) {
        this.logger?.error('派生重启进程失败: %s，执行直接退出', err.message);
        process.exit(0);
      }
    }, 600);

    return { ok: true, message: 'DSH 服务正在重启中，前端将在几秒后自动重新连接…' };
  }

  getSystemMetrics() {
    try {
      const totalMem = totalmem();
      const freeMem = freemem();
      const usedMem = totalMem - freeMem;
      const memUsage = process.memoryUsage();
      const cpusList = cpus() || [];
      const cpuCount = cpusList.length;
      const cpuModel = cpusList[0]?.model || 'Generic CPU';

      return {
        os: {
          platform: platform(),
          arch: arch(),
          release: release(),
          hostname: hostname(),
          nodeVersion: process.version,
        },
        uptime: {
          processSec: Math.floor(process.uptime()),
          systemSec: Math.floor(uptime()),
        },
        cpu: {
          model: cpuModel,
          cores: cpuCount,
          loadAvg: typeof loadavg === 'function' ? loadavg() : [0, 0, 0],
        },
        memory: {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedBytes: usedMem,
          usedPercent: Math.round((usedMem / totalMem) * 100),
          processHeapUsed: memUsage.heapUsed,
          processRss: memUsage.rss,
        },
      };
    } catch {
      return null;
    }
  }

  // 获取当前所有已注册的工作区
  async getWorkspaces() {
    try {
      const list = await this.ctx?.workspaceRegistry?.list?.() ?? [];
      const out = [];
      for (const ws of list) {
        if (ws && ws.path) {
          out.push({
            id: ws.id,
            title: ws.title ?? basename(ws.path),
            path: ws.path,
          });
        }
      }
      return out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    } catch {
      return [];
    }
  }

  // 远程添加工作区目录到 DSH 体系
  async addWorkspace(workspacePath) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { ok: false, error: '缺少工作区目录路径' };
    }
    const safetyCheck = await isSafeWorkspacePath(workspacePath);
    if (!safetyCheck.valid) {
      return { ok: false, error: safetyCheck.error || '路径安全校验未通过' };
    }
    const resolved = safetyCheck.path;

    const title = basename(resolved) || resolved;
    let added = false;
    let workspaceId = null;

    if (this.ctx?.workspaceRegistry) {
      if (typeof this.ctx.workspaceRegistry.create === 'function') {
        try {
          const entity = await this.ctx.workspaceRegistry.create(resolved, title);
          added = true;
          workspaceId = entity?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('workspaceRegistry.create 失败: %s', e.message);
        }
      } else if (typeof this.ctx.workspaceRegistry.add === 'function') {
        try {
          const res = await this.ctx.workspaceRegistry.add({ path: resolved, title });
          added = true;
          workspaceId = res?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('workspaceRegistry.add 失败: %s', e.message);
        }
      } else if (typeof this.ctx.workspaceRegistry.register === 'function') {
        try {
          const res = await this.ctx.workspaceRegistry.register({ path: resolved, title });
          added = true;
          workspaceId = res?.id ?? null;
        } catch (e) {
          this.logger?.warn?.('workspaceRegistry.register 失败: %s', e.message);
        }
      }
    }

    const list = await this.getWorkspaces();
    if (!workspaceId) {
      const match = list.find(w => w.path === resolved || (w.path && w.path.toLowerCase() === resolved.toLowerCase()));
      if (match) workspaceId = match.id;
    }

    let sessionId = null;
    if (this.ctx?.sessions && typeof this.ctx.sessions.create === 'function') {
      try {
        const session = this.ctx.sessions.create(undefined, { meta: { cwd: resolved } });
        if (session?.id) {
          sessionId = session.id;
          if (workspaceId && this.ctx?.workspaceRegistry?.get) {
            const entity = this.ctx.workspaceRegistry.get(workspaceId);
            if (entity && typeof entity.attachSession === 'function') {
              await entity.attachSession(session.id).catch(() => {});
            }
          }
        }
      } catch (e) {
        this.logger?.debug?.('sessions.create 初始化 session 提示: %s', e.message);
      }
    }

    return {
      ok: true,
      path: resolved,
      title,
      workspaceId,
      sessionId,
      workspaces: list,
      registered: added
    };
  }

  // 远程目录列表浏览与常用路径推荐
  async listRemoteDirectories(targetPath) {
    const isWin = process.platform === 'win32';
    const home = homedir();

    // 1. 获取快速访问常用根目录
    const roots = [
      { name: '🏠 用户主目录', path: home },
    ];
    const commonSubdirs = [
      { name: '💻 桌面', sub: 'Desktop' },
      { name: '📁 文档', sub: 'Documents' },
      { name: '📥 下载', sub: 'Downloads' },
      { name: '💡 IdeaProjects', sub: 'IdeaProjects' },
      { name: '🔨 Projects', sub: 'Projects' },
      { name: '📦 workspace', sub: 'workspace' },
      { name: '💻 code', sub: 'code' },
      { name: '💻 src', sub: 'src' },
    ];
    for (const item of commonSubdirs) {
      const fullPath = join(home, item.sub);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          roots.push({ name: item.name, path: fullPath });
        }
      } catch {}
    }

    // 2. Windows 盘符探测
    const drives = [];
    if (isWin) {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      for (const letter of letters) {
        const driveRoot = `${letter}:\\`;
        try {
          await access(driveRoot);
          drives.push({ name: `${letter}: 盘`, path: driveRoot });
        } catch {}
      }
      if (drives.length === 0) drives.push({ name: 'C: 盘', path: 'C:\\' });
    } else {
      drives.push({ name: '根目录 /', path: '/' });
    }

    // 3. 解析当前请求路径并进行安全校验
    let rawTarget = targetPath && typeof targetPath === 'string' ? targetPath.trim() : '';
    if (isWin && /^[A-Za-z]:$/.test(rawTarget)) {
      rawTarget = `${rawTarget}\\`;
    }
    let candidatePath = rawTarget ? resolve(rawTarget) : home;
    
    // 安全校验：遇非法或黑名单目录时安全回退至用户主目录
    let currentPath = home;
    const pathCheck = await isSafeWorkspacePath(candidatePath);
    if (pathCheck.valid && pathCheck.path) {
      currentPath = pathCheck.path;
    }

    // 4. 读取子文件夹列表（过滤敏感目录与不安全软链接）
    const entries = [];
    let readError = null;
    try {
      const dirents = await readdir(currentPath, { withFileTypes: true });
      for (const d of dirents) {
        if (isSensitiveFolderName(d.name)) continue;

        let isDir = d.isDirectory();
        const targetEntryPath = join(currentPath, d.name);

        // 如果是符号链接，安全探测其真实目标
        if (d.isSymbolicLink()) {
          try {
            const symCheck = await isSafeWorkspacePath(targetEntryPath);
            if (!symCheck.valid) continue;
            isDir = true;
          } catch {
            continue;
          }
        }

        if (isDir) {
          entries.push({
            name: d.name,
            path: targetEntryPath,
            isDirectory: true,
          });
        }
      }
    } catch (err) {
      readError = err.message;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parentPath = dirname(currentPath) !== currentPath ? dirname(currentPath) : null;

    // 5. 生成结构化面包屑导航路径
    const breadcrumbs = [];
    if (isWin) {
      const match = currentPath.match(/^([A-Za-z]:)(?:\\(.*))?$/);
      if (match) {
        const driveLetter = match[1];
        const rest = match[2] || '';
        breadcrumbs.push({ name: `${driveLetter}`, path: `${driveLetter}\\` });
        if (rest) {
          const parts = rest.split('\\').filter(Boolean);
          let curr = `${driveLetter}\\`;
          for (const p of parts) {
            curr = join(curr, p);
            breadcrumbs.push({ name: p, path: curr });
          }
        }
      } else {
        breadcrumbs.push({ name: currentPath, path: currentPath });
      }
    } else {
      breadcrumbs.push({ name: '根目录 /', path: '/' });
      const parts = currentPath.split('/').filter(Boolean);
      let curr = '/';
      for (const p of parts) {
        curr = join(curr, p);
        breadcrumbs.push({ name: p, path: curr });
      }
    }

    // 6. 获取当前已注册的工作区作为快捷参考
    const currentWorkspaces = await this.getWorkspaces();

    return {
      ok: !readError,
      error: readError ? `读取文件夹失败: ${readError}` : undefined,
      currentPath,
      parentPath,
      breadcrumbs,
      entries: entries.slice(0, 150),
      totalEntries: entries.length,
      roots,
      drives,
      workspaces: currentWorkspaces,
    };
  }

  async diagnoseNetwork() {
    const results = [];

    // 1. 本地代理端口检测
    results.push({
      item: 'local_proxy',
      name: `本地反向代理端口 (${this.proxyPort})`,
      status: this.proxy ? 'pass' : 'fail',
      detail: this.proxy ? `正常运行中 (代理目标端口: ${this.dshPort})` : '代理未启动',
    });

    // 2. 局域网网卡检测
    const lanIp = selectLanIPv4();
    results.push({
      item: 'lan_interface',
      name: '局域网 IP 分配与可用性',
      status: lanIp ? 'pass' : 'warn',
      detail: lanIp ? `检测到有效局域网 IPv4: ${lanIp}` : '未检测到活跃局域网 IPv4 地址 (可能未连接 Wi-Fi/以太网)',
    });

    // 3. Cloudflare 边缘连通性测试
    const cfStart = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const req = httpsGet('https://1.1.1.1', { timeout: 3500 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('连接超时 (3.5s)')); });
      });
      const cfLatency = Date.now() - cfStart;
      results.push({
        item: 'cloudflare_edge',
        name: 'Cloudflare Anycast 边缘网络',
        status: 'pass',
        latencyMs: cfLatency,
        detail: `连接畅通 (延迟 ${cfLatency}ms)`,
      });
    } catch (err) {
      results.push({
        item: 'cloudflare_edge',
        name: 'Cloudflare Anycast 边缘网络',
        status: 'warn',
        detail: `连接异常: ${err.message} (临时公网隧道可能受阻)`,
      });
    }

    // 4. 国内 npm 高速镜像源 (npmmirror)
    const npmStart = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const req = httpsGet('https://registry.npmmirror.com', { timeout: 3500 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('连接超时 (3.5s)')); });
      });
      const npmLatency = Date.now() - npmStart;
      results.push({
        item: 'npmmirror',
        name: '国内 npm 高速镜像源 (npmmirror)',
        status: 'pass',
        latencyMs: npmLatency,
        detail: `连接畅通 (延迟 ${npmLatency}ms)`,
      });
    } catch (err) {
      results.push({
        item: 'npmmirror',
        name: '国内 npm 高速镜像源 (npmmirror)',
        status: 'warn',
        detail: `连接超时或异常: ${err.message}`,
      });
    }

    // 5. 自建隧道部署服务器连通性检测
    const customServerUrl = this.customTunnelConfig?.serverUrl?.trim();
    if (customServerUrl) {
      const isRunning = Boolean(this.customTunnelClient?.running);
      const ctStart = Date.now();
      try {
        const parsedUrl = new URL(customServerUrl);
        const isSecure = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:';
        const getter = isSecure ? httpsGet : httpGet;
        const probeUrl = new URL(customServerUrl);
        probeUrl.protocol = isSecure ? 'https:' : 'http:';

        await new Promise((resolve, reject) => {
          const req = getter(probeUrl.toString(), { timeout: 4000 }, (res) => {
            res.resume();
            resolve();
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('连接超时 (4.0s)')); });
        });
        const ctLatency = Date.now() - ctStart;
        results.push({
          item: 'custom_tunnel_server',
          name: `自建隧道部署服务器 (${parsedUrl.hostname}${parsedUrl.port ? `:${parsedUrl.port}` : ''})`,
          status: 'pass',
          latencyMs: ctLatency,
          detail: `服务器连通良好 (延迟 ${ctLatency}ms · 状态: ${isRunning ? '客户端在线运行中' : '待连接/就绪'})`,
        });
      } catch (err) {
        if (isRunning) {
          results.push({
            item: 'custom_tunnel_server',
            name: `自建隧道部署服务器 (${customServerUrl})`,
            status: 'pass',
            detail: '客户端在线运行中 (WebSocket 通道已建立)',
          });
        } else {
          results.push({
            item: 'custom_tunnel_server',
            name: `自建隧道部署服务器 (${customServerUrl})`,
            status: 'warn',
            detail: `无法连通自建服务器: ${err.message}`,
          });
        }
      }
    } else {
      results.push({
        item: 'custom_tunnel_server',
        name: '自建隧道部署服务器',
        status: 'pass',
        detail: '未配置自建服务器（若已部署自建隧道可在「公网隧道」中配置）',
      });
    }

    const allPassed = results.every(r => r.status === 'pass');
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      overall: allPassed ? 'healthy' : 'warning',
      results,
    };
  }

  async dispose() {
    this.stopCustomTunnel();
    this.stopCloudflared();
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    if (this.gatewayAuth) {
      try { this.gatewayAuth.dispose(); } catch {}
      this.gatewayAuth = null;
    }
    this.qrCache.clear();
  }
}

/**
 * 插件入口
 */
function apply(ctx, config = {}) {
  const logger = ctx.logger(name);
  const dshPort = ctx.webServer?.port ?? config.targetPort ?? 3080;

  if (!dshPort) {
    logger.error('webServer port unavailable');
    return;
  }

  // 通过 DSH 官方 webserver/index-inject 机制向 index.html 贡献 PWA 相关的
  // meta/link/polyfill 行，替代此前「反向代理层截取 HTML 字符串替换」的做法：
  // 由宿主统一渲染与转义，直连与代理两条路径看到的页面一致，升级不失效。
  ctx.on('webserver/index-inject', (table) => {
    table.push(
      {
        kind: 'html',
        placement: 'head',
        html: [
          '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">',
          '<meta name="apple-mobile-web-app-capable" content="yes">',
          '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
          '<meta name="apple-mobile-web-app-title" content="DSH">',
          '<meta name="theme-color" content="#1e1e2e">',
          '<link rel="manifest" href="/manifest.webmanifest">',
          '<link rel="icon" type="image/svg+xml" href="/__dsh_bridge__/pwa-icon.svg">',
          '<link rel="apple-touch-icon" href="/__dsh_bridge__/pwa-icon.svg">',
        ].join(''),
      },
      {
        kind: 'script',
        placement: 'head',
        text:
          "!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=\"\";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?\"0\":\"\")+x;if(i===3||i===5||i===7||i===9)h+=\"-\";}return h;}}}catch(e){}}();",
      },
    );
  });

  // 挂载 browse 目录选择器（host 后端 + 浏览器 UI 面成对）。
  // 与 dsh-host-directory-picker-auto 的 apply 同构：effect 的 disposer 逆序移除
  // 两个 Loader 条目，卸载时两面一起退场，不留半个交互。
  // 仅在 loader 可用时执行；缺 loader（如非 web 组合）时安全跳过，不影响其余功能。
  if (ctx.loader?.create) {
    ctx.effect(async () => {
      const ids = [];
      const unmount = async () => {
        for (const id of [...ids].reverse()) {
          if (ctx.loader.store?.[id] === undefined) continue;
          try {
            await ctx.loader.remove(id);
          } catch (err) {
            logger.warn('dsh-bridge: unmount %s failed: %s', id, err?.message ?? err);
          }
        }
      };
      try {
        logger.info('dsh-bridge: mounting directory picker (browse backend + web surface)');
        for (const name of [DIRECTORY_PICKER_BACKEND, DIRECTORY_PICKER_SURFACE]) {
          ids.push(await ctx.loader.create({ name }));
        }
      } catch (err) {
        logger.error('dsh-bridge: directory picker mount failed: %s', err?.message ?? err);
        await unmount();
        return () => {};
      }
      return unmount;
    }, 'dsh-bridge: directory picker (browse backend + surface)');
  } else {
    logger.warn('dsh-bridge: loader unavailable, directory picker left to DSH native composition');
  }

  const proxyPort = config.port ?? 3082;
  // 启动时迁移两处旧路径到新名（均幂等、失败不阻断启动）：
  //   1. 数据目录      dsh-bridge/        → dsh-bridge-gateway/
  //      必须在读取 config 之前完成，否则会读到"空的"新目录而丢失用户配置。
  //   2. cloudflared 缓存 .dsh-bridge/    → .dsh-bridge-cloudflared/
  //      只是可重下的外部依赖，迁移失败按需重下即可。
  migrateLegacyDataDir({ logger });
  migrateLegacyCloudflaredDir({ logger });
  const configFile = configFilePath();
  const emergencyResetFile = resetAuthPath();

  // 配置写入互斥锁队列，杜绝多平台并发写入造成文件覆盖损坏
  let configWriteQueue = Promise.resolve();

  // 从 JSON 文件读取持久化配置
  async function loadConfig() {
    try {
      const raw = await readFile(configFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // 持久化配置到 JSON 文件（排队原子写入）
  async function saveConfig(data) {
    configWriteQueue = configWriteQueue.then(async () => {
      await mkdir(dataDir(), { recursive: true });
      await writeFile(configFile, JSON.stringify(data, null, 2), 'utf8');
    }).catch((err) => {
      logger.error('saveConfig failed: %s', err.message);
    });
    return configWriteQueue;
  }

  // 访问安全认证管理器
  const authManager = new AuthManager({
    config: config.auth ?? {},
    logger,
    onPersist: async (patch) => {
      const stored = await loadConfig();
      stored.auth = { ...(stored.auth ?? {}), ...patch };
      await saveConfig(stored);
    },
  });

  // 保命救急检查：检测到 reset-auth 文件时自动重置全量密码与安全策略
  async function checkEmergencyReset() {
    try {
      await unlink(emergencyResetFile);
      authManager.enabled = false;
      authManager.passwordHash = '';
      authManager.passwordSalt = '';
      authManager.adminPasswordHash = '';
      authManager.adminPasswordSalt = '';
      authManager.adminPolicy = 'password_unlock';
      authManager.mode = 'token_and_password';
      authManager.sessions.clear();
      authManager.adminSessions.clear();
      const stored = await loadConfig();
      delete stored.auth;
      await saveConfig(stored);
      logger.warn('dsh-bridge: [保命救急] 检测到 reset-auth 标记文件，已成功重置所有访问密码与安全策略！');
    } catch {}
  }

  // 启动时读取已保存的 auth 配置并执行保命标记检查
  checkEmergencyReset().then(() => loadConfig()).then((stored) => {
    if (stored?.auth) {
      if (stored.auth.enabled != null) authManager.enabled = Boolean(stored.auth.enabled);
      if (stored.auth.mode) authManager.mode = stored.auth.mode;
      if (stored.auth.scope) authManager.scope = stored.auth.scope;
      if (stored.auth.adminPolicy) authManager.adminPolicy = stored.auth.adminPolicy;
      if (stored.auth.passwordHash) authManager.passwordHash = stored.auth.passwordHash;
      if (stored.auth.passwordSalt) authManager.passwordSalt = stored.auth.passwordSalt;
      if (stored.auth.adminPasswordHash) authManager.adminPasswordHash = stored.auth.adminPasswordHash;
      if (stored.auth.adminPasswordSalt) authManager.adminPasswordSalt = stored.auth.adminPasswordSalt;
      if (stored.auth.secretToken) authManager.secretToken = stored.auth.secretToken;
      if (stored.auth.allowLoopback != null) authManager.allowLoopback = Boolean(stored.auth.allowLoopback);
      logger.info('dsh-bridge: loaded saved auth config (enabled=%s, mode=%s, adminPolicy=%s)', authManager.enabled, authManager.mode, authManager.adminPolicy);
    }
  }).catch(() => {});

  const service = new BridgeService({
    dshPort,
    proxyPort,
    home: config.home,
    customTunnelConfig: config.customTunnel ?? null,
    cloudflaredConfig: config.cloudflared ?? null,
    tailscaleConfig: config.tailscale ?? null,
    lanConfig: config.lan ?? null,
    gatewayConfig: config.gateway ?? null,
    authManager,
    onPersist: async (patch) => {
      const stored = await loadConfig();
      Object.assign(stored, patch);
      await saveConfig(stored);
    },
    logger,
  });

  // 启动时读取已保存的局域网网卡配置与公网隧道配置并按需自动拉起
  loadConfig().then(async (stored) => {
    if (stored?.lan?.selectedIp) {
      service.selectedLanIp = stored.lan.selectedIp;
      logger.info('dsh-bridge: loaded saved lan config (selectedIp=%s)', service.selectedLanIp);
    }
    if (stored?.gateway) {
      service.gatewayConfig = stored.gateway;
      logger.info('dsh-bridge: loaded saved gateway config (port=%s, autoStart=%s)', service.gatewayConfig.port ?? 7443, Boolean(service.gatewayConfig.autoStart));
      if (service.gatewayConfig.autoStart) {
        logger.info('dsh-bridge: auto-starting public direct gateway...');
        service.startGateway().catch((err) => {
          logger.error('dsh-bridge: gateway auto-start failed: %s', err?.message ?? err);
        });
      }
    }
    if (stored?.cloudflared) {
      service.cloudflaredConfig = stored.cloudflared;
      logger.info('dsh-bridge: loaded saved cloudflared config (autoStart=%s, tokenConfigured=%s)', Boolean(service.cloudflaredConfig.autoStart), Boolean(service.cloudflaredConfig.token));
      if (service.cloudflaredConfig.autoStart) {
        logger.info('dsh-bridge: auto-starting cloudflared tunnel...');
        service.startCloudflared({ autoStart: true }).catch((err) => {
          logger.error('dsh-bridge: cloudflared auto-start failed: %s', err?.message ?? err);
        });
      }
    }

    if (stored?.customTunnel) {
      service.customTunnelConfig = stored.customTunnel;
      logger.info('dsh-bridge: loaded saved custom tunnel config (autoStart=%s)', Boolean(service.customTunnelConfig.autoStart));
      if (service.customTunnelConfig.autoStart && service.customTunnelConfig.serverUrl) {
        logger.info('dsh-bridge: auto-starting custom tunnel...');
        service.startCustomTunnel({ autoStart: true }).catch((err) => {
          logger.error('dsh-bridge: custom tunnel auto-start failed: %s', err?.message ?? err);
        });
      }
    }

    if (stored?.tailscale?.url) {
      service.tailscaleConfig = stored.tailscale;
      logger.info('dsh-bridge: loaded saved tailscale url (%s)', service.tailscaleConfig.url);
    }
  }).catch(() => {});

  // Tailscale Serve 探测：30s 周期后台刷新（TTL 见 TAILNET_TTL_MS）。
  // 不能放在 getStatus() 里同步探测 —— 面板每 3s 轮询会不断起子进程。
  // unref 让定时器不阻止进程退出。
  ctx.effect(() => {
    void service.refreshTailnet();
    const timer = setInterval(() => { void service.refreshTailnet(); }, TAILNET_TTL_MS);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-bridge: tailnet probe refresh');

  // 平台管理器：注册/协调所有 IM 平台适配器
  const platformManager = new PlatformManager({ logger });

  // 微信 Bot（ClawBot/iLink）—— 作为 Platform 子类注册进平台管理器
  const wechat = new WechatService({
    ctx,
    logger,
    config: config.wechat ?? {},
    onPersist: async (patch) => {
      const stored = await loadConfig();
      stored.wechat = { ...(stored.wechat ?? {}), ...patch };
      await saveConfig(stored);
    },
  });
  platformManager.register(wechat);

  // QQ Bot（OpenAPI v2）—— 作为 Platform 子类注册进平台管理器
  const qq = new QqService({
    ctx,
    logger,
    config: config.qq ?? {},
    onPersist: async (patch) => {
      const stored = await loadConfig();
      stored.qq = { ...(stored.qq ?? {}), ...patch };
      await saveConfig(stored);
    },
  });
  platformManager.register(qq);

  // 飞书 Bot（官方 OpenAPI / WebSocket 长连接）—— 作为 Platform 子类注册进平台管理器
  const feishu = new FeishuService({
    ctx,
    logger,
    config: config.feishu ?? {},
    onPersist: async (patch) => {
      const stored = await loadConfig();
      stored.feishu = { ...(stored.feishu ?? {}), ...patch };
      await saveConfig(stored);
    },
  });
  platformManager.register(feishu);

  // Telegram Bot（官方 Long Polling + 代理支持）—— 作为 Platform 子类注册进平台管理器
  const telegram = new TelegramService({
    ctx,
    logger,
    config: config.telegram ?? {},
    onPersist: async (patch) => {
      const stored = await loadConfig();
      stored.telegram = { ...(stored.telegram ?? {}), ...patch };
      await saveConfig(stored);
    },
  });
  platformManager.register(telegram);

  // 启动时读取已保存的微信 Bot 配置（凭证 + 白名单 + 活动会话）
  loadConfig().then(async (stored) => {
    if (stored?.wechat) {
      const cfg = stored.wechat;
      // 统一收敛恢复规则：时序参数 + 会话级字符串配置（cwd/preset/模型）一并回写。
      // 此前只恢复 allowFrom 与时序参数，导致"配了、重启就丢"，会话掉回默认目录与空预设。
      applyRestoredPlatformConfig(wechat.node.config, cfg, {
        stringFields: RESTORED_STRING_FIELDS,
        numericFields: PLATFORM_TIMING_FIELDS,
        defaultMaxMessageChars: 2000,
      });

      wechat.node._restoringConfig = (async () => {
        try {
          if (cfg.activeSessionId) {
            wechat.node.activeSessionId = cfg.activeSessionId;
            logger.info('dsh-bridge: restored wechat active session: %s', cfg.activeSessionId);
          } else {
            await wechat.node._pickDefaultSession().catch(() => {});
          }
        } finally {
          wechat.node._configRestored = true;
        }
      })();

      await wechat.node._restoringConfig;

      if (cfg.token && cfg.accountId) {
        wechat.gateway.setCredentials({
          token: cfg.token,
          accountId: cfg.accountId,
          baseUrl: cfg.baseUrl,
        });
        logger.info('dsh-bridge: loaded saved wechat bot config, starting gateway');
        await wechat.start().catch((err) => {
          logger.error('dsh-bridge: wechat auto-start failed: %s', err?.message ?? err);
        });
      }
    }
  }).catch(() => {});

  // 启动时读取已保存的 QQ Bot 配置（凭证 + 白名单 + 活动会话）
  loadConfig().then(async (stored) => {
    if (stored?.qq) {
      const cfg = stored.qq;
      applyRestoredPlatformConfig(qq.node.config, cfg, {
        stringFields: RESTORED_STRING_FIELDS,
        numericFields: PLATFORM_TIMING_FIELDS,
        defaultMaxMessageChars: 2000,
      });

      qq.node._restoringConfig = (async () => {
        try {
          if (cfg.activeSessionId) {
            qq.node.activeSessionId = cfg.activeSessionId;
            logger.info('dsh-bridge: restored qq active session: %s', cfg.activeSessionId);
          } else {
            await qq.node._pickDefaultSession().catch(() => {});
          }
        } finally {
          qq.node._configRestored = true;
        }
      })();

      await qq.node._restoringConfig;

      if (cfg.appId && cfg.clientSecret) {
        qq.gateway.setCredentials({
          appId: cfg.appId,
          clientSecret: cfg.clientSecret,
          accessToken: cfg.accessToken,
          accessTokenExpiresAt: cfg.accessTokenExpiresAt,
          gatewayUrl: cfg.gatewayUrl,
          accountId: cfg.accountId,
        });
        logger.info('dsh-bridge: loaded saved qq bot config, starting gateway');
        await qq.start().catch((err) => {
          logger.error('dsh-bridge: qq auto-start failed: %s', err?.message ?? err);
        });
      }
    }
  }).catch(() => {});

  // 启动时读取已保存的飞书 Bot 配置（凭证 + 白名单 + 活动会话）
  loadConfig().then(async (stored) => {
    if (stored?.feishu) {
      const cfg = stored.feishu;
      applyRestoredPlatformConfig(feishu.node.config, cfg, {
        stringFields: RESTORED_STRING_FIELDS,
        numericFields: PLATFORM_TIMING_FIELDS,
        defaultMaxMessageChars: 2000,
      });

      feishu.node._restoringConfig = (async () => {
        try {
          if (cfg.activeSessionId) {
            feishu.node.activeSessionId = cfg.activeSessionId;
            logger.info('dsh-bridge: restored feishu active session: %s', cfg.activeSessionId);
          } else {
            await feishu.node._pickDefaultSession().catch(() => {});
          }
        } finally {
          feishu.node._configRestored = true;
        }
      })();

      await feishu.node._restoringConfig;

      if (cfg.appId && cfg.appSecret) {
        feishu.gateway.updateConfig({
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          domain: cfg.domain || 'feishu',
        });
        logger.info('dsh-bridge: loaded saved feishu bot config, starting gateway');
        await feishu.start().catch((err) => {
          logger.error('dsh-bridge: feishu auto-start failed: %s', err?.message ?? err);
        });
      }
    }
  }).catch(() => {});

  // 启动时读取已保存的 Telegram Bot 配置（凭证 + 代理 + 白名单 + 活动会话）
  loadConfig().then(async (stored) => {
    if (stored?.telegram) {
      const cfg = stored.telegram;
      applyRestoredPlatformConfig(telegram.node.config, cfg, {
        stringFields: RESTORED_STRING_FIELDS,
        numericFields: PLATFORM_TIMING_FIELDS,
        defaultMaxMessageChars: 4096,
      });

      telegram.node._restoringConfig = (async () => {
        try {
          if (cfg.activeSessionId) {
            telegram.node.activeSessionId = cfg.activeSessionId;
            logger.info('dsh-bridge: restored telegram active session: %s', cfg.activeSessionId);
          } else {
            await telegram.node._pickDefaultSession().catch(() => {});
          }
        } finally {
          telegram.node._configRestored = true;
        }
      })();

      await telegram.node._restoringConfig;

      if (cfg.botToken) {
        telegram.gateway.setCredentials({
          botToken: cfg.botToken,
          proxy: cfg.proxy || '',
        });
        logger.info('dsh-bridge: loaded saved telegram bot config, starting gateway');
        await telegram.start().catch((err) => {
          logger.error('dsh-bridge: telegram auto-start failed: %s', err?.message ?? err);
        });
      }
    }
  }).catch(() => {});

  const disposeRpc = installBridgeRpc(ctx, {
    service,
    authManager,
    wechat,
    qq,
    feishu,
    telegram,
    platformManager,
    logger,
    saveCustomTunnelConfig: async (serverUrl, accessToken) => {
      const stored = await loadConfig();
      stored.customTunnel = { serverUrl, accessToken };
      await saveConfig(stored);
      service.customTunnelConfig = { serverUrl, accessToken };
    },
    exportBackup: async () => {
      const stored = await loadConfig();
      return {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        config: stored,
      };
    },
    importBackup: async (backup) => {
      if (!backup || typeof backup !== 'object' || !backup.config || typeof backup.config !== 'object') {
        throw new Error('无效的备份数据结构：缺少 config 节点');
      }
      const incoming = backup.config;
      await saveConfig(incoming);

      // 重新载入 Auth
      if (incoming.auth) {
        if (incoming.auth.enabled != null) authManager.enabled = Boolean(incoming.auth.enabled);
        if (incoming.auth.mode) authManager.mode = incoming.auth.mode;
        if (incoming.auth.scope) authManager.scope = incoming.auth.scope;
        if (incoming.auth.adminPolicy) authManager.adminPolicy = incoming.auth.adminPolicy;
        if (incoming.auth.passwordHash) authManager.passwordHash = incoming.auth.passwordHash;
        if (incoming.auth.passwordSalt) authManager.passwordSalt = incoming.auth.passwordSalt;
        if (incoming.auth.adminPasswordHash) authManager.adminPasswordHash = incoming.auth.adminPasswordHash;
        if (incoming.auth.adminPasswordSalt) authManager.adminPasswordSalt = incoming.auth.adminPasswordSalt;
        if (incoming.auth.secretToken) authManager.secretToken = incoming.auth.secretToken;
      }
      // 重新载入 Tunnels
      if (incoming.cloudflared) {
        service.cloudflaredConfig = incoming.cloudflared;
      }
      if (incoming.customTunnel) {
        service.customTunnelConfig = incoming.customTunnel;
      }
      // 重新载入各 IM 平台白名单与配置（含会话级字符串配置，避免导入后 preset/cwd/模型丢失）
      if (incoming.wechat) {
        applyRestoredPlatformConfig(wechat.node.config, incoming.wechat, {
          stringFields: RESTORED_STRING_FIELDS,
          numericFields: PLATFORM_TIMING_FIELDS,
          defaultMaxMessageChars: 2000,
        });
      }
      if (incoming.qq) {
        applyRestoredPlatformConfig(qq.node.config, incoming.qq, {
          stringFields: RESTORED_STRING_FIELDS,
          numericFields: PLATFORM_TIMING_FIELDS,
          defaultMaxMessageChars: 2000,
        });
        if (incoming.qq.appId && incoming.qq.clientSecret) {
          qq.gateway.setCredentials({ appId: incoming.qq.appId, clientSecret: incoming.qq.clientSecret });
        }
      }
      if (incoming.feishu) {
        applyRestoredPlatformConfig(feishu.node.config, incoming.feishu, {
          stringFields: RESTORED_STRING_FIELDS,
          numericFields: PLATFORM_TIMING_FIELDS,
          defaultMaxMessageChars: 2000,
        });
        if (incoming.feishu.appId && incoming.feishu.appSecret) {
          feishu.gateway.setCredentials({ appId: incoming.feishu.appId, appSecret: incoming.feishu.appSecret });
        }
      }
      if (incoming.telegram) {
        applyRestoredPlatformConfig(telegram.node.config, incoming.telegram, {
          stringFields: RESTORED_STRING_FIELDS,
          numericFields: PLATFORM_TIMING_FIELDS,
          defaultMaxMessageChars: 4096,
        });
        if (incoming.telegram.botToken) {
          telegram.gateway.setCredentials({ botToken: incoming.telegram.botToken, proxy: incoming.telegram.proxy || '' });
        }
      }

      return { ok: true, message: '配置已成功导入并刷新生效！' };
    },
  });

  // 局域网访问代理：默认不随插件自动启动（交给 DSH 原生 --host 0.0.0.0 +
  // trustedHosts 处理局域网可达性，避免与原生监听重复）。需要时可在「远程访问」
  // 面板手动开启，或设置 <DSH_HOME>/dsh-bridge-gateway/config.json 的 lan.autoStart=true。
  loadConfig()
    .then((stored) => Boolean(stored?.lan?.autoStart))
    .catch(() => false)
    .then((lanAutoStart) => {
      if (!lanAutoStart) {
        logger.info('dsh-bridge: LAN proxy auto-start disabled (default off; enable via lan.autoStart)');
        return;
      }
      void service.startProxy().catch((err) => {
        logger.error('dsh-bridge: proxy start failed: %s', err?.message ?? err);
      });
    });

  ctx.effect(() => async () => {
    try { disposeRpc(); } catch {}
    await wechat.destroy();
    await qq.destroy();
    await feishu.destroy();
    await telegram.destroy();
    platformManager.dispose();
    authManager.dispose();
    await service.dispose();
  }, 'dsh-bridge: stop wechat, qq, feishu, telegram, proxy, auth and tunnels');
}

export { name, inject, apply, ProxyServer, BridgeService, selectLanIPv4, listAllLanIPv4 };
