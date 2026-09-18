// DSH 0.1.5-rc.2 适配回归测试
//
// 覆盖两个来自上游 dsh-bridge 的真实缺陷修复（本地同源代码同样存在）：
//   1. 会话已存在误判（上游 issue #39）
//      sessionPersistence.list() 在新版 DSH 返回 `{ header, revision, sizeBytes }`
//      快照，直接读 entry.id 会恒为 undefined → 已存在的会话被误判成"未持久化"
//      → agents.create 建同名会话失败，报 `session "..." already exists`。
//   2. Agent preset 只写 meta 不挂载（上游 issue #40）
//      DSH 0.1.5 起工具/提示词/技能目录整体挪到 agent preset 后面，只往 meta 里写
//      agentPreset 不会挂载任何东西，会话落在「空 preset 层」，工具集残缺。
//      必须通过 agents.create/resume 的 setup 回调真正调用 presets.mount()。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationBridge, conversationBridgeHelpers } from '../lib/platform/index.js'

const { sessionHeaderOf } = conversationBridgeHelpers

// ---------------------------------------------------------------------------
// 1. sessionHeaderOf：兼容新旧两种数据形态
// ---------------------------------------------------------------------------

test('sessionHeaderOf reads the header out of a 0.1.5+ snapshot entry', () => {
  const entry = { header: { id: 'session-abc', agentPreset: 'standard' }, revision: 3, sizeBytes: 1024 }
  assert.equal(sessionHeaderOf(entry)?.id, 'session-abc')
  assert.equal(sessionHeaderOf(entry)?.agentPreset, 'standard')
})

test('sessionHeaderOf falls back to a legacy flat entry', () => {
  const entry = { id: 'session-legacy', agentPreset: 'standard' }
  assert.equal(sessionHeaderOf(entry)?.id, 'session-legacy')
})

test('sessionHeaderOf returns undefined for entries without a usable id', () => {
  // 这正是旧写法踩坑的形态：snapshot 项本身没有 id
  assert.equal(sessionHeaderOf({ revision: 3, sizeBytes: 1024 }), undefined)
  assert.equal(sessionHeaderOf(undefined), undefined)
  assert.equal(sessionHeaderOf(null), undefined)
  assert.equal(sessionHeaderOf('nonsense'), undefined)
  // header 存在但没有字符串 id → 不作为可用会话头
  assert.equal(sessionHeaderOf({ header: { id: 123 } }), undefined)
})

test('regression #39: a snapshot entry is recognised as persisted (old code would not)', () => {
  const sessionId = 'session-9f1c'
  const list = [
    { header: { id: 'session-other' }, revision: 1, sizeBytes: 10 },
    { header: { id: sessionId, agentPreset: 'standard' }, revision: 2, sizeBytes: 20 },
  ]
  // 旧写法：list.some((h) => h?.id === sessionId) → 恒为 false（误判）
  assert.equal(list.some((h) => h?.id === sessionId), false)
  // 新写法：经 sessionHeaderOf 取头 → 正确判定为已持久化
  const matched = sessionHeaderOf(list.find((e) => sessionHeaderOf(e)?.id === sessionId))
  assert.equal(matched?.id, sessionId)
  assert.equal(matched?.agentPreset, 'standard')
})

// ---------------------------------------------------------------------------
// 2. _composeAgentPreset：解析、回退与 setup 装配
// ---------------------------------------------------------------------------

// 造一个满足 ConversationBridge 构造期需求的最小 ctx
// （构造期会订阅出站事件，故 on/emit 必须存在）
function makeMockCtx(extra = {}) {
  const events = {}
  const ctx = {
    _mock: true,
    on(event, fn) {
      (events[event] ??= []).push(fn)
      return () => { events[event] = events[event].filter((f) => f !== fn) }
    },
    emit(event, ...args) { (events[event] ?? []).forEach((fn) => fn(...args)) },
    logger: { info() {}, warn() {}, error() {} },
    sessions: { list: () => [], get: () => undefined },
    ...extra,
  }
  return { ctx, events }
}

function bridgeWithCtx(ctx, config = {}) {
  const platform = {
    id: 'mock',
    name: 'Mock IM',
    capabilities: { maxMessageChars: 2000 },
    async sendText() { return { success: true } },
  }
  const logger = { info() {}, warn() {}, error() {} }
  return new ConversationBridge({ platform, ctx, logger, config })
}

test('_composeAgentPreset returns no setup on a legacy DSH without agentPresets', async () => {
  const { ctx } = makeMockCtx({ get: () => undefined })
  const bridge = bridgeWithCtx(ctx)
  const composition = await bridge._composeAgentPreset('standard')
  // 旧版 DSH：保持原行为，不传 setup，但仍记录 preset 名
  assert.equal(composition.agentPreset, 'standard')
  assert.equal(composition.setup, undefined)
  assert.equal(composition.fallbackFrom, undefined)
})

test('_composeAgentPreset resolves the id and wires a real mount via setup (regression #40)', async () => {
  const mounted = []
  const presets = {
    async resolve(id) { return { id: id ?? 'default' } },
    async mount(agentCtx, id) { mounted.push({ agentCtx, id }) },
  }
  const { ctx } = makeMockCtx({ get: (name) => (name === 'agentPresets' ? presets : undefined) })
  const bridge = bridgeWithCtx(ctx)

  const composition = await bridge._composeAgentPreset('routing-suite')
  assert.equal(composition.agentPreset, 'routing-suite')
  assert.equal(typeof composition.setup, 'function')

  // setup 必须真正调用 mount —— 这才是"挂载"，不是往 meta 里写名字
  const agentCtx = { fake: 'agent-ctx' }
  await composition.setup(agentCtx)
  assert.deepEqual(mounted, [{ agentCtx, id: 'routing-suite' }])
})

test('_composeAgentPreset treats blank/whitespace as unconfigured', async () => {
  const presets = {
    async resolve(id) { return { id: id ?? 'default' } },
    async mount() {},
  }
  const { ctx } = makeMockCtx({ get: (name) => (name === 'agentPresets' ? presets : undefined) })
  const bridge = bridgeWithCtx(ctx)

  for (const value of ['', '   ', undefined, null]) {
    const composition = await bridge._composeAgentPreset(value)
    // 未配置 → 交给 DSH 默认 preset（resolve(undefined)）
    assert.equal(composition.agentPreset, 'default')
    assert.equal(composition.fallbackFrom, undefined)
  }
})

test('_composeAgentPreset falls back to the default preset when the configured one is gone', async () => {
  const presets = {
    async resolve(id) {
      if (id === undefined || id === 'default') return { id: 'default' }
      throw new Error(`agent-presets: preset "${id}" not found`)
    },
    async mount() {},
  }
  const { ctx } = makeMockCtx({ get: (name) => (name === 'agentPresets' ? presets : undefined) })
  const bridge = bridgeWithCtx(ctx)

  const composition = await bridge._composeAgentPreset('deleted-preset')
  // 回退到默认，但要留下 fallbackFrom 以便向用户明示（不静默降级）
  assert.equal(composition.agentPreset, 'default')
  assert.equal(composition.fallbackFrom, 'deleted-preset')
  assert.equal(typeof composition.setup, 'function')
})

test('_composeAgentPreset rethrows when no preset is configured and resolution fails', async () => {
  const presets = {
    async resolve() { throw new Error('agent-presets: no presets available') },
    async mount() {},
  }
  const { ctx } = makeMockCtx({ get: (name) => (name === 'agentPresets' ? presets : undefined) })
  const bridge = bridgeWithCtx(ctx)

  // 未配置 preset 且默认也解析不出来 → 不应吞掉错误（否则会在空层上建会话）
  await assert.rejects(() => bridge._composeAgentPreset(undefined), /no presets available/)
})

// ---------------------------------------------------------------------------
// 3. 不再硬编码不存在的默认 preset
// ---------------------------------------------------------------------------

test('createSession no longer hardcodes the nonexistent "routing-suite" preset', async () => {
  const resolved = []
  const presets = {
    async resolve(id) { resolved.push(id); return { id: id ?? 'standard' } },
    async mount() {},
  }
  const created = []
  const { ctx } = makeMockCtx({
    get: (name) => (name === 'agentPresets' ? presets : undefined),
    agents: {
      create: async (options) => {
        created.push(options)
        return { agent: { session: { id: options.sessionId }, followup: () => {}, status: 'idle', cancel: () => {} } }
      },
    },
    workspaceRegistry: { list: async () => [] },
  })
  const bridge = bridgeWithCtx(ctx, {})
  bridge.sendText = async () => ({ success: true })

  await bridge.createSession('')

  // 未配置 agentPreset 时必须以 undefined 解析（交给 DSH 默认 preset），
  // 而不是解析一个本机不存在的 'routing-suite'
  assert.deepEqual(resolved, [undefined])
  assert.equal(created.length, 1)
  assert.notEqual(created[0].meta.agentPreset, 'routing-suite')
  assert.equal(created[0].meta.agentPreset, 'standard')
  // 必须带上 setup 回调（真正挂载）
  assert.equal(typeof created[0].setup, 'function')
})
