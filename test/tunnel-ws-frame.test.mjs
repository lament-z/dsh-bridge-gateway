// 自建隧道 WebSocket 帧层 Ping/Pong 回归测试
//
// 背景：隧道是裸 TCP 字节转发，WebSocket 的 Ping/Pong 是协议层控制帧，不会被自动应答。
// DSH API Gateway 每 2s 发一次 Ping，收不到 Pong 就 terminate —— 表现为隧道频繁断连。
// 修复：在帧层拦截 Ping (0x9) 自动回 Pong (0xA)，其余帧原样转发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CustomTunnelClient } from '../lib/tunnel-client.mjs'

// 只测帧解析：构造一个不启动连接的实例，替换依赖
function makeClient() {
  const c = Object.create(CustomTunnelClient.prototype)
  c.sent = []
  c._sendMessage = (m) => c.sent.push(m)
  c.localWsSockets = new Map()
  return c
}

// 记录 sock.write 的假 socket
function fakeSock() {
  const writes = []
  return { writes, write: (b) => { writes.push(Buffer.from(b)); return true }, destroyed: false }
}

// 构造一个未分片的 WebSocket 帧
function buildFrame(opcode, payload, { masked = false } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let hdr
  if (p.length < 126) {
    hdr = Buffer.alloc(2)
    hdr[1] = p.length
  } else if (p.length < 65536) {
    hdr = Buffer.alloc(4)
    hdr[1] = 126
    hdr.writeUInt16BE(p.length, 2)
  } else {
    hdr = Buffer.alloc(10)
    hdr[1] = 127
    hdr.writeBigUInt64BE(BigInt(p.length), 2)
  }
  hdr[0] = 0x80 | opcode
  if (!masked) return Buffer.concat([hdr, p])

  // client→server 方向的帧必须 mask
  const mask = Buffer.from([1, 2, 3, 4])
  const body = Buffer.alloc(p.length)
  for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i % 4]
  const out = Buffer.concat([hdr, mask, body])
  out[1] |= 0x80
  return out
}

test('Ping (0x9) from server is answered with a MASKED Pong (0xA)', () => {
  const c = makeClient()
  const sock = fakeSock()
  const ping = buildFrame(0x9, 'hi')          // 服务端→客户端，未 mask

  const rest = c._processWsFrames('ws1', ping, sock)

  assert.equal(rest.length, 0, 'entire ping frame should be consumed')
  // 不应转发给远端（这是控制帧）
  assert.equal(c.sent.length, 0, 'ping must not be forwarded as a data frame')
  // 应回一个 Pong
  assert.equal(sock.writes.length, 1)
  const pong = sock.writes[0]
  assert.equal(pong[0], 0x8a, 'FIN + opcode 0xA (pong)')
  assert.ok(pong[1] & 0x80, 'client→server frames MUST be masked (else ws lib closes with 1002)')
  assert.equal(pong[1] & 0x7f, 2, 'pong payload length mirrors the ping payload')
  // 解回 payload
  const mask = pong.subarray(2, 6)
  const payload = Buffer.from([pong[6] ^ mask[0], pong[7] ^ mask[1]])
  assert.equal(payload.toString(), 'hi')
})

test('a normal data frame is forwarded untouched', () => {
  const c = makeClient()
  const sock = fakeSock()
  const frame = buildFrame(0x1, 'hello')

  const rest = c._processWsFrames('ws1', frame, sock)

  assert.equal(rest.length, 0)
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].type, 'ws-frame')
  assert.equal(c.sent[0].wsId, 'ws1')
  assert.deepEqual(Buffer.from(c.sent[0].data, 'base64'), frame)
  assert.equal(sock.writes.length, 0, 'data frames must not trigger a pong')
})

test('partial frame stays buffered until the rest arrives', () => {
  const c = makeClient()
  const sock = fakeSock()
  const frame = buildFrame(0x1, 'a'.repeat(200))   // 用 126 长度分支

  const firstHalf = frame.subarray(0, 50)
  const rest1 = c._processWsFrames('ws1', firstHalf, sock)
  assert.equal(rest1.length, 50, 'incomplete frame is retained')
  assert.equal(c.sent.length, 0, 'nothing forwarded yet')

  const rest2 = c._processWsFrames('ws1', Buffer.concat([rest1, frame.subarray(50)]), sock)
  assert.equal(rest2.length, 0)
  assert.equal(c.sent.length, 1)
  assert.deepEqual(Buffer.from(c.sent[0].data, 'base64'), frame)
})

test('multiple frames in one chunk are all processed', () => {
  const c = makeClient()
  const sock = fakeSock()
  const chunk = Buffer.concat([
    buildFrame(0x9, 'p1'),      // ping → pong
    buildFrame(0x1, 'data1'),   // 转发
    buildFrame(0x9, 'p2'),      // ping → pong
    buildFrame(0x1, 'data2'),   // 转发
  ])

  const rest = c._processWsFrames('ws1', chunk, sock)

  assert.equal(rest.length, 0)
  assert.equal(sock.writes.length, 2, 'two pongs for two pings')
  assert.equal(c.sent.length, 2, 'two data frames forwarded')
  assert.equal(Buffer.from(c.sent[0].data, 'base64').toString('utf8').includes('data1'), true)
  assert.equal(Buffer.from(c.sent[1].data, 'base64').toString('utf8').includes('data2'), true)
})

test('a large ping (>65535 payload) still produces a valid masked pong', () => {
  const c = makeClient()
  const sock = fakeSock()
  const big = Buffer.alloc(70000, 7)
  const ping = buildFrame(0x9, big)

  const rest = c._processWsFrames('ws1', ping, sock)

  assert.equal(rest.length, 0)
  assert.equal(sock.writes.length, 1)
  const pong = sock.writes[0]
  assert.equal(pong[0], 0x8a)
  assert.equal(pong[1], 0x80 | 127, '64-bit length form used')
  assert.ok(pong.length > 70000)
})
