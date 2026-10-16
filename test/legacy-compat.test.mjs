// 老用户升级兼容性测试
//
// 涉及两处"改名后老用户必须仍能工作"的场景：
//   1. RPC 通道名（/dsh-bridge → /dsh-bridge-gateway）
//      —— 通道名会被内联进浏览器 bundle，升级后**已缓存的旧 bundle** 仍打旧路径。
//         服务端必须同时注册新旧两条路径，否则这些客户端全部 404
//         （表现为「升级后设置页所有按钮点了没反应」）。
//   2. cloudflared 缓存目录（两级迁移链）
//      ~/.dsh-bridge/ → ~/.dsh-bridge-cloudflared/ → ~/.dsh-bridge-gateway-cloudflared/
//      —— 迁移后应免于重新下载 39MB 二进制；两个历史名都要能被追到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNEL_LEGACY, BRIDGE_RPC_CHANNELS,
  BRIDGE_ENDPOINTS,
} from '../lib/bridge-rpc-constants.js'
import { LEGACY_BROWSER_POLYFILL } from '../lib/index.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

// ---------------------------------------------------------------------------
// 1. RPC 通道名兼容
// ---------------------------------------------------------------------------

test('the current channel is renamed to match the package', () => {
  assert.equal(BRIDGE_RPC_CHANNEL, '/dsh-bridge-gateway')
})

test('the legacy channel is still declared for old cached bundles', () => {
  assert.equal(BRIDGE_RPC_CHANNEL_LEGACY, '/dsh-bridge')
})

test('BRIDGE_RPC_CHANNELS covers both, current first (preferred order)', () => {
  assert.deepEqual(BRIDGE_RPC_CHANNELS, ['/dsh-bridge-gateway', '/dsh-bridge'])
  assert.equal(BRIDGE_RPC_CHANNELS[0], BRIDGE_RPC_CHANNEL, 'current channel must be first')
})

test('endpoint vocabulary is unchanged (no wire breakage)', () => {
  // 通道名变了，但端点名必须保持 —— 否则老客户端仍会打不存在的端点
  for (const key of ['getStatus', 'authGetStatus', 'platformSetConfig', 'restartDsh']) {
    assert.equal(typeof BRIDGE_ENDPOINTS[key], 'string', `${key} must remain a string endpoint`)
  }
})

test('installBridgeRpc registers BOTH channels so old bundles keep working', async () => {
  const { installBridgeRpc } = await import('../lib/bridge-rpc.js')
  const registered = []
  const ctx = {
    connection: {},
    webServer: {},
    effect: (f) => f(),
    inject(_deps, fn) {
      fn({
        connection: {},
        webServer: {
          register: (route) => {
            registered.push(route.path)
            return () => {}
          },
        },
        effect: (f) => f(),
      })
      return { dispose() {} }
    },
  }
  installBridgeRpc(ctx, { logger: silent, authManager: null, platformManager: null })

  // 两条路径都必须注册；只注册一条会让另一侧的客户端失效
  assert.ok(registered.includes('/dsh-bridge-gateway'), 'current channel must be registered')
  assert.ok(registered.includes('/dsh-bridge'), 'legacy channel must be registered for cached bundles')
})

// ---------------------------------------------------------------------------
// 2. cloudflared 缓存目录迁移
// ---------------------------------------------------------------------------

test('cloudflared migration is idempotent and never throws', async () => {
  const { migrateLegacyCloudflaredDir, cloudflaredDir, legacyCloudflaredDirs } =
    await import('../lib/paths.js')

  // 必须在**隔离的 HOME** 里跑。cloudflared 目录基于 os.homedir()，若用真实 HOME，
  // 这个用例会真的去重命名用户家目录下的缓存目录 —— 测试不该动用户文件。
  // （Node 在 POSIX 上让 os.homedir() 读 $HOME，所以注入 HOME 是有效的。）
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-cf-idem-'))
  const prevHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    // 先造一个中间名历史目录，让首次调用真的发生迁移
    mkdirSync(join(fakeHome, '.dsh-bridge-cloudflared', 'bin'), { recursive: true })
    writeFileSync(join(fakeHome, '.dsh-bridge-cloudflared', 'bin', 'cloudflared'), 'x')

    const r1 = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r1.migrated, true)
    const r2 = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r2.migrated, false, 'second run must be a no-op')
    assert.equal(r2.reason, 'already-migrated')
    assert.equal(typeof r1.reason, 'string')
    assert.doesNotThrow(() => migrateLegacyCloudflaredDir({ logger: silent }))
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(fakeHome, { recursive: true, force: true })
  }

  // 路径形状与 HOME 无关，可以在真实环境下断言
  assert.ok(cloudflaredDir().includes('.dsh-bridge-gateway-cloudflared'))
  const legacy = legacyCloudflaredDirs()
  assert.equal(legacy.length, 2)
  assert.ok(legacy[0].includes('.dsh-bridge-cloudflared'))
  assert.ok(legacy[1].endsWith('/.dsh-bridge'))
  assert.ok(!legacy.includes(cloudflaredDir()))
})

test('cloudflared 迁移链按"从新到旧"排列（改错顺序会让老用户白等一次重下载）', async () => {
  const { CLOUDFLARED_DIR_NAME, LEGACY_CLOUDFLARED_DIR_NAMES, cloudflaredDir, legacyCloudflaredDirs } =
    await import('../lib/paths.js')

  assert.equal(CLOUDFLARED_DIR_NAME, '.dsh-bridge-gateway-cloudflared')
  // 顺序即迁移优先级：先找最近一次改名前的名字，再往上追到上游沿用名
  assert.deepEqual([...LEGACY_CLOUDFLARED_DIR_NAMES], ['.dsh-bridge-cloudflared', '.dsh-bridge'])
  assert.deepEqual(
    legacyCloudflaredDirs(),
    LEGACY_CLOUDFLARED_DIR_NAMES.map((n) => join(homedir(), n)),
  )
  // 当前名不得混进历史列表，否则迁移会自己撞自己
  assert.ok(!LEGACY_CLOUDFLARED_DIR_NAMES.includes(CLOUDFLARED_DIR_NAME))
  assert.ok(!legacyCloudflaredDirs().includes(cloudflaredDir()))
})

test('cloudflared bin dir is derived from the new cache dir', async () => {
  const { cloudflaredBinDir, cloudflaredDir, cloudflaredBinDirs, legacyCloudflaredDirs } =
    await import('../lib/paths.js')
  assert.equal(cloudflaredBinDir(), join(cloudflaredDir(), 'bin'))
  // 清理（重置隧道）要覆盖当前 + 全部历史目录，否则迁移失败的残留删不掉
  assert.deepEqual(
    cloudflaredBinDirs(),
    [cloudflaredDir(), ...legacyCloudflaredDirs()].map((d) => join(d, 'bin')),
  )
})

test('CloudflaredManager defaults its home to the new cache dir', async () => {
  const { CloudflaredManager } = await import('../lib/cloudflared-manager.mjs')
  const { cloudflaredDir } = await import('../lib/paths.js')
  const m = new CloudflaredManager({ port: 3080, logger: silent })
  assert.equal(m.home, cloudflaredDir())
  assert.ok(!m.home.endsWith('/.dsh-bridge'), 'must not fall back to the upstream dir')
  assert.ok(!m.home.endsWith('/.dsh-bridge-cloudflared'), 'must not fall back to the intermediate dir')
})

test('an explicit home still wins (backward-compatible constructor contract)', async () => {
  const { CloudflaredManager } = await import('../lib/cloudflared-manager.mjs')
  const m = new CloudflaredManager({ port: 3080, home: '/custom/home', logger: silent })
  assert.equal(m.home, '/custom/home')
})

// ---------------------------------------------------------------------------
// 3. 旧内核浏览器兜底 polyfill（注入 index.html <head> 的那段脚本）
// ---------------------------------------------------------------------------
// 背景：Chrome 108（统信 UOS / 360 浏览器）缺三个较新的 Web API，页面表现为
// 「外壳出得来、工作区永远加载不了」。注入脚本必须在剥离了这三个 API 的沙箱里
// 把它们补齐，且在原生齐全的沙箱里一个字节都不改。
//
// 沙箱约定：AbortSignal 在"旧内核"场景下用一个普通对象替身 —— polyfill 只在
// 这个对象上安装 any()，而信号实例仍来自真正的 AbortController，于是既构造出了
// 「没有 AbortSignal.any」的现场，又完全不必改动宿主进程的全局对象。
// 注意跨 realm：沙箱里造出来的对象/数组原型与宿主不同，deepEqual(strict) 会因
// 原型不同而失败，所以断言前一律先 spread 成宿主对象。

const makeSandbox = (legacy) => {
  const sandbox = { AbortController, AbortSignal: legacy ? {} : AbortSignal }
  vm.createContext(sandbox)
  if (legacy) {
    vm.runInContext('delete Promise.withResolvers; delete Array.prototype.toSorted;', sandbox)
  }
  return sandbox
}

const grab = (sandbox, expr) => ({ ...vm.runInContext(expr, sandbox) })

const TYPEOFS = '({ pwr: typeof Promise.withResolvers, any: typeof AbortSignal.any, ts: typeof Array.prototype.toSorted })'
const IDENTITY = '({ pwr: Promise.withResolvers, any: AbortSignal.any, ts: Array.prototype.toSorted })'

test('polyfill fills exactly the three APIs a Chrome 108 kernel lacks', () => {
  const sandbox = makeSandbox(true)
  assert.deepEqual(grab(sandbox, TYPEOFS), { pwr: 'undefined', any: 'undefined', ts: 'undefined' })
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  assert.deepEqual(grab(sandbox, TYPEOFS), { pwr: 'function', any: 'function', ts: 'function' })
})

test('polyfill never overrides native implementations', () => {
  const sandbox = makeSandbox(false)
  const before = grab(sandbox, IDENTITY)
  assert.deepEqual(grab(sandbox, TYPEOFS), { pwr: 'function', any: 'function', ts: 'function' })
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const after = grab(sandbox, IDENTITY)
  assert.equal(after.pwr, before.pwr, 'Promise.withResolvers must stay native')
  assert.equal(after.any, before.any, 'AbortSignal.any must stay native')
  assert.equal(after.ts, before.ts, 'Array.prototype.toSorted must stay native')
})

test('polyfill is idempotent (a second run is a no-op)', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const first = grab(sandbox, IDENTITY)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const second = grab(sandbox, IDENTITY)
  assert.equal(second.pwr, first.pwr)
  assert.equal(second.any, first.any)
  assert.equal(second.ts, first.ts)
})

test('polyfilled Promise.withResolvers wires resolve and reject', async () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)

  const ok = await vm.runInContext(
    '(function () { var d = Promise.withResolvers(); d.resolve(7); return d.promise })()',
    sandbox
  )
  assert.equal(ok, 7)

  await assert.rejects(
    vm.runInContext(
      '(function () { var d = Promise.withResolvers(); d.reject(new Error("boom")); return d.promise })()',
      sandbox
    ),
    /boom/
  )
})

test('polyfilled AbortSignal.any: empty list is never aborted', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  assert.equal(vm.runInContext('AbortSignal.any([]).aborted', sandbox), false)
})

test('polyfilled AbortSignal.any: an already-aborted member wins immediately', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const r = grab(
    sandbox,
    '(function () { var c = new AbortController(); c.abort("why"); var s = AbortSignal.any([c.signal]); return { aborted: s.aborted, reason: s.reason } })()'
  )
  assert.equal(r.aborted, true)
  assert.equal(r.reason, 'why')
})

test('polyfilled AbortSignal.any: aborting any member aborts the composite with its reason', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const r = grab(
    sandbox,
    '(function () { var a = new AbortController(), b = new AbortController(); var s = AbortSignal.any([a.signal, b.signal]); b.abort("second"); return { aborted: s.aborted, reason: s.reason, untouched: a.signal.aborted } })()'
  )
  assert.equal(r.aborted, true)
  assert.equal(r.reason, 'second')
  assert.equal(r.untouched, false, 'the other member must not be aborted by composition')
})

test('polyfilled AbortSignal.any rejects non-signal members', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  // 跨 realm 的 TypeError 与宿主 TypeError 不同源，故按消息断言
  assert.throws(() => vm.runInContext('AbortSignal.any([{}])', sandbox), /not an AbortSignal/)
})

test('polyfilled Array.prototype.toSorted copies instead of mutating', () => {
  const sandbox = makeSandbox(true)
  vm.runInContext(LEGACY_BROWSER_POLYFILL, sandbox)
  const r = grab(
    sandbox,
    '(function () { var a = [3, 1, 2]; var s = a.toSorted(); var d = a.toSorted(function (x, y) { return y - x }); return { s: s, d: d, a: a } })()'
  )
  assert.deepEqual([...r.s], [1, 2, 3])
  assert.deepEqual([...r.d], [3, 2, 1], 'comparator must be honoured')
  assert.deepEqual([...r.a], [3, 1, 2], 'the receiver must be left untouched')
})
