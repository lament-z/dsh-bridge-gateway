// Release 正文来源的回归测试。
//
// 背景：scripts/create-github-release.mjs 里从 CHANGELOG 取版本正文的那条分支曾经是
// 死代码 —— 它按 `## [v<version>]` 找标题，而本仓 CHANGELOG 写的是 `## [<version>]`
// （无 v 前缀），于是恒返回空串，Release 正文实际一直来自 package.json 的 releaseNotes。
//
// 这里把「两种标题写法都要认」和「找不到就老实返回空串」钉住，免得哪天又静默退化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractChangelogForVersion } from '../scripts/create-github-release.mjs'

const FIXTURE = `# 更新日志 (Changelog)

## [1.2.3] - 2026-01-01

### 修复：本仓风格（标题无 v 前缀）

正文甲。

## [v1.2.2] - 2025-12-01

正文乙。

## [1.2.1] - 2025-11-01

正文丙。
`

test('finds an entry whose heading has no v prefix (this repo\'s actual style)', () => {
  const body = extractChangelogForVersion('1.2.3', FIXTURE)
  assert.match(body, /本仓风格/)
  assert.match(body, /正文甲/)
})

test('also finds the v-prefixed heading form', () => {
  const body = extractChangelogForVersion('1.2.2', FIXTURE)
  assert.match(body, /正文乙/)
})

test('stops at the next version heading (no bleed-through)', () => {
  const body = extractChangelogForVersion('1.2.3', FIXTURE)
  assert.doesNotMatch(body, /正文乙/)
  assert.doesNotMatch(body, /正文丙/)
  assert.doesNotMatch(body, /^## \[/m, 'the version heading itself must not be part of the body')
})

test('returns an empty string for an unknown version', () => {
  assert.equal(extractChangelogForVersion('9.9.9', FIXTURE), '')
})

test('escapes regex metacharacters in the version', () => {
  // `1x2x3` 不能被当成 `1.2.3` 的正则而命中
  assert.equal(extractChangelogForVersion('1x2x3', FIXTURE), '')
})

test('the real CHANGELOG yields a body for the current package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const body = extractChangelogForVersion(pkg.version, changelog)
  assert.notEqual(body, '', `CHANGELOG.md must carry an entry for v${pkg.version}`)
  // 断言必须**与版本解耦**：这里只校验"取到的是这个版本的真实正文"，
  // 不校验具体内容 —— 曾经写成 `assert.match(body, /旧内核/)`（写测试时当前版本是
  // 0.2.2），于是每次升版本都会红，属于把版本和内容硬绑在一起的定时炸弹。
  assert.match(body, /^### /m, 'entry body should contain at least one ### section')
  assert.ok(body.length > 100, 'entry body looks too short to be real')
  assert.ok(
    !/^## \[/m.test(body),
    'entry body must not swallow the next version heading',
  )
})

test('a pinned historical entry still yields its own content', () => {
  // 内容校验钉在**历史版本**上：它不会随版本升级而失效，同时仍能守住提取逻辑
  // （一旦取错段落、或把下一节吞进来，这条就会红）。
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const body = extractChangelogForVersion('0.2.2', changelog)
  assert.match(body, /旧内核/, 'the 0.2.2 entry must describe the legacy-kernel fix')
  assert.ok(!/^## \[/m.test(body), 'must stop at the next version heading')
})

test('releaseNotes must be updated together with the version', () => {
  // releaseNotes **优先于** CHANGELOG 正文用于 GitHub Release（见 create-github-release.mjs）。
  // 升版本时若忘了改它，Release 会静默显示上一版的说明 —— 不报错，只是内容错了。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(
    pkg.releaseNotes,
    new RegExp(`【dsh-bridge-gateway ${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}】`),
    `releaseNotes 必须以【dsh-bridge-gateway ${pkg.version}】开头（升版本时同步更新）`,
  )
})

test('releaseNotes wins over the CHANGELOG body (curated text is preferred)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // 复刻 createRelease() 的取值顺序
  const notes = pkg.releaseNotes || extractChangelogForVersion(pkg.version) || 'fallback'
  assert.equal(notes, pkg.releaseNotes)
  assert.match(notes, /【dsh-bridge-gateway /, 'releaseNotes keeps the 【name version】 header')
})
