// scripts/generate-icons.mjs
// ---------------------------------------------------------------------------
// 把 DSH 鲸鱼图标渲染成各尺寸 PNG（主屏图标用）
// ---------------------------------------------------------------------------
// 为什么必须有 PNG（2026-10-16 用户在华为 Mate 80 / HarmonyOS 上实测）：
//   网关此前只在 manifest 里声明了 `image/svg+xml` 图标，并把
//   /apple-touch-icon.png 也返回 SVG。**移动端浏览器/启动器普遍不支持 SVG
//   图标**（HarmonyOS 与多数 Android 启动器只认 PNG），结果是"添加到桌面"后
//   图标一片空白。iOS 的 apple-touch-icon 同样只认 PNG。
//
// 产物提交进仓库（assets/），运行期由 lib/index.js 直接读文件返回，
// 不在请求路径上做图形转换。
//
// 用法：
//   node scripts/generate-icons.mjs
// 依赖：本机 Chrome（可用 PUPPETEER_EXECUTABLE_PATH 覆盖路径）
// ---------------------------------------------------------------------------
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pwaIconSvg } from '../lib/auth/brand-assets.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'assets')
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 需要产出的尺寸与形态。maskable 用于启动器自行裁形的场景。 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS 的 apple-touch-icon 惯例尺寸；HarmonyOS/Android 不用它但留着无害
  { file: 'apple-touch-icon-180.png', size: 180, maskable: false },
]

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  try {
    for (const { file, size, maskable } of TARGETS) {
      const svg = pwaIconSvg({ maskable })
      const page = await browser.newPage()
      // 以目标尺寸为视口、deviceScaleFactor 1，截图即为 1:1 像素
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
      await page.setContent(
        `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`,
        { waitUntil: 'load' },
      )
      const buf = await page.screenshot({ type: 'png', omitBackground: true })
      await page.close()
      writeFileSync(join(OUT_DIR, file), buf)
      console.log(`  ✓ ${file}  ${size}×${size}  ${buf.length} bytes  ${maskable ? '(maskable 满幅)' : '(圆角)'}`)
    }
  } finally {
    await browser.close()
  }
  console.log(`\n已写入 ${OUT_DIR}`)
}

await main()
