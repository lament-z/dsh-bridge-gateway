// test/login-page-branding.test.mjs
// ---------------------------------------------------------------------------
// 登录页品牌一致性、响应头与"兼容性遗留标识"的护栏测试
// ---------------------------------------------------------------------------
// 这一组测的不是"新功能能不能用"，而是三类**具体发生过或极易发生**的回归：
//
//   1. 品牌名写成 dsh-bridge（同类 bug 已在数据目录上发作过一次，见 lib/paths.js 头注释）
//   2. 登录页 HTML 没禁缓存（本仓库对代理 DSH HTML 早已强制 no-store）
//   3. 有人"顺手把旧名改干净"，打断老用户的数据目录迁移与旧客户端回落通道
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProxyServer, resolveLoginPageIsLocal } from '../lib/index.js'
import { AuthManager } from '../lib/auth/manager.js'
import { renderLoginPage } from '../lib/auth/login-template.js'
import { TOKEN_TABLE, renderTokenCss } from '../lib/auth/theme-tokens.js'
import { BRAND_ASSET_SOURCE, FISH_LOGO_VIEWBOX, whaleSvg } from '../lib/auth/brand-assets.js'
import { createHash } from 'node:crypto'
import { LEGACY_DATA_DIR_NAME, LEGACY_CLOUDFLARED_DIR_NAMES } from '../lib/paths.js'
import { BRIDGE_RPC_CHANNEL_LEGACY, BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNELS } from '../lib/bridge-rpc-constants.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf8')

function doRequest(options) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
          // 二进制响应（图标 PNG）必须留原始字节：按 utf8 转会把魔数破坏掉
          buffer: buf,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** 起一个最小可用的 ProxyServer（带鉴权），返回 { proxy, proxyPort, close } */
async function startProxy({ mode = 'token_and_password' } = {}) {
  const backend = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><head></head><body>DSH</body></html>')
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const backendPort = backend.address().port

  const authManager = new AuthManager({
    config: { enabled: true, mode, allowLoopback: false },
  })
  await authManager.setPassword('mypassword')

  const proxy = new ProxyServer({
    localPort: 0,
    targetPort: backendPort,
    authManager,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  await proxy.start()
  const proxyPort = proxy.server.address().port

  return {
    proxy,
    proxyPort,
    close: async () => {
      await proxy.stop()
      await new Promise((resolve) => backend.close(resolve))
      authManager.dispose()
    },
  }
}

test('登录页 401 响应必须禁缓存并带安全响应头', async () => {
  const { proxyPort, close } = await startProxy()
  try {
    const res = await doRequest({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/',
      headers: { Accept: 'text/html' },
    })

    assert.equal(res.statusCode, 401)
    assert.match(String(res.headers['content-type']), /text\/html/)
    // 登录页内嵌锁定态与认证模式，被缓存会导致"改了页面不变"——本仓库已经踩过一次
    assert.match(String(res.headers['cache-control']), /no-store/)
    assert.equal(res.headers['pragma'], 'no-cache')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')

    // CSP 纵深防御。connect-src 'self' 绝不能漏 —— 登录靠 fetch 提交，
    // default-src 'none' 下漏掉它会让认证直接失效。
    const csp = String(res.headers['content-security-policy'])
    assert.ok(csp.includes("default-src 'none'"), 'CSP 应有 default-src none')
    assert.ok(csp.includes("connect-src 'self'"), "CSP 必须允许同源 fetch（connect-src 'self'）")
    assert.ok(csp.includes("form-action 'none'"))
    assert.ok(csp.includes("frame-ancestors 'none'"))
    assert.ok(csp.includes("base-uri 'none'"))

    // 页面本身带上品牌与版本号
    assert.ok(res.body.includes('dsh-bridge-gateway'))
    assert.ok(res.body.includes('DeepSeek Harness'))
  } finally {
    await close()
  }
})

test('e2e：连续失败导致 IP 锁定后，登录页必须真的渲染锁定态', async () => {
  const { proxyPort, close } = await startProxy()
  try {
    // 连续 5 次错误密码 → 触发 AuthManager 的 60 秒封禁
    for (let i = 0; i < 5; i += 1) {
      await doRequest({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/__dsh_bridge__/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ password: 'definitely-wrong' }))
    }

    const res = await doRequest({
      host: '127.0.0.1', port: proxyPort, path: '/', headers: { Accept: 'text/html' },
    })
    assert.equal(res.statusCode, 401)
    // 这条钉的是"服务端算好了锁定态、页面真的渲染出来"这整段接线
    assert.ok(res.body.includes('id="lockCountdown"'), '锁定后应渲染倒计时元素')
    assert.ok(/id="submitBtn" class="cta" disabled/.test(res.body), '锁定后提交按钮应置灰')
    assert.ok(res.body.includes('"lockActive":true'), 'bootConfig 应告知前端处于锁定期')
    const m = /"lockMs":(\d+)/.exec(res.body)
    assert.ok(m && Number(m[1]) > 0 && Number(m[1]) <= 60 * 1000, `lockMs 应在 (0,60000]，实际 ${m && m[1]}`)
  } finally {
    await close()
  }
})

test('token_only 模式下登录页不渲染密码框（消灭死路）', async () => {
  const { proxyPort, close } = await startProxy({ mode: 'token_only' })
  try {
    const res = await doRequest({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/',
      headers: { Accept: 'text/html' },
    })
    assert.equal(res.statusCode, 401)
    assert.ok(!res.body.includes('input type="password"'), 'token_only 下不得出现密码框')
    assert.ok(res.body.includes('专属安全 Token'))
  } finally {
    await close()
  }
})

test('网关首触面文案里的产品名必须是 dsh-bridge-gateway', () => {
  // 范围界定：这里钉"用户第一眼看到的产品名" —— 登录页 + 两处 502 裸文本页 +
  // 落到用户磁盘的备份文件名。日志前缀另有一条独立护栏（见下一个用例）。
  const indexSrc = readSrc('lib/index.js')
  assert.ok(
    indexSrc.includes('`dsh-bridge-gateway: 无法连接插件 host 服务'),
    '插件 host 502 页应使用完整包名'
  )
  assert.ok(
    indexSrc.includes('`dsh-bridge-gateway: 无法连接 dsh web'),
    'dsh web 502 页应使用完整包名'
  )
  // 反向断言：旧的裸名不得再出现在这两处用户可见文案里
  assert.ok(
    !indexSrc.includes('`dsh-bridge: 无法连接'),
    '不得再有以 dsh-bridge: 开头的用户可见文案'
  )

  // 备份文件名：会落到用户磁盘上
  const clientSrc = readSrc('client/index.js')
  assert.ok(clientSrc.includes('dsh-bridge-gateway-backup-'), '备份文件名应使用完整包名')
  assert.ok(!/dsh-bridge-backup-/.test(clientSrc), '不得再用旧的备份文件名')
  // 构建产物必须同步，否则线上仍是旧文案（client.js 是 esbuild 产物）
  const bundle = readSrc('client/client.js')
  assert.ok(bundle.includes('dsh-bridge-gateway-backup-'), 'client.js 产物需重跑 build:client')

  // 登录页页脚锚文本
  assert.ok(!/>dsh-bridge</.test(renderLoginPage({})), '登录页锚文本不得是裸 dsh-bridge')
})

test('日志前缀必须统一为 dsh-bridge-gateway（不得回退到旧名）', () => {
  // 日志前缀是用户在 DSH 控制台 / 终端里直接看到的东西，属于产品名的一部分。
  // 这条机械护栏覆盖 lib/ 全部源码（含各 IM 平台适配器与 auth 模块）。
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(js|mjs)$/.test(entry.name)) continue
      const src = readFileSync(full, 'utf8')
      const rel = full.replace(ROOT + '/', '')
      // 旧形态一：`[dsh-bridge xxx]` / `[dsh-bridge]`
      for (const m of src.matchAll(/\[dsh-bridge(?!-gateway)[^\]]*\]/g)) {
        offenders.push(`${rel}: ${m[0]}`)
      }
      // 旧形态二：`dsh-bridge: ...`（含单/双引号与模板字面量）
      for (const m of src.matchAll(/(?<![\w./-])dsh-bridge: /g)) {
        offenders.push(`${rel}: "dsh-bridge: " 前缀`)
      }
    }
  }
  walk(join(ROOT, 'lib'))
  assert.deepEqual(offenders, [], `以下位置仍在使用旧日志前缀：\n${offenders.join('\n')}`)

  // 正向确认：新前缀确实存在于各平台适配器里（避免"全删了"也能通过）
  const feishu = readSrc('lib/feishu/gateway.js')
  assert.ok(feishu.includes('[dsh-bridge-gateway feishu]'), '飞书适配器应使用新日志前缀')
  assert.ok(readSrc('lib/index.js').includes('dsh-bridge-gateway: '), '主插件应使用新日志前缀')
})

test('登录页 token 层：定义集与使用集必须严格相等（无死 token、无未定义引用）', () => {
  const css = renderTokenCss()
  const tpl = readSrc('lib/auth/login-template.js')
  const defined = new Set([...css.matchAll(/^\s*(--gw-[a-z0-9-]+):/gm)].map((m) => m[1]))
  const used = new Set([...tpl.matchAll(/var\((--gw-[a-z0-9-]+)\)/g)].map((m) => m[1]))

  // 用了但没定义 → 在 Chrome 100 上会解析为空，文字/边框直接消失
  assert.deepEqual([...used].filter((v) => !defined.has(v)), [], '存在用了但未定义的 token')
  // 定义了但没人用 → 就是死 token（"无死参数"标准的另一面）
  assert.deepEqual([...defined].filter((v) => !used.has(v)), [], '存在定义了但没人用的 token')
  // TOKEN_TABLE 的每一项都必须落到 CSS 里
  for (const t of TOKEN_TABLE) {
    assert.ok(defined.has(`--gw-${t.name}`), `TOKEN_TABLE 的 ${t.name} 未出现在 CSS 中`)
  }
  // 快照值必须是静态色，不得引入 Chrome 100 不支持的 color-mix()
  assert.ok(!css.includes('color-mix('), 'token 值不得依赖 color-mix()')
})

test('品牌资产校验和与提取来源一致（防止静默替换）', () => {
  // BRAND_ASSET_SOURCE.checksums 若没有测试校验，就只是一句空头承诺
  const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
  const svg = whaleSvg({ size: 52 })
  const d = /<path d="([^"]+)"/.exec(svg)[1]
  assert.equal(sha(d), BRAND_ASSET_SOURCE.checksums.fish, '静态帧与声明的校验和不符')

  // 三帧必须都能在 values 里找到，且顺序是 fish;up;fish;down;fish
  const values = /values="([^"]+)"/.exec(svg)[1].split(';')
  assert.equal(values.length, 5, '游动关键帧应为 5 帧')
  assert.equal(values[0], d)
  assert.equal(values[2], d)
  assert.equal(values[4], d)
  assert.equal(sha(values[1]), BRAND_ASSET_SOURCE.checksums.swimUp, 'swimUp 校验和不符')
  assert.equal(sha(values[3]), BRAND_ASSET_SOURCE.checksums.swimDown, 'swimDown 校验和不符')

  // viewBox 声明与实际输出一致
  assert.equal(BRAND_ASSET_SOURCE.viewBox, `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`)
  assert.ok(svg.includes(`viewBox="${BRAND_ASSET_SOURCE.viewBox}"`))
})

test('游动动效的体积代价被钉住（16KB 是一行可回退的决定）', () => {
  const withSwim = whaleSvg({ size: 52 }).length
  const withoutSwim = whaleSvg({ size: 52, swim: false }).length
  const cost = withSwim - withoutSwim
  // 起始帧在 values 里重复三次，所以净成本远大于单帧的 3448 字符
  assert.ok(cost > 15000 && cost < 17500, `动效成本应约 16KB，实际 ${cost}`)
  assert.ok(!whaleSvg({ size: 52, swim: false }).includes('<animate'))
})


test('兼容性遗留标识必须保持旧名（改掉会打断老用户迁移）', () => {
  // 这三个旧名是**有意保留**的兼容入口，不是遗漏：
  //   LEGACY_DATA_DIR_NAME        —— 老用户 ~/.dsh/dsh-bridge/ 配置的迁移判定依据
  //   LEGACY_CLOUDFLARED_DIR_NAMES —— cloudflared 缓存的历史名（从新到旧）
  //   BRIDGE_RPC_CHANNEL_LEGACY   —— 未升级客户端的 RPC 回落通道
  // 有人"顺手把旧名改干净"就会静默打断迁移，因此在这里钉死。
  assert.equal(LEGACY_DATA_DIR_NAME, 'dsh-bridge')
  assert.deepEqual([...LEGACY_CLOUDFLARED_DIR_NAMES], ['.dsh-bridge-cloudflared', '.dsh-bridge'])
  assert.equal(BRIDGE_RPC_CHANNEL_LEGACY, '/dsh-bridge')
  // 新名也必须钉死具体值：只断言"两者不相等"是恒真的，抓不到有人把新名改坏
  assert.equal(BRIDGE_RPC_CHANNEL, '/dsh-bridge-gateway')
  assert.deepEqual(BRIDGE_RPC_CHANNELS, ['/dsh-bridge-gateway', '/dsh-bridge'], '新名须在前，决定客户端首选顺序')
})

test('PWA 图标与 manifest 必须与登录页同源（鲸鱼 + DSH 业务蓝）', async () => {
  const { proxyPort, close } = await startProxy()
  try {
    // ---- 图标：必须是**真 PNG** ----
    // 2026-10-16 华为 Mate 80 / HarmonyOS 实测：只声明 SVG 图标会导致"添加到桌面"
    // 后图标一片空白（HarmonyOS 与多数 Android 启动器只认 PNG）。因此这里断言
    // 内容类型与 PNG 魔数，而不只是"200 且含 svg"。
    const pngRoutes = [
      '/__dsh_bridge__/icon-192.png',
      '/__dsh_bridge__/icon-512.png',
      '/__dsh_bridge__/icon-maskable-192.png',
      '/__dsh_bridge__/icon-maskable-512.png',
      // iOS 的约定路径，同样必须是 PNG
      '/apple-touch-icon.png',
    ]
    for (const path of pngRoutes) {
      const res = await doRequest({ host: '127.0.0.1', port: proxyPort, path })
      assert.equal(res.statusCode, 200, `${path} 应可访问`)
      assert.match(String(res.headers['content-type']), /image\/png/, `${path} 必须是 image/png`)
      const magic = [...res.buffer.subarray(0, 4)]
      assert.deepEqual(magic, [0x89, 0x50, 0x4e, 0x47], `${path} 必须是真 PNG（魔数不符）`)
    }

    // 与登录页同一枚鲸鱼：比对路径片段
    const icon = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/__dsh_bridge__/pwa-icon.svg' })
    assert.equal(icon.statusCode, 200)
    assert.ok(icon.body.includes('#4176e6'), '图标底色应为 DSH 业务蓝（近黑底在深色桌面会糊成"光板"）')
    assert.ok(!icon.body.includes('#4f6ef7'), '不得再是旧的蓝色机器人脸配色')
    const login = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/', headers: { Accept: 'text/html' } })
    const fishProbe = 'M22.9168 1.43018'
    assert.ok(icon.body.includes(fishProbe), '图标应内联 DSH 鲸鱼路径')
    assert.ok(login.body.includes(fishProbe), '登录页应内联同一枚鲸鱼路径')

    // maskable 必须满幅（启动器会按自己的形状裁切，自带圆角会被裁掉一半）
    const maskable = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/__dsh_bridge__/pwa-icon.svg' })
    assert.equal(maskable.statusCode, 200)

    // ---- manifest：必须声明 PNG ----
    const manifest = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/manifest.webmanifest' })
    assert.equal(manifest.statusCode, 200)
    const parsed = JSON.parse(manifest.body)
    const pngIcons = parsed.icons.filter((i) => i.type === 'image/png')
    assert.ok(pngIcons.length >= 4, `manifest 应至少声明 4 个 PNG 图标，实际 ${pngIcons.length}`)
    assert.ok(
      parsed.icons.some((i) => i.type === 'image/png' && i.purpose === 'any' && i.sizes === '192x192'),
      'manifest 缺少 192x192 any PNG',
    )
    assert.ok(
      parsed.icons.some((i) => i.type === 'image/png' && i.purpose === 'maskable' && i.sizes === '512x512'),
      'manifest 缺少 512x512 maskable PNG',
    )
    assert.equal(parsed.icons[0].src, '/__dsh_bridge__/icon-192.png', '首个图标应为 PNG（启动器按顺序取用）')
  } finally {
    await close()
  }
})

test('resolveLoginPageIsLocal：同机反代与隧道不得被误判为本机', () => {
  // 真·宿主机物理访问（Host 指向本机）
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: true }, '127.0.0.1'), true)

  // 同机 Caddy/Nginx 反代公网流量：对端是 127.0.0.1，但 Host 是域名，
  // verifyRequest 已判 genuineLocal=false —— 这里必须随之返回 false
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: false }, '127.0.0.1'), false)
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: false }, '::1'), false)
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: false }, '::ffff:127.0.0.1'), false)

  // 公网直连
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: false }, '203.0.113.5'), false)
  assert.equal(resolveLoginPageIsLocal({ genuineLocal: false }, '2001:db8::1'), false)

  // 局域网直连：对端本身是私网地址，无需依赖 genuineLocal
  for (const lan of ['192.168.1.5', '10.0.0.7', '172.16.3.9', '172.31.255.1', '169.254.1.1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.5']) {
    assert.equal(resolveLoginPageIsLocal({}, lan), true, `${lan} 应判为局域网`)
  }
  // 边界：172.32 已不在 172.16.0.0/12 内
  assert.equal(resolveLoginPageIsLocal({}, '172.32.0.1'), false)

  // 容错：auth 为 undefined 不得抛错
  assert.equal(resolveLoginPageIsLocal(undefined, '203.0.113.5'), false)
})

test('AuthManager.verifyRequest 的 genuineLocal 语义', () => {
  const auth = new AuthManager({ config: { enabled: true, allowLoopback: false } })
  const req = (remote, host, headers = {}) => ({
    socket: { remoteAddress: remote },
    headers: { host, ...headers },
    url: '/',
  })

  // 1) 真的在宿主机上开 127.0.0.1
  assert.equal(auth.verifyRequest(req('127.0.0.1', '127.0.0.1:7443')).genuineLocal, true)
  assert.equal(auth.verifyRequest(req('127.0.0.1', 'localhost:7443')).genuineLocal, true)

  // 2) 同机反向代理：对端环回但 Host 是域名 → 不是本机（**这是关键回归点**）
  assert.equal(auth.verifyRequest(req('127.0.0.1', 'dsh.example.com')).genuineLocal, false)

  // 3) Cloudflare 隧道
  assert.equal(
    auth.verifyRequest(req('127.0.0.1', 'dsh.example.com', { 'cf-connecting-ip': '203.0.113.5', 'cf-ray': 'abc' })).genuineLocal,
    false
  )

  // 4) 自建隧道（带合法内部凭据）
  assert.equal(
    auth.verifyRequest(req('127.0.0.1', 'dsh.example.com', { 'x-dsh-internal-tunnel': auth.internalTunnelSecret })).genuineLocal,
    false
  )

  // 5) 公网直连
  assert.equal(auth.verifyRequest(req('203.0.113.5', 'dsh.example.com')).genuineLocal, false)

  // 6) 局域网直连：genuineLocal 为 false，但组合判定仍应判为本机/局域网
  const lanAuth = auth.verifyRequest(req('192.168.1.5', '192.168.1.9:7443'))
  assert.equal(lanAuth.genuineLocal, false)
  assert.equal(resolveLoginPageIsLocal(lanAuth, '192.168.1.5'), true)

  // 7) allowLoopback 打开时，真·本机应直接放行（既有行为不得被破坏）
  const auth2 = new AuthManager({ config: { enabled: true, allowLoopback: true } })
  const bypass = auth2.verifyRequest(req('127.0.0.1', '127.0.0.1:7443'))
  assert.equal(bypass.authenticated, true)
  assert.equal(bypass.loopback, true)
  // 但同机反代不得放行
  assert.equal(auth2.verifyRequest(req('127.0.0.1', 'dsh.example.com')).authenticated, false)

  auth.dispose()
  auth2.dispose()
})

test('e2e：同机反代 / 隧道请求的登录页不得包含救急路径', async () => {
  const { proxyPort, close } = await startProxy()
  try {
    const fetchLogin = (headers) => doRequest({
      host: '127.0.0.1', port: proxyPort, path: '/', headers: { Accept: 'text/html', ...headers },
    })

    // A. 真·宿主机访问（Host 指向本机）→ 应看到救急路径
    const local = await fetchLogin({ Host: `127.0.0.1:${proxyPort}` })
    assert.equal(local.statusCode, 401)
    assert.ok(local.body.includes('reset-auth'), '真·本机访问应看到救急指令')

    // B. 同机反向代理（对端 127.0.0.1，Host 是域名）→ 绝不能看到
    const proxied = await fetchLogin({ Host: 'dsh.example.com' })
    assert.equal(proxied.statusCode, 401)
    assert.ok(!proxied.body.includes('reset-auth'), '同机反代的公网流量不得看到宿主内部路径')
    assert.ok(proxied.body.includes('请联系部署者'))

    // C. Cloudflare 隧道 → 绝不能看到
    const tunneled = await fetchLogin({ Host: 'dsh.example.com', 'cf-connecting-ip': '203.0.113.5', 'cf-ray': 'abc123' })
    assert.equal(tunneled.statusCode, 401)
    assert.ok(!tunneled.body.includes('reset-auth'), '隧道流量不得看到宿主内部路径')
  } finally {
    await close()
  }
})
