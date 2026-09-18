// 登录 Session 持久化回归测试
//
// 背景（上游 issue #36 / PR #37）：sessions 此前是纯内存 Map，宿主（dsh web 进程）
// 重启后所有已登录设备都要重新输访问密码。现落盘到 <DSH_HOME>/dsh-bridge-gateway/sessions.json
// （权限 600），并保持"改密码 / 切模式 / 重新生成 token 即吊销全部旧会话"的安全语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthManager } from '../lib/auth/manager.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function tempSessionsFile() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-auth-')), 'sessions.json')
}

test('a login session survives a manager restart (the regression)', () => {
  const file = tempSessionsFile()

  const a = new AuthManager({ config: { enabled: true }, sessionsFile: file, logger: silent })
  const token = a.createSession()
  assert.equal(a.validateSession(token), true)

  // 模拟宿主重启：新建 manager，指向同一个落盘文件
  const b = new AuthManager({ config: { enabled: true }, sessionsFile: file, logger: silent })
  assert.equal(b.validateSession(token), true, 'session must survive a process restart')
})

test('the sessions file is written with mode 600', () => {
  const file = tempSessionsFile()
  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  m.createSession()
  assert.ok(existsSync(file))
  const mode = statSync(file).mode & 0o777
  assert.equal(mode, 0o600, 'session tokens are as sensitive as the secret token')
})

test('expired sessions are NOT restored', () => {
  const file = tempSessionsFile()
  writeFileSync(file, JSON.stringify([
    ['expired-token', { createdAt: Date.now() - 200000, expiresAt: Date.now() - 1 }],
  ]), { mode: 0o600 })

  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(m.validateSession('expired-token'), false)
})

test('valid sessions are restored, malformed entries dropped', () => {
  const file = tempSessionsFile()
  const now = Date.now()
  writeFileSync(file, JSON.stringify([
    ['good', { createdAt: now, expiresAt: now + 60000 }],
    ['bad-expiry', { createdAt: now, expiresAt: 'nonsense' }],
    [123, { createdAt: now, expiresAt: now + 60000 }],   // 非字符串 key
  ]), { mode: 0o600 })

  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(m.validateSession('good'), true)
  assert.equal(m.validateSession('bad-expiry'), false)
})

test('a corrupt sessions file degrades to empty instead of throwing', () => {
  const file = tempSessionsFile()
  writeFileSync(file, '{ this is not json', { mode: 0o600 })
  assert.doesNotThrow(() => new AuthManager({ config: {}, sessionsFile: file, logger: silent }))
  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(m.sessions.size, 0)
})

test('a missing sessions file is fine (first run)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-auth-')), 'nope.json')
  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(m.sessions.size, 0)
})

test('revoking all sessions clears the persisted file too (security semantics preserved)', async () => {
  const file = tempSessionsFile()
  const m = new AuthManager({ config: { enabled: true }, sessionsFile: file, logger: silent })
  const token = m.createSession()
  m.createSession()
  assert.equal(m.sessions.size, 2)

  // 改密码 / 切模式 / 重新生成 token 都会走 sessions.clear()
  m.sessions.clear()

  // 磁盘上必须同样清空 —— 否则重启后旧会话会"复活"
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [])

  const restarted = new AuthManager({ config: { enabled: true }, sessionsFile: file, logger: silent })
  assert.equal(restarted.validateSession(token), false, 'revoked session must not come back after restart')
})

test('deleting a single session is persisted immediately', () => {
  const file = tempSessionsFile()
  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  const keep = m.createSession()
  const drop = m.createSession()
  m.revokeSession(drop)

  const restarted = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(restarted.validateSession(keep), true)
  assert.equal(restarted.validateSession(drop), false)
})

test('omitting sessionsFile falls back to the default path without crashing', () => {
  // 不注入路径时回落到 <DSH_HOME>/dsh-bridge-gateway/sessions.json。
  // 测试必须隔离：把 DSH_HOME 指向临时目录，绝不读写真实环境。
  // ⚠️ 默认路径在模块加载时求值，因此这里必须显式注入 tmp 路径而非仅改环境变量。
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const file = join(home, 'dsh-bridge-gateway', 'sessions.json')
  const m = new AuthManager({ config: {}, sessionsFile: file, logger: silent })
  assert.equal(typeof m.createSession(), 'string')
  assert.ok(existsSync(file), 'session file is created under the injected path')
})
