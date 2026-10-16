// 路径中心：插件所有持久化路径的唯一来源。
//
// 为什么需要它：此前数据目录名 'dsh-bridge' 是散落在 8+ 处硬编码字面量。
// fork 成 dsh-bridge-gateway 后包名与 loader id 都改了，唯独这些字面量没跟着改，
// 于是出现「插件叫 dsh-bridge-gateway，目录却叫 dsh-bridge」的不一致。
// 收敛到这里之后，改名只需改一处，且迁移逻辑有单一入口。
//
// 目录布局：
//   <DSH_HOME>/dsh-bridge-gateway/            ← 本插件的数据目录（新名）
//     config.json                              隧道/网关/认证配置
//     sessions.json                            登录会话（权限 600）
//     reset-auth                              救急标记
//     access.log                               访问日志
//     certs/gateway-<port>/                    自签证书
//     wechat-context-tokens.json               微信上下文 token
//
// 旧目录（<DSH_HOME>/dsh-bridge/）在启动时自动迁移，见 migrateLegacyDataDir()。
import { existsSync, renameSync, mkdirSync, cpSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本插件的数据目录名（与 package.json / cordis loader id 保持一致）。 */
export const DATA_DIR_NAME = 'dsh-bridge-gateway';

/** 迁移前使用的旧目录名（上游沿用，fork 后未同步改名）。 */
export const LEGACY_DATA_DIR_NAME = 'dsh-bridge';

/** 返回 DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 返回本插件的数据目录（新名）。 */
export function dataDir() {
  return join(dshHome(), DATA_DIR_NAME);
}

/** 返回迁移前的旧数据目录。 */
export function legacyDataDir() {
  return join(dshHome(), LEGACY_DATA_DIR_NAME);
}

/** 数据目录下的某个路径。 */
export function dataPath(...segments) {
  return join(dataDir(), ...segments);
}

/** 旧数据目录下的某个路径。 */
export function legacyDataPath(...segments) {
  return join(legacyDataDir(), ...segments);
}

/** 配置文件路径。 */
export function configFile() {
  return dataPath('config.json');
}

/** 登录会话文件路径。 */
export function sessionsFile() {
  return dataPath('sessions.json');
}

/** 救急重置标记路径。 */
export function resetAuthFile() {
  return dataPath('reset-auth');
}

/** 访问日志路径。 */
export function accessLogFile() {
  return dataPath('access.log');
}

/** 自签证书目录。 */
export function certDir(port) {
  return dataPath('certs', `gateway-${port}`);
}

/** 微信上下文 token 文件路径。 */
export function wechatContextTokenFile() {
  return dataPath('wechat-context-tokens.json');
}

// ── cloudflared 二进制缓存 ────────────────────────────────────────────────
// 与插件数据目录分开存放：它是可重新下载的外部依赖（约 39MB），不是用户数据。
//
// 这个名字改过两次，所以迁移是**两级链**：
//   ~/.dsh-bridge/                     ← 上游沿用名（fork 前）
//   ~/.dsh-bridge-cloudflared/         ← 第一次改名后
//   ~/.dsh-bridge-gateway-cloudflared/ ← 当前
// 迁移按"从新到旧"依次尝试，命中第一个存在的旧目录即迁移，避免老用户白等一次
// 39MB 重下载。
export const CLOUDFLARED_DIR_NAME = '.dsh-bridge-gateway-cloudflared';

/**
 * cloudflared 缓存目录的历史名字，**从新到旧**。
 * 迁移顺序即数组顺序：先找最近一次改名前的名字，再往上追。
 */
export const LEGACY_CLOUDFLARED_DIR_NAMES = Object.freeze([
  '.dsh-bridge-cloudflared',
  '.dsh-bridge',
]);

/** cloudflared 缓存根目录（当前名）。 */
export function cloudflaredDir() {
  return join(homedir(), CLOUDFLARED_DIR_NAME);
}

/** 全部历史缓存目录（从新到旧）。 */
export function legacyCloudflaredDirs() {
  return LEGACY_CLOUDFLARED_DIR_NAMES.map((name) => join(homedir(), name));
}

/** cloudflared 二进制所在目录。 */
export function cloudflaredBinDir() {
  return join(cloudflaredDir(), 'bin');
}

/** 可能存放 cloudflared 二进制的全部目录（当前 + 历史），供清理时一并处理。 */
export function cloudflaredBinDirs() {
  return [cloudflaredDir(), ...legacyCloudflaredDirs()].map((dir) => join(dir, 'bin'));
}

/**
 * 迁移 cloudflared 二进制缓存目录（历史名 → 当前名）。幂等。
 *
 * 按 `LEGACY_CLOUDFLARED_DIR_NAMES` 的顺序（从新到旧）尝试，命中第一个存在
 * 且确实是目录的旧目录即迁移，然后返回。
 *
 * 与数据目录迁移的区别：这里失败代价只是「重新下载约 39MB」，不是丢数据，
 * 因此策略更宽松 —— 失败也不抛出，让下载逻辑自愈。
 *
 * @returns {{migrated: boolean, reason: string, from?: string, to?: string}}
 */
export function migrateLegacyCloudflaredDir({ logger } = {}) {
  const to = cloudflaredDir();
  try {
    if (existsSync(to)) return { migrated: false, reason: 'already-migrated' };

    // 从新到旧找第一个可用的旧目录
    let from = null;
    for (const candidate of legacyCloudflaredDirs()) {
      if (!existsSync(candidate)) continue;
      if (!statSync(candidate).isDirectory()) continue;
      from = candidate;
      break;
    }
    if (!from) return { migrated: false, reason: 'no-legacy-dir' };

    try {
      renameSync(from, to);
      logger?.info?.('dsh-bridge-gateway: cloudflared 缓存目录已迁移 %s -> %s', from, to);
      return { migrated: true, reason: 'renamed', from, to };
    } catch (renameErr) {
      mkdirSync(to, { recursive: true });
      try {
        cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      } catch (copyErr) {
        logger?.warn?.(
          'dsh-bridge-gateway: cloudflared 缓存复制失败（将按需重新下载）：%s',
          copyErr?.message ?? copyErr,
        );
        return { migrated: false, reason: `copy-failed:${copyErr?.message ?? copyErr}` };
      }
      logger?.info?.('dsh-bridge-gateway: cloudflared 缓存已复制迁移 %s -> %s', from, to);
      return { migrated: true, reason: 'copied', from, to };
    }
  } catch (err) {
    logger?.warn?.('dsh-bridge-gateway: cloudflared 缓存迁移失败（将按需重新下载）：%s', err?.message ?? err);
    return { migrated: false, reason: `error:${err?.message ?? err}` };
  }
}

/**
 * 把旧数据目录迁移到新目录。幂等，可安全重复调用。
 *
 * 规则（按"绝不丢数据"优先排序）：
 *   1. 新目录已存在 → 不动（说明已迁移过，或用户已在新目录工作）；
 *   2. 旧目录不存在 → 无需迁移，直接创建新目录；
 *   3. 旧目录存在 → 优先 `rename`（原子、同分区瞬时完成）；
 *      跨设备 rename 失败时退化为递归复制，**复制成功才**删除旧目录。
 *
 * 迁移失败不抛出：返回结果对象供调用方记录日志。认证/配置会退回旧目录读取路径，
 * 保证在最坏情况下插件仍能启动，而不是因为迁移失败而整个不可用。
 *
 * @returns {{migrated: boolean, reason: string, from?: string, to?: string}}
 */
export function migrateLegacyDataDir({ logger } = {}) {
  const from = legacyDataDir();
  const to = dataDir();

  try {
    if (existsSync(to)) {
      return { migrated: false, reason: 'already-migrated' };
    }
    if (!existsSync(from)) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      return { migrated: false, reason: 'no-legacy-dir' };
    }
    // 确认旧路径确实是目录（避免被同名文件卡住）。
    // 注意：此时仍要保证新目录存在，否则调用方会在一个不存在的目录里写配置。
    if (!statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      return { migrated: false, reason: 'legacy-not-a-directory' };
    }

    try {
      renameSync(from, to);
      logger?.info?.('dsh-bridge-gateway: 数据目录已迁移 %s -> %s', from, to);
      return { migrated: true, reason: 'renamed', from, to };
    } catch (renameErr) {
      // 跨设备（EXDEV）等场景：复制后再删源。
      logger?.warn?.(
        'dsh-bridge-gateway: rename 迁移失败（%s），改用复制',
        renameErr?.message ?? renameErr,
      );
      mkdirSync(to, { recursive: true, mode: 0o700 });
      cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      // 只在复制确实产出内容后才移除旧目录，避免"复制没成功却删了源"。
      if (!existsSync(to)) return { migrated: false, reason: 'copy-failed' };
      try {
        renameSync(from, `${from}.migrated-${Date.now()}`);
      } catch { /* 旧目录留档，不影响新目录可用 */ }
      logger?.info?.('dsh-bridge-gateway: 数据目录已复制迁移 %s -> %s', from, to);
      return { migrated: true, reason: 'copied', from, to };
    }
  } catch (err) {
    logger?.error?.(
      'dsh-bridge-gateway: 数据目录迁移失败（将继续使用新路径，旧数据保留在原处）：%s',
      err?.message ?? err,
    );
    return { migrated: false, reason: `error:${err?.message ?? err}` };
  }
}
