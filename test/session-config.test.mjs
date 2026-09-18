// 会话级配置读写归一测试（移植自上游 dsh-bridge lib/platform/session-config.js）
//
// 这四个字段（cwd / agentPreset / agentProvider / agentModel）决定远程会话
// "建在哪里、挂什么预设、用哪个模型"。它们同时出现在 cordis 配置 → 设置页写入
// （config.json）→ 启动恢复三处，必须共用同一套字段名与空值语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_CONFIG_FIELDS,
  readSessionConfig,
  applySessionConfig,
  sessionConfigPatch,
} from '../lib/platform/session-config.js'

test('SESSION_CONFIG_FIELDS lists the four session-level keys in UI order', () => {
  assert.deepEqual(SESSION_CONFIG_FIELDS, ['agentPreset', 'cwd', 'agentProvider', 'agentModel'])
})

test('readSessionConfig normalises missing / non-string values to empty string', () => {
  assert.deepEqual(readSessionConfig(undefined), {
    agentPreset: '', cwd: '', agentProvider: '', agentModel: '',
  })
  assert.deepEqual(readSessionConfig({ cwd: '/a', agentPreset: 42 }), {
    agentPreset: '', cwd: '/a', agentProvider: '', agentModel: '',
  })
})

test('applySessionConfig writes string fields and reports what changed', () => {
  const config = {}
  const changed = applySessionConfig(config, {
    cwd: '/Users/imac/Desktop/StoreLinkMS',
    agentPreset: 'standard',
    agentProvider: 'workbuddy',
    agentModel: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(changed, ['agentPreset', 'cwd', 'agentProvider', 'agentModel'])
  assert.equal(config.cwd, '/Users/imac/Desktop/StoreLinkMS')
  assert.equal(config.agentPreset, 'standard')
})

test('applySessionConfig ignores fields absent from the patch (partial update keeps values)', () => {
  const config = { cwd: '/keep', agentPreset: 'standard', agentProvider: 'p', agentModel: 'm' }
  const changed = applySessionConfig(config, { agentPreset: 'minimal' })
  assert.deepEqual(changed, ['agentPreset'])
  assert.equal(config.agentPreset, 'minimal')
  // 其余字段不被清空
  assert.equal(config.cwd, '/keep')
  assert.equal(config.agentProvider, 'p')
  assert.equal(config.agentModel, 'm')
})

test('applySessionConfig ignores non-string values entirely', () => {
  const config = { cwd: '/keep' }
  const changed = applySessionConfig(config, { cwd: null, agentPreset: 42, agentModel: undefined })
  assert.deepEqual(changed, [])
  assert.equal(config.cwd, '/keep')
  assert.equal(config.agentPreset, undefined)
})

test('empty string is an explicit clear (falls back to DSH defaults at session creation)', () => {
  const config = { agentPreset: 'standard', cwd: '/old' }
  const changed = applySessionConfig(config, { agentPreset: '', cwd: '' })
  assert.deepEqual(changed, ['agentPreset', 'cwd'])
  assert.equal(config.agentPreset, '')
  assert.equal(config.cwd, '')
})

test('values are trimmed on write', () => {
  const config = {}
  applySessionConfig(config, { cwd: '  /Users/imac/Desktop/x  ', agentPreset: ' standard ' })
  assert.equal(config.cwd, '/Users/imac/Desktop/x')
  assert.equal(config.agentPreset, 'standard')
})

test('applySessionConfig reports no change when the value is identical', () => {
  const config = { cwd: '/same' }
  assert.deepEqual(applySessionConfig(config, { cwd: '/same' }), [])
})

test('sessionConfigPatch produces a persist payload covering all four fields', () => {
  const patch = sessionConfigPatch({ cwd: '/a', agentPreset: 'standard' })
  assert.deepEqual(patch, {
    agentPreset: 'standard', cwd: '/a', agentProvider: '', agentModel: '',
  })
})

test('write → persist → restore round-trips the session config', async () => {
  // 模拟设置页写入 → persist → 重启后恢复的完整链路
  const { applyRestoredPlatformConfig, RESTORED_STRING_FIELDS } =
    await import('../lib/platform/config-restore.js')

  const live = {}
  applySessionConfig(live, {
    cwd: '/Users/imac/Desktop/DSHworkspace',
    agentPreset: 'liangshen',
    agentProvider: 'workbuddy',
    agentModel: 'deepseek-v4.1-flash',
  })
  const persisted = sessionConfigPatch(live)          // 写入 config.json 的内容

  const restored = {}                                  // 重启后的新 node.config
  applyRestoredPlatformConfig(restored, persisted, { stringFields: RESTORED_STRING_FIELDS })

  assert.equal(restored.cwd, '/Users/imac/Desktop/DSHworkspace')
  assert.equal(restored.agentPreset, 'liangshen')
  assert.equal(restored.agentProvider, 'workbuddy')
  assert.equal(restored.agentModel, 'deepseek-v4.1-flash')
})
