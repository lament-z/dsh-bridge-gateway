// scripts/verify-mobile-header.mjs
// ---------------------------------------------------------------------------
// 验证注入式移动端顶栏不会在宽屏「无样式」地露出来
// ---------------------------------------------------------------------------
// 背景（2026-10-16 实测复现）：
//   client/index.js 的 setupMobileExperience() 会无条件创建 <header
//   class="dsh-mobile-app-header">（☰ / 当前会话标题 / ⊕）并 append 到 <body>，
//   而它的**全部样式**都写在 @media (max-width: 768px) 里，宽屏只靠末尾一条
//   `@media (min-width: 769px) { display: none !important }` 藏起来。
//   于是样式表晚到、被卸载，或页面处于重连/热更中途时，这个无样式的块级元素会
//   落进侧边栏栅格 —— 表现为左下角一堆被裁切的图标。
//
// 本脚本验证三条：
//   1. 宽屏：顶栏不可见
//   2. 宽屏 + 主动移除注入的样式表（模拟失败态）：顶栏**仍然**不可见  ← 核心
//   3. 窄屏：顶栏正常显示（不能修过头把移动端也藏了）
//
// 前置：本机 dsh web 正在 127.0.0.1:3080 服务，且存在 ~/.dsh/.credentials.yaml。
// 用法：
//   node scripts/verify-mobile-header.mjs
// 退出码：0 = 全部通过；1 = 有失败项。
// ---------------------------------------------------------------------------
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_VERIFY_PORT ?? 3080)
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 复刻 lib/index.js 的 getDshLoopbackCookie()：用本机凭证签一个合法的 dsh-auth
 * Cookie，才能以浏览器身份加载 DSH 自身的 UI（直接访问 3080 会 401）。
 */
function mintDshAuthCookie(port) {
  const b64u = (v) => Buffer.from(v).toString('base64url')
  const cred = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const secret = Buffer.from(/secret:\s*([A-Za-z0-9_-]+)/.exec(cred)[1], 'base64url')
  const authority = `127.0.0.1:${port}`
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now() - 1000
  const body = b64u(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 3600 * 1000,
  }), 'utf8'))
  const sig = b64u(createHmac('sha256', secret).update(body).digest())
  return { name, value: `v1.${body}.${sig}`, domain: '127.0.0.1', path: '/' }
}

const results = []
const check = (name, ok, extra = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `   [${extra}]` : ''}`)
}

async function probe(browser, cookie, width) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 900 })
  await page.setCookie(cookie)
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 5000))
  const out = await page.evaluate(() => {
    const el = document.querySelector('.dsh-mobile-app-header')
    if (!el) return { exists: false }
    const visible = () => {
      const r = el.getBoundingClientRect()
      return getComputedStyle(el).display !== 'none' && r.height > 0
    }
    const before = { visible: visible(), display: getComputedStyle(el).display, inline: el.style.display }
    // 模拟"样式表缺失"这一失败态
    const removed = []
    document.querySelectorAll('style[id]').forEach((s) => {
      if (String(s.id).includes('mobile-styles')) { s.remove(); removed.push(s.id) }
    })
    const after = { visible: visible(), display: getComputedStyle(el).display, inline: el.style.display }
    return { exists: true, bound: el.dataset.dshVisibilityBound === '1', removed, before, after }
  })
  await page.close()
  return out
}

async function main() {
  let browser
  try {
    const cookie = mintDshAuthCookie(PORT)
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })

    const wide = await probe(browser, cookie, 1342)
    check('宽屏能找到顶栏元素', wide.exists === true)
    check('已绑定可见性兜底（内联 display + matchMedia 同步）', wide.bound === true)
    check('宽屏 1342px：顶栏不可见', wide.before?.visible === false, JSON.stringify(wide.before))
    check('宽屏 + 样式表移除：顶栏仍不可见（本脚本的核心断言）',
      wide.after?.visible === false,
      `移除=${JSON.stringify(wide.removed)} display=${wide.after?.display}`)

    const narrow = await probe(browser, cookie, 700)
    check('窄屏 700px：顶栏正常显示（不能把移动端也藏了）', narrow.before?.visible === true, JSON.stringify(narrow.before))
    check('窄屏下内联值已让开，交还给 CSS', narrow.before?.inline === '', `inline=${JSON.stringify(narrow.before?.inline)}`)
  } catch (err) {
    check(`执行异常：${err?.message ?? err}`, false)
  } finally {
    await browser?.close()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n失败: ${failed} / ${results.length}`)
  process.exit(failed ? 1 : 0)
}

await main()
