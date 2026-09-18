// 平台配置恢复（从 <DSH_HOME>/dsh-bridge-gateway/config.json 回写到会话桥 config）
//
// 背景：平台配置的写入链路把整段平台配置落在 config.json 里，但启动/重启时的
// 读回链路只挑了几个白名单字段，导致 agentPreset / cwd / agentProvider / agentModel
// 这类字符串配置"配了、重启就丢"，会话随后落到 DSH 默认 preset 或空 preset 层。
// （移植自上游 dsh-bridge 的 lib/platform/config-restore.js，对应 issue #40。）
//
// 这里把恢复规则收敛成一个纯函数，既供 lib/index.js 的恢复链路使用，
// 也让"必须透传哪些字段"这条不变量可以被单测钉住。

/**
 * 恢复平台配置时必须透传的字符串字段白名单。
 *
 * 这四个键直接决定远程会话在哪里、以什么预设和模型启动：
 *   - cwd           会话工作区（`/new` 建在哪个目录）
 *   - agentPreset   DSH agent preset（决定该会话挂载的工具/提示词/技能目录）
 *   - agentProvider / agentModel  会话默认模型路由
 */
export const RESTORED_STRING_FIELDS = ['agentPreset', 'cwd', 'agentProvider', 'agentModel']

/**
 * 各平台 `setConfig()` 会持久化、因此恢复时必须一并回写的数值字段。
 *
 * 写入侧（wechat / qq / feishu / telegram 的 setConfig）统一持久化这三个会话节奏参数；
 * 恢复侧若漏掉，用户在设置页调好的摘要间隔 / 审批超时 / 分块延时只活到下一次重启。
 * 写入侧新增数值字段时，必须同步这里。
 */
export const PLATFORM_TIMING_FIELDS = ['digestIntervalSec', 'approvalTimeoutSec', 'sendChunkDelayMs']

/**
 * 把 config.json 中某个平台的持久化配置回写到会话桥的 node.config。
 *
 * 规则（与磁盘上的写入契约一致）：
 *   - allowFrom 一律以数组形式落回，缺失即空数组；
 *   - numericFields 与 maxMessageChars 走数值归一，maxMessageChars 低于 200 视为无效并回落默认值；
 *   - groupAutoApprove 仅在显式写入时按布尔解释；
 *   - stringFields 只接受非空字符串，空串/非字符串一律忽略（保留构造期配置）。
 *
 * @param {object} nodeConfig 会话桥的 config 对象（就地修改）
 * @param {object} cfg        config.json 里该平台的持久化配置
 * @param {object} [opts]
 * @param {string[]} [opts.numericFields] 需要数值归一化的字段名
 * @param {string[]} [opts.stringFields]  需要字符串透传的字段名
 * @param {number}   [opts.defaultMaxMessageChars] maxMessageChars 无效时的默认值
 * @returns {object} 同一个 nodeConfig（便于串联）
 */
export function applyRestoredPlatformConfig(nodeConfig, cfg, {
  numericFields = [],
  stringFields = [],
  defaultMaxMessageChars = 2000,
} = {}) {
  if (!nodeConfig || !cfg) return nodeConfig

  nodeConfig.allowFrom = Array.isArray(cfg.allowFrom) ? cfg.allowFrom : []
  for (const field of numericFields) {
    if (cfg[field] != null) nodeConfig[field] = Number(cfg[field])
  }
  if (cfg.maxMessageChars != null) {
    const val = Number(cfg.maxMessageChars)
    nodeConfig.maxMessageChars = (val >= 200) ? val : defaultMaxMessageChars
  }
  if (cfg.groupAutoApprove != null) nodeConfig.groupAutoApprove = cfg.groupAutoApprove === true

  for (const field of stringFields) {
    const val = cfg[field]
    // 只接受非空（且非纯空白）字符串：空串/垃圾值不应清掉或污染构造期配置
    if (typeof val === 'string' && val.trim().length > 0) nodeConfig[field] = val
  }
  return nodeConfig
}
