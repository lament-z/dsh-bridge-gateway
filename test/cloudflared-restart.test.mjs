// Cloudflare 隧道自愈回归测试
//
// 背景（上游 issue #34）：cloudflared 在已就绪后意外退出（崩溃 / OOM / 被误杀 /
// autoupdate 自替换）时，此前只把状态置为 idle 就"死透无人管" —— 公网入口失联
// 且永不恢复。现按指数退避自动重启（5s 起步、翻倍、封顶 5min、最多 12 次）。
//
// 另：cloudflared 的 24h autoupdate 会在运行中把自身替换成新版本，导致连接静默中断
// 且版本控制权外流。已在参数层加 --no-autoupdate，并配 NO_AUTOUPDATE=true 双保险。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudflaredManager } from '../lib/cloudflared-manager.mjs'

function makeManager() {
  const states = []
  const logs = []
  const m = new CloudflaredManager({
    port: 3080,
    home: '/tmp/dsh-test-home',
    onStateChange: (s) => states.push(s),
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
      debug: () => {},
    },
  })
  // 阻止真实启动
  m._run = async () => {}
  return { m, states, logs }
}

test('schedules a restart after an unexpected exit once ready', () => {
  const { m, states } = makeManager()
  m._scheduleRestart('test crash')
  assert.equal(m._restartAttempts, 1)
  assert.ok(m._restartTimer, 'a restart timer must be armed')
  const last = states.at(-1)
  assert.equal(last.phase, 'connecting', 'surface a reconnecting state to the UI')
  assert.match(last.detail, /自动重连/)
  clearTimeout(m._restartTimer)
})

test('backoff grows exponentially and is capped', () => {
  const { m } = makeManager()
  const delays = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} } }
  try {
    for (let i = 0; i < 6; i++) m._scheduleRestart('crash')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  // 5s 起步、翻倍
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000])
})

test('gives up after the attempt ceiling and reports an error state', () => {
  const { m, states } = makeManager()
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => ({ unref() {} })
  try {
    for (let i = 0; i < 13; i++) m._scheduleRestart('crash')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.equal(m._restartAttempts, 12, 'must not exceed the ceiling')
  const last = states.at(-1)
  assert.equal(last.phase, 'error')
  assert.match(last.detail, /停止自动重连/)
})

test('stop() cancels a pending restart and resets the counter', () => {
  const { m } = makeManager()
  m._scheduleRestart('crash')
  assert.ok(m._restartTimer)
  m.stop()
  assert.equal(m._restartTimer, null, 'pending restart must be cancelled on explicit stop')
  assert.equal(m._restartAttempts, 0)
  assert.equal(m._stopped, true)
})

test('a scheduled restart is a no-op once stopped', () => {
  const { m } = makeManager()
  m._stopped = true
  m._scheduleRestart('crash')
  assert.equal(m._restartTimer, null, 'stopped manager must not arm a restart')
  assert.equal(m._restartAttempts, 0)
})

test('NO_AUTOUPDATE env is set so cloudflared cannot self-replace mid-run', async () => {
  // 直接校验构造 spawn 参数的行为：用一个假的 spawn 不现实，
  // 这里退化为确认源码里的双保险意图存在（参数层 + 环境变量层）。
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/cloudflared-manager.mjs', import.meta.url), 'utf8'),
  )
  assert.match(src, /'--no-autoupdate'/, 'must pass --no-autoupdate to cloudflared')
  assert.match(src, /NO_AUTOUPDATE:\s*'true'/, 'must also set NO_AUTOUPDATE=true')
  // 全局 flag 必须位于 run 子命令之前，否则 cloudflared 报 Incorrect Usage
  assert.match(src, /\[?'tunnel',\s*'--no-autoupdate',\s*'run'/, '--no-autoupdate must precede the run subcommand')
})
