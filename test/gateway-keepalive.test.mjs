// test/gateway-keepalive.test.mjs
//
// 覆盖公网直连网关（ProxyServer）的三处安全相关行为：
//   1. 未通过鉴权的 WebSocket upgrade 必须被拒绝，并留下带来源 IP 的访问日志
//   2. 静默的长连接必须被应用层保活回收（先 ping 探活，收不到回音即销毁）
//   3. 只要客户端还有任何入向字节，就绝不允许误杀活跃连接
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ProxyServer } from '../lib/index.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 找一个空闲端口 */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 上游 DSH web 的替身：对任意 upgrade 都回 101，并记录所有 socket 以便收尾时干净关闭 */
function startUpstream() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  const sockets = new Set()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      async close() {
        for (const s of sockets) s.destroy()
        await new Promise((r) => server.close(r))
      },
    }))
  })
}

/**
 * 手工完成一次 WebSocket 握手（不走 ws 库），返回裸 socket。
 * 关键点：这个连接不会自动回 pong，用来模拟「对端静默消失」。
 */
function rawWsHandshake(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        socket.off('data', onData)
        resolve(socket)
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
    setTimeout(() => reject(new Error('握手超时')), 5000).unref?.()
  })
}

/** 轮询等待某类访问日志出现（日志是异步落盘的） */
async function waitForLog(file, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const hit = lines.filter(predicate)
      if (hit.length) return hit
    } catch { /* 文件还没建出来 */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  return []
}

/**
 * 起一套「上游替身 + 网关 + 临时 DSH_HOME」，跑完 fn 后无条件回收所有句柄，
 * 免得断言失败时残留 socket 把整个测试进程吊住。
 */
async function withGateway(authManager, fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gw-test-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const upstream = await startUpstream()
  const port = await freePort()
  const proxy = new ProxyServer({
    localPort: port,
    targetPort: upstream.port,
    authManager,
    logger: silentLogger,
    tag: '测试',
  })
  const clients = []
  await proxy.start()
  try {
    await fn({
      proxy,
      port,
      home,
      logFile: join(home, 'dsh-bridge', 'access.log'),
      open: (socket) => {
        clients.push(socket)
        return socket
      },
    })
  } finally {
    for (const c of clients) c.destroy()
    await proxy.stop().catch(() => {})
    await upstream.close().catch(() => {})
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
}

test('网关：未授权 upgrade 被拒绝，并写入带来源 IP 的访问日志', { timeout: 15000 }, async () => {
  await withGateway({ verifyRequest: () => ({ authenticated: false }) }, async ({ proxy, port, logFile }) => {
    // 手工发一个未授权 upgrade，期望拿到 401
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${port}\r\n`
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
          + 'Sec-WebSocket-Version: 13\r\n\r\n',
        )
      })
      let buf = ''
      socket.on('data', (c) => { buf += c.toString('latin1') })
      socket.on('close', () => resolve(buf.split('\r\n')[0]))
      socket.on('error', reject)
    })

    assert.match(status, /401/)
    assert.equal(proxy.wsSockets.size, 0, '被拒绝的连接不得进入台账')

    const denied = await waitForLog(logFile, (e) => e.ev === 'ws-denied')
    assert.equal(denied.length, 1, '被拒绝的 upgrade 必须留痕')
    assert.equal(denied[0].ip, '127.0.0.1', '日志必须记录来源 IP')
  })
})

test('网关：静默长连接先 ping 探活，收不到回音即回收', { timeout: 15000 }, async () => {
  const stubAuth = { verifyRequest: () => ({ authenticated: true, sessionToken: 'stub' }) }
  await withGateway(stubAuth, async ({ proxy, port, home, logFile, open }) => {
    const client = open(await rawWsHandshake(port))
    await new Promise((r) => setTimeout(r, 100))

    assert.equal(proxy.wsSockets.size, 1, 'upgrade 成功后应登记台账')
    const conn = [...proxy.wsSockets.values()][0]
    assert.equal(conn.ip, '127.0.0.1')
    assert.equal(conn.via, 'session')

    // 把「最后收到入向字节」的时间往前拨，模拟静默超过阈值
    conn.lastInboundAt = Date.now() - 10 * 60 * 1000
    const frames = []
    client.on('data', (c) => frames.push(...c))

    proxy.healthTick()
    await new Promise((r) => setTimeout(r, 100))

    assert.ok(
      frames.some((b, i) => b === 0x89 && frames[i + 1] === 0x00),
      '静默连接应当收到 WebSocket ping 控制帧',
    )
    assert.ok(conn.pingSentAt > 0, '应当进入探活状态')
    assert.equal(proxy.wsSockets.size, 1, '探活阶段还不能回收')

    // 客户端始终不回 pong —— 把发 ping 的时刻也往前拨，模拟等待超时
    conn.pingSentAt = Date.now() - 10 * 60 * 1000
    proxy.healthTick()

    const closes = await waitForLog(logFile, (e) => e.ev === 'ws-close')
    assert.equal(closes.length, 1, '死链回收必须留下 ws-close 日志')
    assert.equal(closes[0].reason, 'dead-peer', '回收原因应记为 dead-peer')
    assert.equal(closes[0].ip, '127.0.0.1')
    assert.ok(typeof closes[0].durSec === 'number' && typeof closes[0].rx === 'number')
    assert.equal(proxy.wsSockets.size, 0, '死链必须从台账移除')
    assert.ok(home.length > 0)
  })
})

test('网关：有入向字节的活跃连接不会被误杀', { timeout: 15000 }, async () => {
  const stubAuth = { verifyRequest: () => ({ authenticated: true, fromToken: true }) }
  await withGateway(stubAuth, async ({ proxy, port, open }) => {
    const client = open(await rawWsHandshake(port))
    await new Promise((r) => setTimeout(r, 100))

    const conn = [...proxy.wsSockets.values()][0]
    assert.equal(conn.via, 'token', '鉴权方式应当被记入台账')

    // 先静默到该发 ping 的程度
    conn.lastInboundAt = Date.now() - 10 * 60 * 1000
    proxy.healthTick()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(conn.pingSentAt > 0, '应当已发出探活 ping')

    // 模拟客户端回了 pong（任意入向字节）
    client.write(Buffer.from([0x8a, 0x00]))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(conn.pingSentAt, 0, '收到入向字节后必须解除探活状态')

    proxy.healthTick()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(proxy.wsSockets.size, 1, '活跃连接不得被回收')
  })
})
