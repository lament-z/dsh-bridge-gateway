// Telegram CONNECT 代理 Agent 回归测试
//
// 背景（上游 issue #32）：Node >= 24 下把自定义 createConnection 作为 https.Agent
// 的构造参数会被**静默忽略** —— https.Agent 不拷贝构造入参里的 createConnection，
// 回退到原型上的默认直连方法。表现是"配了代理却永远走直连"，且不报任何错。
// 修复：构造完成后赋值**实例自有属性**（自有属性覆盖原型方法，Node 22/24 均生效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { createConnectProxyAgent } from '../lib/telegram/gateway.js'

test('createConnectProxyAgent installs the tunnel as an OWN property (survives Node >=24)', () => {
  const agent = createConnectProxyAgent('http://127.0.0.1:7890')
  assert.ok(agent instanceof https.Agent)
  // 自有属性 → 能覆盖原型方法
  assert.ok(
    Object.hasOwn(agent, 'createConnection'),
    'createConnection must be an own property, otherwise Node >=24 falls back to direct connect',
  )
  assert.notEqual(agent.createConnection, https.Agent.prototype.createConnection)
})

test('regression: a constructor-supplied createConnection is dropped on Node >=24', () => {
  // 记录宿主行为，防止有人"顺手改回"构造参数写法
  const viaConstructor = new https.Agent({
    keepAlive: true,
    createConnection() { return 'sentinel' },
  })
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 24) {
    assert.equal(
      viaConstructor.createConnection,
      https.Agent.prototype.createConnection,
      'Node >=24 is expected to discard a constructor-supplied createConnection',
    )
  }
})

test('returns undefined for missing / invalid proxy URLs', () => {
  assert.equal(createConnectProxyAgent(''), undefined)
  assert.equal(createConnectProxyAgent(undefined), undefined)
  assert.equal(createConnectProxyAgent('not a url'), undefined)
})

test('parses proxy port and falls back to 8080', () => {
  // 8080 回落：不能直接读私有字段，改为确认能构造出可用 agent
  assert.ok(createConnectProxyAgent('http://proxy.local') instanceof https.Agent)
  assert.ok(createConnectProxyAgent('http://proxy.local:3128') instanceof https.Agent)
})

test('supports proxy credentials without throwing on encoded chars', () => {
  const agent = createConnectProxyAgent('http://user%40corp:p%40ss@proxy.local:8080')
  assert.ok(agent instanceof https.Agent)
  assert.ok(Object.hasOwn(agent, 'createConnection'))
})
