// test/auth-manager.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { AuthManager } from '../lib/auth/manager.js'
import { renderLoginPage } from '../lib/auth/login-template.js'

test('AuthManager initializes and generates default secretToken', () => {
  const auth = new AuthManager()
  assert.equal(auth.enabled, false)
  assert.equal(auth.mode, 'token_and_password')
  assert.ok(auth.secretToken.startsWith('dsh_'))
  assert.equal(auth.hasPassword, false)
  auth.dispose()
})

test('AuthManager setPassword hashes with salt and verifies correctly', async () => {
  const persisted = []
  const auth = new AuthManager({
    onPersist: (p) => persisted.push(p),
  })

  await auth.setPassword('my-secret-123')
  assert.equal(auth.hasPassword, true)
  assert.ok(auth.passwordHash)
  assert.ok(auth.passwordSalt)
  assert.equal(persisted.length, 1)

  // Verify correct password
  const okResult = auth.verifyPassword('my-secret-123', '192.168.1.50')
  assert.equal(okResult.success, true)

  // Verify incorrect password
  const failResult = auth.verifyPassword('wrong-password', '192.168.1.50')
  assert.equal(failResult.success, false)
  assert.equal(failResult.error, '访问密码错误')

  auth.dispose()
})

test('AuthManager rate limits and locks out IP after 5 consecutive failures', () => {
  const auth = new AuthManager()
  auth.setPassword('correct-pwd')

  const testIp = '10.0.0.99'
  assert.equal(auth.isIpBlocked(testIp), false)

  for (let i = 0; i < 4; i++) {
    const res = auth.verifyPassword('wrong', testIp)
    assert.equal(res.success, false)
    assert.equal(auth.isIpBlocked(testIp), false)
  }

  // 5th attempt triggers lockout
  const res5 = auth.verifyPassword('wrong', testIp)
  assert.equal(res5.success, false)
  assert.equal(auth.isIpBlocked(testIp), true)

  // 6th attempt is blocked immediately
  const res6 = auth.verifyPassword('correct-pwd', testIp)
  assert.equal(res6.success, false)
  assert.ok(res6.error.includes('尝试次数过多'))

  auth.dispose()
})

test('AuthManager session lifecycle: create, validate, and revoke', () => {
  const auth = new AuthManager()
  const token = auth.createSession(5000)
  assert.ok(token)
  assert.equal(auth.validateSession(token), true)
  assert.equal(auth.validateSession('non-existent-token'), false)

  auth.revokeSession(token)
  assert.equal(auth.validateSession(token), false)
  auth.dispose()
})

test('AuthManager verifyRequest handles bypass, loopback, token, and cookie', () => {
  const auth = new AuthManager({
    config: {
      enabled: true,
      mode: 'token_and_password',
      secretToken: 'dsh_test_token_123',
    },
  })

  // 1. Loopback bypass (127.0.0.1)
  const loopbackReq = {
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3082' },
  }
  assert.equal(auth.verifyRequest(loopbackReq).authenticated, true)
  assert.equal(auth.verifyRequest(loopbackReq).loopback, true)

  // 2. External IP without token or cookie -> Unauthorized
  const externalReq = {
    url: '/',
    socket: { remoteAddress: '192.168.1.100' },
    headers: { host: '192.168.1.50:3082' },
  }
  assert.equal(auth.verifyRequest(externalReq).authenticated, false)

  // 3. External IP with valid ?auth=token -> Authorized from token
  const tokenReq = {
    url: '/?auth=dsh_test_token_123',
    socket: { remoteAddress: '192.168.1.100' },
    headers: { host: '192.168.1.50:3082' },
  }
  const tokenRes = auth.verifyRequest(tokenReq)
  assert.equal(tokenRes.authenticated, true)
  assert.equal(tokenRes.fromToken, true)

  // 4. External IP with valid session cookie -> Authorized
  const sessionToken = auth.createSession(60000)
  const cookieReq = {
    url: '/chat',
    socket: { remoteAddress: '192.168.1.100' },
    headers: {
      host: '192.168.1.50:3082',
      cookie: `dsh_bridge_auth=${sessionToken}; other=123`,
    },
  }
  const cookieRes = auth.verifyRequest(cookieReq)
  assert.equal(cookieRes.authenticated, true)
  assert.equal(cookieRes.sessionToken, sessionToken)

  // 5. Disabled auth -> Bypass
  auth.enabled = false
  assert.equal(auth.verifyRequest(externalReq).authenticated, true)
  assert.equal(auth.verifyRequest(externalReq).bypass, true)

  auth.dispose()
})

test('renderLoginPage returns valid standalone HTML with DSH styling', () => {
  const html = renderLoginPage({ hasPassword: true })
  assert.ok(html.includes('DeepSeek Harness'))
  assert.ok(html.includes('远程安全访问认证'))
  assert.ok(html.includes('/__dsh_bridge__/login'))
  assert.ok(html.includes('input type="password"'))
})

// ---------------------------------------------------------------------------
// 登录页重设计（A′ 门厅式）回归护栏
// ---------------------------------------------------------------------------
// 这里既有正向断言（新行为必须成立），也有反向断言（旧缺陷不得复发）。
// 反向断言比正向更值钱：它们钉死的是"曾经真的发生过"的具体回归。

test('renderLoginPage 使用 DSH 品牌资产而非通用盾牌', () => {
  const html = renderLoginPage({ hasPassword: true })
  // DSH 官方鲸鱼标（FISH_LOGO_PATH 的 viewBox），由 brand-assets.js 提供
  assert.ok(html.includes('viewBox="0 0 23.16 17.04"'), '应内联 DSH 鲸鱼标')
  // DSH 的招牌游动动效（SVG SMIL，Chrome 100 原生可用，无需 polyfill）
  assert.ok(html.includes('<animate'), '应包含 SMIL 游动关键帧')
  assert.ok(html.includes('HERO') === false, '不应把内部常量名泄漏到页面')
})

test('renderLoginPage 反向断言：不得再用 DSH 成功色当品牌主色', () => {
  const html = renderLoginPage({ hasPassword: true })
  // #22c55e 是 DSH 的 --dsw-alias-state-success-primary（成功色）。
  // 旧版登录页把它当成品牌主色，语义用错 —— 这个回归必须钉死。
  assert.ok(!html.includes('#22c55e'), '不得出现成功色 #22c55e')
  // 主 CTA 应为 DSH 业务蓝
  assert.ok(html.includes('#4176e6'), '主 CTA 应使用 DSH 业务蓝 #4176e6')
})

test('renderLoginPage 反向断言：不得引入 Chrome 100 不支持的 CSS', () => {
  const html = renderLoginPage({ hasPassword: true })
  // 只扫 <style> 段：鲸鱼路径是 3448 字符的 SVG path data，在整页上做子串匹配
  // 会误报（例如将来换一帧、路径里恰好出现 "dvh"）。CSS 禁区只在样式里成立。
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  assert.ok(style.length > 1000, '应能截取到样式段')
  // color-mix() 尤其危险：DSH token 表里有别名用它定义，旧内核上整条声明失效，
  // 变量解析为空 —— 不是降级，是文字直接消失。
  for (const forbidden of ['color-mix(', 'dvh', ':has(', '@container', 'light-dark(', '@starting-style']) {
    assert.ok(!style.includes(forbidden), `样式段不得使用 Chrome 100 不支持的 ${forbidden}`)
  }
  // JS 侧同样不得用旧内核没有的 API
  for (const forbidden of ['Promise.withResolvers', 'AbortSignal.any', 'toSorted', 'structuredClone']) {
    assert.ok(!html.includes(forbidden), `不得使用旧内核没有的 ${forbidden}`)
  }
})

test('renderLoginPage 零外部请求（登录页是公网第一触面）', () => {
  const html = renderLoginPage({ hasPassword: true })
  // 除页脚仓库链接外，不得有任何外链；尤其不得引 CDN 或品牌字体
  const external = html.match(/https?:\/\/[^"'\s)]+/g) || []
  assert.equal(external.length, 1, `只允许页脚仓库链接，实际: ${external.join(', ')}`)
  assert.ok(external[0].includes('github.com/lament-z/dsh-bridge-gateway'))
  assert.ok(!/fonts\.googleapis|cdn\.|unpkg|jsdelivr/i.test(html), '不得引任何 CDN')
})

test('renderLoginPage 按认证模式渲染，消灭两条死路', () => {
  // token_only：密码接口本就拒绝登录，渲染密码框等于让人对着必然失败的表单猜
  const tokenOnly = renderLoginPage({ mode: 'token_only', hasPassword: true })
  assert.ok(!tokenOnly.includes('input type="password"'), 'token_only 不得渲染密码框')
  assert.ok(tokenOnly.includes('专属安全 Token'), 'token_only 应给出 Token 获取指引')

  // password_only 且未设密码：同样是死路，应改为引导卡
  const needsSetup = renderLoginPage({ mode: 'password_only', hasPassword: false })
  assert.ok(!needsSetup.includes('input type="password"'), '未设密码时不得渲染密码框')
  assert.ok(needsSetup.includes('尚未设置访问密码'))

  // 默认模式（token_and_password）仍须渲染密码框
  const normal = renderLoginPage({ mode: 'token_and_password', hasPassword: true })
  assert.ok(normal.includes('input type="password"'))
})

test('renderLoginPage 锁定态：置灰提交并给出倒计时', () => {
  const html = renderLoginPage({ locked: true, lockRemainingMs: 42000 })
  assert.ok(/id="submitBtn" class="cta" disabled/.test(html), '锁定态提交按钮必须 disabled')
  assert.ok(html.includes('id="lockCountdown"'), '锁定态应含倒计时锚点')
  assert.ok(html.includes('disabled'), '锁定态输入框也应禁用')

  // #alert 必须无条件存在：倒计时结束后用户仍可能提交失败，届时靠它显示错误
  const unlocked = renderLoginPage({ locked: false })
  assert.ok(unlocked.includes('id="alert"'), '#alert 必须始终存在')
  assert.ok(unlocked.includes('id="alertMsg"'))
})

test('renderLoginPage 锁定提示只在"有表单可提交且确实还在锁定期"时出现', () => {
  const hasCountdown = (h) => h.includes('id="lockCountdown"')
  const isDisabled = (h) => /id="submitBtn" class="cta" disabled/.test(h)

  // token_only / 未设密码：压根没有可提交的东西，提示"稍后重试"是误导；
  // 且倒计时元素在引导卡里根本不存在，硬渲染会永久挂一句"请在 -- 秒后重试"
  for (const opts of [
    { mode: 'token_only', locked: true, lockRemainingMs: 30000 },
    { mode: 'password_only', hasPassword: false, locked: true, lockRemainingMs: 30000 },
  ]) {
    const html = renderLoginPage(opts)
    assert.ok(!hasCountdown(html), `${opts.mode} 下不得渲染倒计时元素`)
    assert.ok(!html.includes('>--<'), '不得留下悬空的 -- 占位')
    assert.ok(!html.includes('尝试次数过多'), '无可提交内容时不应提示重试')
  }

  // 剩余时长为 0 / 非法 = 锁已到期，按未锁定处理，而不是兜底成一个凭空的 60 秒
  for (const bad of [0, NaN, -5000, undefined, null, 'abc']) {
    const html = renderLoginPage({ locked: true, lockRemainingMs: bad })
    assert.ok(!hasCountdown(html), `lockRemainingMs=${String(bad)} 不应启动倒计时`)
    assert.ok(!isDisabled(html), `lockRemainingMs=${String(bad)} 不应置灰（锁已到期）`)
  }

  // 正常锁定：置灰 + 倒计时，且用绝对截止时间而非累减
  const locked = renderLoginPage({ locked: true, lockRemainingMs: 42000 })
  assert.ok(hasCountdown(locked) && isDisabled(locked))
  assert.ok(locked.includes('"lockActive":true'))
  assert.ok(locked.includes('deadline = Date.now()'), '倒计时应基于绝对截止时间，避免后台标签页节流漂移')
})

test('renderLoginPage 救急路径只对本机/局域网可见', () => {
  const remote = renderLoginPage({ isLocal: false })
  assert.ok(!remote.includes('reset-auth'), '不得向匿名公网访客披露宿主内部路径')
  assert.ok(remote.includes('请联系部署者'))

  const local = renderLoginPage({ isLocal: true })
  assert.ok(local.includes('reset-auth'), '本机/局域网应能看到救急指令')
})

test('renderLoginPage 页脚品牌名与版本号', () => {
  const html = renderLoginPage({ version: '9.9.9' })
  assert.ok(html.includes('dsh-bridge-gateway'), '页脚应为完整包名')
  assert.ok(html.includes('v9.9.9'), '页脚应显示版本号便于远程报障')
  assert.ok(html.includes('非 DeepSeek 官方产品'), '第三方网关应有非官方声明')
  // 反向断言：旧版页脚锚文本错写成 dsh-bridge（同类 bug 已发作过一次）
  assert.ok(!/>dsh-bridge</.test(html), '锚文本不得再是裸 dsh-bridge')

  const noVersion = renderLoginPage({})
  assert.ok(!noVersion.includes('v9.9.9'))
  assert.ok(!/守护\s*·\s*v/.test(noVersion), '未传版本号时不应留下悬空的分隔符')
})

test('renderLoginPage 副标题随防护范围变化（scope 是活参数）', () => {
  assert.ok(renderLoginPage({ scope: 'all' }).includes('远程安全访问认证'))
  assert.ok(renderLoginPage({ scope: 'public_only' }).includes('公网访问认证'))
  assert.ok(renderLoginPage({ scope: 'lan_only' }).includes('局域网访问认证'))
})

test('renderLoginPage 无障碍基线', () => {
  const html = renderLoginPage({ hasPassword: true })
  assert.ok(html.includes('aria-label="显示密码"'), '眼睛按钮需要 aria-label（旧版只有 title）')
  assert.ok(html.includes('aria-pressed="false"'))
  assert.ok(html.includes('role="alert"'), '错误提示需要 role=alert')
  assert.ok(html.includes('aria-expanded="false"'), '折叠帮助区需要 aria-expanded')
  assert.ok(html.includes('for="password"'), 'label 需要与输入框关联')
  // 页脚不再用 rgba(255,255,255,.35)（对比度约 2.6:1，不达 WCAG AA），改走 token
  assert.ok(html.includes('var(--gw-label-3)'))
})

test('renderLoginPage 动效受 prefers-reduced-motion 门控，且不在触屏上自动聚焦', () => {
  const html = renderLoginPage({ hasPassword: true })

  // 动效门控：SMIL 用 begin="indefinite" 默认不跑，只有 JS 在
  // prefers-reduced-motion: no-preference 时才 beginElement()。
  // 浏览器实测（Chrome headless）：reduce 下 focus/hover 均不启动；
  // no-preference 下两者都启动。此处用静态断言守住这段门控逻辑不被删掉。
  assert.ok(html.includes('begin="indefinite"'), 'SMIL 必须默认不启动')
  assert.ok(
    html.includes("matchMedia('(prefers-reduced-motion: reduce)')"),
    '必须读取 prefers-reduced-motion'
  )
  assert.ok(html.includes('beginElement'), '必须通过 beginElement() 显式启动')

  // 自动聚焦必须受 (hover: hover) and (pointer: fine) 门控 ——
  // 触屏上立刻弹键盘会把版面顶飞。因此不得用 HTML 的 autofocus 属性。
  assert.ok(!/\bautofocus\b/.test(html), '不得使用 HTML autofocus 属性')
  assert.ok(html.includes("(hover: hover) and (pointer: fine)"), '自动聚焦需按指针能力门控')
})

test('renderLoginPage 主题跟随系统，默认亮色（DSH 自身默认亮色）', () => {
  const html = renderLoginPage({ hasPassword: true })
  // 默认亮色写在 :root，暗色走媒体查询 —— 无 JS 也正确，避免旧版"深绿 → 纯白"硬切
  assert.ok(html.includes('@media (prefers-color-scheme: dark)'), '暗色需由媒体查询驱动')
  assert.ok(html.includes(":root[data-gw-theme='dark']"), '需保留显式主题覆盖入口')
  // 每个 token 都必须带静态 hex 兜底：登录页跑在 DSH 之前，--dsw-* 并不存在
  assert.ok(/var\(--dsw-[a-z0-9-]+, #[0-9a-f]{3,8}\)/.test(html), 'token 必须带静态兜底')
})

test('renderLoginPage 对注入与异常入参的抵抗', () => {
  const evil = '<script>alert(1)</script>" onload="alert(2)'

  // 服务端数据拼进 HTML 必须转义。登录页是公网第一触面，XSS 在这里等于直接失守。
  for (const key of ['version', 'scope', 'mode']) {
    const html = renderLoginPage({ [key]: evil })
    assert.ok(!html.includes('<script>alert(1)</script>'), `${key} 不得原样注入 script`)
    assert.ok(!html.includes('onload="alert(2)"'), `${key} 不得原样注入事件属性`)
  }

  // 异常 lockRemainingMs 应回落到"已到期"（0），而不是兜底成一个凭空的 60 秒
  for (const bad of [NaN, -5, 0, undefined, null, 'abc']) {
    const html = renderLoginPage({ locked: true, lockRemainingMs: bad })
    assert.ok(html.includes('"lockMs":0'), `lockRemainingMs=${String(bad)} 应回落 0（已到期）`)
    assert.ok(html.includes('"lockActive":false'), `lockRemainingMs=${String(bad)} 不应判定为锁定期`)
  }
  // 合法值（含数字字符串）应被采用
  assert.ok(renderLoginPage({ locked: true, lockRemainingMs: '47000' }).includes('"lockMs":47000'))
  assert.ok(renderLoginPage({ locked: true, lockRemainingMs: 47000 }).includes('"lockMs":47000'))

  // 未知 mode 应回落到"有密码表单"这一最保守形态，而不是渲染空白页
  assert.ok(renderLoginPage({ mode: 'bogus' }).includes('input type="password"'))
  // 全 null 入参不得抛错
  assert.ok(renderLoginPage({
    mode: null, scope: null, hasPassword: null, locked: null,
    lockRemainingMs: null, isLocal: null, version: null,
  }).includes('input type="password"'))
})

test('AuthManager.lockRemainingMs 返回剩余锁定时间且不改动状态', () => {
  const auth = new AuthManager({ config: { enabled: true } })
  const ip = '203.0.113.9'

  // 未锁定
  assert.equal(auth.lockRemainingMs(ip), 0)
  assert.equal(auth.lockRemainingMs(''), 0)

  // 累计失败至封禁
  for (let i = 0; i < 5; i += 1) auth.recordFailedAttempt(ip)
  assert.equal(auth.isIpBlocked(ip), true)

  const remain = auth.lockRemainingMs(ip)
  assert.ok(remain > 0 && remain <= 60 * 1000, `剩余时间应在 (0, 60000]，实际 ${remain}`)

  // 只读：连续读取不应消耗/清除锁定
  assert.ok(auth.lockRemainingMs(ip) > 0)
  assert.equal(auth.isIpBlocked(ip), true)

  // 过期后归零并顺带清理
  auth.rateLimits.set(ip, { failedCount: 5, lockUntil: Date.now() - 1 })
  assert.equal(auth.lockRemainingMs(ip), 0)
  assert.equal(auth.rateLimits.has(ip), false)

  auth.dispose()
})

test('AuthManager handles adminPolicy and remote admin unlocking', async () => {
  const auth = new AuthManager({
    config: {
      enabled: true,
      adminPolicy: 'password_unlock',
    },
  })

  await auth.setPassword('access-pass-111')
  await auth.setAdminPassword('admin-pass-222')
  assert.equal(auth.adminPolicy, 'password_unlock')
  assert.equal(auth.hasPassword, true)
  assert.equal(auth.hasAdminPassword, true)

  // 1. Access password cannot unlock admin when adminPassword is set
  const failRes1 = auth.unlockAdmin('access-pass-111', '192.168.1.88')
  assert.equal(failRes1.ok, false)

  // 2. Correct admin password returns valid adminToken
  const okRes = auth.unlockAdmin('admin-pass-222', '192.168.1.88')
  assert.equal(okRes.ok, true)
  assert.ok(okRes.adminToken)
  assert.equal(auth.validateAdminSession(okRes.adminToken), true)

  // 3. Changing admin policy invalidates admin session
  await auth.setAdminPolicy('local_only')
  assert.equal(auth.validateAdminSession(okRes.adminToken), false)

  // 4. In local_only mode, unlockAdmin is rejected
  const localOnlyRes = auth.unlockAdmin('admin-pass-222', '192.168.1.88')
  assert.equal(localOnlyRes.ok, false)
  assert.ok(localOnlyRes.error.includes('仅限电脑本机'))

  auth.dispose()
})

