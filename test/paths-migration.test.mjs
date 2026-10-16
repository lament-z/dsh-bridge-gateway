// 数据目录迁移测试
//
// 背景：插件 fork 后包名/loader id 都改成了 dsh-bridge-gateway，但数据目录名
// 'dsh-bridge' 是散落的硬编码字面量、没跟着改。现统一收敛到 lib/paths.js，
// 并在启动时把旧目录迁移到新目录。
//
// 迁移必须"绝不丢数据"：里面有访问密码哈希、自签证书、登录会话、隧道 token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_DIR_NAME, LEGACY_DATA_DIR_NAME,
  dshHome, dataDir, legacyDataDir, dataPath, configFile, sessionsFile,
  resetAuthFile, accessLogFile, certDir, migrateLegacyDataDir,
  LEGACY_CLOUDFLARED_DIR_NAMES, cloudflaredBinDir, cloudflaredBinDirs,
  legacyCloudflaredDirs, migrateLegacyCloudflaredDir,
} from '../lib/paths.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-paths-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

test('path helpers derive from DSH_HOME and use the renamed directory', () => {
  withHome((home) => {
    assert.equal(DATA_DIR_NAME, 'dsh-bridge-gateway')
    assert.equal(LEGACY_DATA_DIR_NAME, 'dsh-bridge')
    assert.equal(dshHome(), home)
    assert.equal(dataDir(), join(home, 'dsh-bridge-gateway'))
    assert.equal(legacyDataDir(), join(home, 'dsh-bridge'))
    assert.equal(dataPath('config.json'), join(home, 'dsh-bridge-gateway', 'config.json'))
    assert.equal(configFile(), join(home, 'dsh-bridge-gateway', 'config.json'))
    assert.equal(sessionsFile(), join(home, 'dsh-bridge-gateway', 'sessions.json'))
    assert.equal(resetAuthFile(), join(home, 'dsh-bridge-gateway', 'reset-auth'))
    assert.equal(accessLogFile(), join(home, 'dsh-bridge-gateway', 'access.log'))
    assert.equal(certDir(7443), join(home, 'dsh-bridge-gateway', 'certs', 'gateway-7443'))
  })
})

test('first run (no legacy dir) creates the new dir and reports no migration', () => {
  withHome((home) => {
    const r = migrateLegacyDataDir({ logger: silent })
    assert.equal(r.migrated, false)
    assert.equal(r.reason, 'no-legacy-dir')
    assert.ok(existsSync(join(home, 'dsh-bridge-gateway')))
  })
})

test('legacy dir is migrated, preserving every file', () => {
  withHome((home) => {
    const legacy = join(home, 'dsh-bridge')
    mkdirSync(join(legacy, 'certs', 'gateway-7443'), { recursive: true })
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ passwordHash: 'secret-hash' }))
    writeFileSync(join(legacy, 'sessions.json'), JSON.stringify([['tok', { expiresAt: Date.now() + 1000 }]]))
    writeFileSync(join(legacy, 'certs', 'gateway-7443', 'cert.pem'), 'CERT')

    const r = migrateLegacyDataDir({ logger: silent })
    assert.equal(r.migrated, true)
    assert.equal(r.reason, 'renamed')

    const now = join(home, 'dsh-bridge-gateway')
    assert.equal(JSON.parse(readFileSync(join(now, 'config.json'), 'utf8')).passwordHash, 'secret-hash')
    assert.ok(existsSync(join(now, 'sessions.json')))
    assert.equal(readFileSync(join(now, 'certs', 'gateway-7443', 'cert.pem'), 'utf8'), 'CERT')
    // 旧目录应已不存在（rename 语义）
    assert.equal(existsSync(legacy), false)
  })
})

test('migration is idempotent: an existing new dir is left untouched', () => {
  withHome((home) => {
    const legacy = join(home, 'dsh-bridge')
    const now = join(home, 'dsh-bridge-gateway')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'config.json'), '{"from":"legacy"}')
    mkdirSync(now, { recursive: true })
    writeFileSync(join(now, 'config.json'), '{"from":"new"}')

    const r = migrateLegacyDataDir({ logger: silent })
    assert.equal(r.migrated, false)
    assert.equal(r.reason, 'already-migrated')
    // 关键：绝不覆盖新目录里已有的数据
    assert.equal(JSON.parse(readFileSync(join(now, 'config.json'), 'utf8')).from, 'new')
    // 旧目录保留（用户可自行清理；不静默删除）
    assert.ok(existsSync(legacy))
  })
})

test('running migration twice is safe', () => {
  withHome((home) => {
    mkdirSync(join(home, 'dsh-bridge'), { recursive: true })
    writeFileSync(join(home, 'dsh-bridge', 'config.json'), '{"a":1}')

    const first = migrateLegacyDataDir({ logger: silent })
    const second = migrateLegacyDataDir({ logger: silent })
    assert.equal(first.migrated, true)
    assert.equal(second.migrated, false)
    assert.equal(second.reason, 'already-migrated')
    assert.equal(JSON.parse(readFileSync(join(home, 'dsh-bridge-gateway', 'config.json'), 'utf8')).a, 1)
  })
})

test('a same-named FILE at the legacy path does not break startup', () => {
  withHome((home) => {
    writeFileSync(join(home, 'dsh-bridge'), 'not a directory')
    const r = migrateLegacyDataDir({ logger: silent })
    assert.equal(r.migrated, false)
    assert.equal(r.reason, 'legacy-not-a-directory')
    // 新目录仍应可用
    assert.ok(existsSync(join(home, 'dsh-bridge-gateway')))
  })
})

test('migration failure never throws (plugin must still boot)', () => {
  withHome(() => {
    // 传一个不存在父目录的路径制造失败：把 DSH_HOME 指向一个文件
    const home = mkdtempSync(join(tmpdir(), 'dsh-paths-bad-'))
    writeFileSync(join(home, 'blocker'), 'x')
    process.env.DSH_HOME = join(home, 'blocker')
    try {
      const r = migrateLegacyDataDir({ logger: silent })
      assert.equal(r.migrated, false)
      assert.match(r.reason, /^error:|copy-failed|no-legacy-dir/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('paths honour a runtime change to DSH_HOME (lazy resolution)', () => {
  const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
  const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = a
    assert.equal(dataDir(), join(a, 'dsh-bridge-gateway'))
    process.env.DSH_HOME = b
    // 关键：路径必须重新解析，而不是在模块加载时冻结 —— 否则测试无法隔离
    assert.equal(dataDir(), join(b, 'dsh-bridge-gateway'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// cloudflared 缓存目录的两级迁移链（文件级）
// ---------------------------------------------------------------------------
// 这个名字改过两次，所以迁移必须能从**两个**历史名追到当前名：
//   ~/.dsh-bridge/                     ← 上游沿用名
//   ~/.dsh-bridge-cloudflared/         ← 第一次改名后
//   ~/.dsh-bridge-gateway-cloudflared/ ← 当前
// 少追一级，老用户就会白等一次 39MB 重下载。
//
// 注意：cloudflared 目录基于 os.homedir()（不是 DSH_HOME），所以这里改的是 HOME。
// Node 在 POSIX 上让 os.homedir() 读 $HOME，因此可以安全注入。
function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cf-home-'))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

/** 造一个"看起来已下载过"的 cloudflared 缓存目录 */
function seedCloudflared(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'cloudflared'), 'x'.repeat(64))
}

test('cloudflared 迁移链：从上游沿用名 ~/.dsh-bridge/ 追到当前名', () => {
  withFakeHome((home) => {
    seedCloudflared(join(home, '.dsh-bridge'))
    const r = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r.migrated, true)
    assert.equal(r.reason, 'renamed')
    assert.equal(r.from, join(home, '.dsh-bridge'))
    assert.equal(r.to, join(home, '.dsh-bridge-gateway-cloudflared'))
    assert.ok(existsSync(join(home, '.dsh-bridge-gateway-cloudflared', 'bin', 'cloudflared')))
    assert.ok(!existsSync(join(home, '.dsh-bridge')), '旧目录应已被 rename 走')
  })
})

test('cloudflared 迁移链：从中间名 ~/.dsh-bridge-cloudflared/ 追到当前名', () => {
  withFakeHome((home) => {
    seedCloudflared(join(home, '.dsh-bridge-cloudflared'))
    const r = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r.migrated, true)
    assert.equal(r.from, join(home, '.dsh-bridge-cloudflared'))
    assert.ok(existsSync(join(home, '.dsh-bridge-gateway-cloudflared', 'bin', 'cloudflared')))
  })
})

test('cloudflared 迁移链：优先取最近的一级，且幂等', () => {
  withFakeHome((home) => {
    // 两个历史目录同时存在（理论上少见，但必须确定性选择"从新到旧"的第一个）
    seedCloudflared(join(home, '.dsh-bridge-cloudflared'))
    seedCloudflared(join(home, '.dsh-bridge'))
    const r1 = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r1.migrated, true)
    assert.equal(r1.from, join(home, '.dsh-bridge-cloudflared'), '应优先迁移较新的历史名')
    // 更旧的那个保持原样，不被顺手删掉（它仍是用户的文件）
    assert.ok(existsSync(join(home, '.dsh-bridge')))

    const r2 = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r2.migrated, false)
    assert.equal(r2.reason, 'already-migrated')
  })
})

test('cloudflared 迁移链：没有任何历史目录时只报告，不创建目录', () => {
  withFakeHome((home) => {
    const r = migrateLegacyCloudflaredDir({ logger: silent })
    assert.equal(r.migrated, false)
    assert.equal(r.reason, 'no-legacy-dir')
    // 与数据目录迁移不同：这里不预创建 —— 没下载过就不该凭空造一个缓存目录
    assert.ok(!existsSync(join(home, '.dsh-bridge-gateway-cloudflared')))
  })
})

test('cloudflared 清理覆盖当前 + 全部历史 bin 目录', () => {
  const dirs = cloudflaredBinDirs()
  assert.equal(dirs.length, 1 + LEGACY_CLOUDFLARED_DIR_NAMES.length)
  assert.equal(dirs[0], cloudflaredBinDir())
  for (const legacy of legacyCloudflaredDirs()) {
    assert.ok(dirs.includes(join(legacy, 'bin')), `清理应覆盖 ${legacy}/bin`)
  }
})
