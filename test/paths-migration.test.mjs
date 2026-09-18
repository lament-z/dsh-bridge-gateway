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
