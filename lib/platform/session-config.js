// 会话级配置（工作区 / Agent 预设 / 模型路由）的读写归一
//
// 这四个字段决定远程会话"建在哪里、挂什么预设、用哪个模型"：
//   - cwd            会话工作区
//   - agentPreset    DSH agent preset（决定该会话挂载的工具/提示词/技能目录）
//   - agentProvider  模型提供方
//   - agentModel     模型
//
// 它们同时出现在三处：cordis 配置 → 设置页写入（config.json）→ 启动恢复。
// 三处必须共用同一套字段名与空值语义，否则又会出现"配了不生效 / 重启就丢"。
// 空串表示"未设置"：会话创建时回落到 DSH 默认值。
//
// （移植自上游 dsh-bridge 的 lib/platform/session-config.js。）

/** 会话级配置的字段名（顺序即 UI 展示顺序）。 */
export const SESSION_CONFIG_FIELDS = ['agentPreset', 'cwd', 'agentProvider', 'agentModel']

/**
 * 读取会话级配置（供 UI 回显 / 持久化 patch 使用）。
 * @param {object} config 会话桥的 config
 * @returns {{agentPreset: string, cwd: string, agentProvider: string, agentModel: string}}
 */
export function readSessionConfig(config) {
  const out = {}
  for (const field of SESSION_CONFIG_FIELDS) {
    out[field] = typeof config?.[field] === 'string' ? config[field] : ''
  }
  return out
}

/**
 * 应用一组会话级配置（就地修改 config）。
 *
 * 只接受字符串入参：未出现在 patch 里的字段保持原值，非字符串（undefined/null/数字）
 * 一律忽略；字符串按 trim 后写入，空串表示显式清除该设置、回落 DSH 默认值。
 *
 * @param {object} config 会话桥的 config
 * @param {object} patch  来自设置页的 patch
 * @returns {string[]} 实际被改写的字段名
 */
export function applySessionConfig(config, patch) {
  if (!config || !patch) return []
  const changed = []
  for (const field of SESSION_CONFIG_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue
    const raw = patch[field]
    if (typeof raw !== 'string') continue
    const next = raw.trim()
    if (config[field] === next) continue
    config[field] = next
    changed.push(field)
  }
  return changed
}

/**
 * 从 config 中取出需要持久化的会话级配置 patch（只含已设置的字段）。
 *
 * 与 applySessionConfig 配对：写入侧用它构造 persist() 的载荷，
 * 保证"写进去的"与"读回来的"是同一套字段。
 *
 * @param {object} config 会话桥的 config
 * @returns {object} 可直接传给 persist() 的 patch
 */
export function sessionConfigPatch(config) {
  const out = {}
  for (const field of SESSION_CONFIG_FIELDS) out[field] = readSessionConfig(config)[field]
  return out
}
