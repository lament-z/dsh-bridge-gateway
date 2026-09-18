// 平台配置恢复回归测试（移植自上游 dsh-bridge，对应 issue #40 / #39）
//
// 背景：平台配置写入 config.json 后，启动/重启的读回链路此前只挑了几个白名单字段，
// 导致 agentPreset / cwd / agentProvider / agentModel "配了、重启就丢" —— 会话随后
// 落到 DSH 默认目录与空 preset 层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRestoredPlatformConfig,
  RESTORED_STRING_FIELDS,
  PLATFORM_TIMING_FIELDS,
} from '../lib/platform/config-restore.js'

test('RESTORED_STRING_FIELDS covers the four session-level config keys', () => {
  assert.deepEqual(RESTORED_STRING_FIELDS, ['agentPreset', 'cwd', 'agentProvider', 'agentModel'])
})

test('PLATFORM_TIMING_FIELDS covers the three persisted pacing params', () => {
  assert.deepEqual(PLATFORM_TIMING_FIELDS, ['digestIntervalSec', 'approvalTimeoutSec', 'sendChunkDelayMs'])
})

test('restores session-level string fields (the regression: these used to be dropped)', () => {
  const nodeConfig = {}
  applyRestoredPlatformConfig(nodeConfig, {
    cwd: '/Users/imac/Desktop/StoreLinkMS',
    agentPreset: 'standard',
    agentProvider: 'workbuddy',
    agentModel: 'deepseek-v4.1-flash',
  }, { stringFields: RESTORED_STRING_FIELDS })

  assert.equal(nodeConfig.cwd, '/Users/imac/Desktop/StoreLinkMS')
  assert.equal(nodeConfig.agentPreset, 'standard')
  assert.equal(nodeConfig.agentProvider, 'workbuddy')
  assert.equal(nodeConfig.agentModel, 'deepseek-v4.1-flash')
})

test('restores pacing params alongside the string fields', () => {
  const nodeConfig = {}
  applyRestoredPlatformConfig(nodeConfig, {
    digestIntervalSec: 30,
    approvalTimeoutSec: 120,
    sendChunkDelayMs: '250',
    agentPreset: 'standard',
  }, { stringFields: RESTORED_STRING_FIELDS, numericFields: PLATFORM_TIMING_FIELDS })

  assert.equal(nodeConfig.digestIntervalSec, 30)
  assert.equal(nodeConfig.approvalTimeoutSec, 120)
  assert.equal(nodeConfig.sendChunkDelayMs, 250) // 字符串数字被归一为 Number
  assert.equal(nodeConfig.agentPreset, 'standard')
})

test('blank / whitespace / non-string values never clobber constructor config', () => {
  const nodeConfig = { agentPreset: 'from-constructor', cwd: '/keep' }
  applyRestoredPlatformConfig(nodeConfig, {
    agentPreset: '   ',   // 纯空白 → 忽略
    cwd: '',              // 空串 → 忽略
    agentProvider: 42,    // 非字符串 → 忽略
    // agentModel 缺失 → 保持原值
  }, { stringFields: RESTORED_STRING_FIELDS })

  assert.equal(nodeConfig.agentPreset, 'from-constructor')
  assert.equal(nodeConfig.cwd, '/keep')
  assert.equal(nodeConfig.agentProvider, undefined)
  assert.equal(nodeConfig.agentModel, undefined)
})

test('allowFrom is always coerced to an array', () => {
  assert.deepEqual(applyRestoredPlatformConfig({}, { allowFrom: ['u1'] }).allowFrom, ['u1'])
  // 缺失 / 非法形态 → 空数组（不是 undefined）
  assert.deepEqual(applyRestoredPlatformConfig({}, {}).allowFrom, [])
  assert.deepEqual(applyRestoredPlatformConfig({}, { allowFrom: 'nope' }).allowFrom, [])
})

test('maxMessageChars falls back to the platform default when invalid', () => {
  // 低于 200 视为无效
  assert.equal(
    applyRestoredPlatformConfig({}, { maxMessageChars: 10 }, { defaultMaxMessageChars: 4096 }).maxMessageChars,
    4096,
  )
  // 合法值原样保留
  assert.equal(
    applyRestoredPlatformConfig({}, { maxMessageChars: 2000 }, { defaultMaxMessageChars: 4096 }).maxMessageChars,
    2000,
  )
})

test('groupAutoApprove is only interpreted when explicitly present', () => {
  assert.equal(applyRestoredPlatformConfig({}, { groupAutoApprove: true }).groupAutoApprove, true)
  assert.equal(applyRestoredPlatformConfig({}, { groupAutoApprove: 1 }).groupAutoApprove, false)
  assert.equal(applyRestoredPlatformConfig({}, {}).groupAutoApprove, undefined)
})

test('is a no-op on missing inputs (safe when config.json has no section)', () => {
  const nodeConfig = { allowFrom: ['x'] }
  assert.equal(applyRestoredPlatformConfig(nodeConfig, undefined), nodeConfig)
  assert.deepEqual(nodeConfig, { allowFrom: ['x'] })
  assert.equal(applyRestoredPlatformConfig(undefined, { cwd: '/a' }), undefined)
})
