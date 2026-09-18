// 老用户升级兼容性测试
//
// 涉及两处"改名后老用户必须仍能工作"的场景：
//   1. RPC 通道名（/dsh-bridge → /dsh-bridge-gateway）
//      —— 通道名会被内联进浏览器 bundle，升级后**已缓存的旧 bundle** 仍打旧路径。
//         服务端必须同时注册新旧两条路径，否则这些客户端全部 404
//         （表现为「升级后设置页所有按钮点了没反应」）。
//   2. cloudflared 缓存目录（~/.dsh-bridge → ~/.dsh-bridge-cloudflared）
//      —— 迁移后应免于重新下载 39MB 二进制。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNEL_LEGACY, BRIDGE_RPC_CHANNELS,
  BRIDGE_ENDPOINTS,
} from '../lib/bridge-rpc-constants.js'

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

test('cloudflared migration is idempotent and never throws in the real environment', async () => {
  const { migrateLegacyCloudflaredDir, cloudflaredDir, legacyCloudflaredDir } =
    await import('../lib/paths.js')

  // 该函数基于真实 HOME（无注入点），因此这里只断言"幂等 + 绝不抛出"这两条
  // 与用户环境无关的性质；文件级迁移语义由 paths-migration.test.mjs 用临时目录覆盖。
  const r1 = migrateLegacyCloudflaredDir({ logger: silent })
  const r2 = migrateLegacyCloudflaredDir({ logger: silent })
  assert.equal(r2.migrated, false, 'second run must be a no-op')
  assert.equal(typeof r1.reason, 'string')
  assert.doesNotThrow(() => migrateLegacyCloudflaredDir({ logger: silent }))

  assert.ok(cloudflaredDir().includes('.dsh-bridge-cloudflared'))
  assert.ok(legacyCloudflaredDir().includes('.dsh-bridge'))
  assert.notEqual(cloudflaredDir(), legacyCloudflaredDir())
})

test('cloudflared bin dir is derived from the new cache dir', async () => {
  const { cloudflaredBinDir, cloudflaredDir } = await import('../lib/paths.js')
  assert.equal(cloudflaredBinDir(), join(cloudflaredDir(), 'bin'))
})

test('CloudflaredManager defaults its home to the new cache dir', async () => {
  const { CloudflaredManager } = await import('../lib/cloudflared-manager.mjs')
  const { cloudflaredDir } = await import('../lib/paths.js')
  const m = new CloudflaredManager({ port: 3080, logger: silent })
  assert.equal(m.home, cloudflaredDir())
  assert.ok(!m.home.endsWith('/.dsh-bridge'), 'must not fall back to the legacy dir')
})

test('an explicit home still wins (backward-compatible constructor contract)', async () => {
  const { CloudflaredManager } = await import('../lib/cloudflared-manager.mjs')
  const m = new CloudflaredManager({ port: 3080, home: '/custom/home', logger: silent })
  assert.equal(m.home, '/custom/home')
})
