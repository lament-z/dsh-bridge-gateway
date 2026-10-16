// test/client-ui-guards.test.mjs
// ---------------------------------------------------------------------------
// 客户端 UI 兜底护栏（静态断言）
// ---------------------------------------------------------------------------
// 这里断言的是「某个兜底还在不在」，属于**弱检查** —— 真正的行为验证需要真实
// 浏览器与运行中的 DSH，见 scripts/verify-mobile-header.mjs（npm run verify:mobile-header）。
// 之所以还要有这一层：`npm test` 在 CI/无 Chrome 环境也要能跑，而兜底一旦被
// 「顺手删掉」在代码评审里几乎看不出来。
//
// 注意：断言必须落在**实际生效的代码/CSS** 上，不能落在整个文件上 ——
// 否则一句注释里提到同样的字符串就能把断言"满足"掉（本文件第一版就踩了这个坑）。
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSrc = readFileSync(join(ROOT, 'client/index.js'), 'utf8')
const clientBundle = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

/** 抽出真正会被注入到 <head> 的那段 CSS（而不是文件里任意提到它的地方）。 */
function injectedCss(src) {
  const marker = 'style.textContent = `'
  const start = src.indexOf(marker)
  assert.ok(start > 0, '未找到注入样式的模板字面量')
  const from = start + marker.length
  const end = src.indexOf('`;', from)
  assert.ok(end > from, '未找到模板字面量结束位置')
  return src.slice(from, end)
}



/** 抽出「真机二分用」的可疑规则分组（SUSPECT_CSS 模板字面量）。 */
function suspectCss(src) {
  const marker = 'const SUSPECT_CSS = {'
  const start = src.indexOf(marker)
  assert.ok(start > 0, '未找到 SUSPECT_CSS')
  const end = src.indexOf('\n};', start)
  assert.ok(end > start, '未找到 SUSPECT_CSS 结束')
  return src.slice(start, end)
}

/** 抽出「本轮新增/改动」的独立样式表（NEW_MOBILE_CSS）。
 *  本轮规则单独成表，是为了能用 ?dsh-mobile=no-new 二分（见 client/index.js 注释）。 */
function newMobileCss(src) {
  const marker = 'const NEW_MOBILE_CSS = `'
  const start = src.indexOf(marker)
  assert.ok(start > 0, '未找到 NEW_MOBILE_CSS 模板')
  const from = start + marker.length
  const end = src.indexOf('`;', from)
  assert.ok(end > from, '未找到 NEW_MOBILE_CSS 结束位置')
  return src.slice(from, end)
}

/** 取某个媒体查询块的内容（花括号配对，避免被注释或嵌套块截断）。 */
function mediaBlock(css, condition) {
  const start = css.indexOf(condition)
  assert.ok(start >= 0, `未找到 ${condition}`)
  let i = css.indexOf('{', start)
  assert.ok(i > 0, `${condition} 后没有 {`)
  let depth = 0
  const from = i + 1
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(from, i)
    }
  }
  assert.fail(`${condition} 的花括号未闭合`)
}

test('移动端顶栏必须有"无样式也不露出来"的内联兜底', () => {
  // 背景（2026-10-16 实测复现）：顶栏 <header class="dsh-mobile-app-header"> 被无条件
  // append 到 <body>，而它的全部样式都在 @media (max-width: 768px) 里。样式表晚到/被卸载
  // 时，无样式的块级元素会落进侧边栏栅格，表现为左下角一堆被裁切的图标。
  //
  // 兜底由两部分组成，缺一不可：
  //   1) 创建后立刻内联 display:none  —— 任何情况下都不会露出无样式块
  //   2) matchMedia 同步把窄屏的内联值让开 —— 不依赖"CSS 的 !important 压过内联"这一隐式契约
  assert.ok(
    /header\.style\.display\s*=\s*'none'\s*;/.test(clientSrc),
    'client/index.js 缺少顶栏内联 display:none 兜底'
  )
  assert.ok(
    clientSrc.includes("matchMedia('(max-width: 768px)')"),
    'client/index.js 缺少窄屏 matchMedia 同步'
  )
  assert.ok(
    clientSrc.includes('dshVisibilityBound'),
    'client/index.js 缺少重复绑定守卫（多次 apply 会叠加监听器）'
  )
  // 绑定必须在 appendChild 之后、且作用于已存在的 header（否则二次 apply 时漏绑）
  const appendIdx = clientSrc.indexOf('document.body.appendChild(header)')
  const bindIdx = clientSrc.indexOf('dshVisibilityBound')
  assert.ok(appendIdx > 0 && bindIdx > appendIdx, '兜底应紧跟在顶栏创建之后')

  // 构建产物必须同步：改了 client/index.js 忘了重跑 build:client 的话，
  // 线上仍旧是无兜底的旧行为，而源码看起来是对的。
  assert.ok(
    clientBundle.includes('dshVisibilityBound'),
    'client/client.js 未包含兜底，请重跑 npm run build:client'
  )
})

test('注入 CSS 里顶栏的三处断点必须成套（防漂移）', () => {
  // 断点必须成套，否则会出现"某段宽度既不显示、又没被 CSS 接管"的空档：
  //   JS   matchMedia('(max-width: 768px)')          —— 决定内联值是否让开
  //   CSS  @media (max-width: 768px)                 —— 窄屏完整样式
  //   CSS  @media (min-width: 769px) { display:none } —— 宽屏兜底（768 + 1）
  // 只改其中一处（例如把 CSS 挪到 900px）会静默破坏中间宽度区间。
  const css = injectedCss(clientSrc)
  const narrow = mediaBlock(css, '@media (max-width: 768px)')
  const wide = mediaBlock(css, '@media (min-width: 769px)')

  assert.ok(
    clientSrc.includes("matchMedia('(max-width: 768px)')"),
    'JS 侧断点应为 max-width: 768px'
  )
  // 窄屏块必须真的把顶栏显示出来，否则"修 bug"会变成"把移动端也藏了"
  assert.match(
    narrow,
    /\.dsh-mobile-app-header\s*\{[^}]*display:\s*flex\s*!important/s,
    '窄屏块内顶栏必须 display:flex !important，否则移动端会被一起藏掉'
  )
  // 宽屏块必须把顶栏藏起来（双保险：即使内联兜底被移除，宽屏也不该露出来）
  assert.match(
    wide,
    /\.dsh-mobile-app-header[^{]*\{[^}]*display:\s*none\s*!important/s,
    '宽屏块内顶栏必须 display:none !important'
  )
})

test('#5 不得再动 composer/scrollBody 的定位（两次尝试均破坏滚动锚定）', () => {
  // 背景：用户反馈"输入框那边永远遮挡了最新的会话"。
  // 2026-10-16 试过两次，**都已回退**：
  //   ① composerSeat 改 position:fixed + scrollBody 加 padding-bottom = composer 高度
  //      → 真机症状：进去停在很久以前某条，"加载更早"后再也回不到最新。
  //   ② 再叠加 visualViewport 算键盘高度补进 padding
  //      → 键盘没弹时该差值等于**浏览器地址栏高度**，底部凭空多出上百像素空白。
  //
  // 根因（读 DSH 源码确认）：dsh-client-ui-conversation 的滚动锚定是**按 DOM 流内
  // 位置**遍历祖先算偏移来修正 scrollTop 的。把 composer 摘出文档流、或给滚动内容
  // 加 padding，锚定就算错。
  //
  // 这个遮挡是 DSH 对话视图 sticky 吸底设计的固有代价。DSH 另有"覆盖层模式"
  // （:has([data-conversation-composer-overlay])：composerSeat 转 absolute、viewArea
  // 自己滚），但那是 dsh-client-ui-trajectory（轨迹视图）在用的，对话视图没开。
  // 要根治得走 DSH 侧。
  const css = injectedCss(clientSrc)

  const seatRules = [...css.matchAll(/div\[class\*="wSkVaW_composerSeat"\]\s*\{([^}]*)\}/g)].map((m2) => m2[1])
  for (const b of seatRules) {
    assert.ok(
      !/position:\s*(fixed|absolute)/.test(b),
      'composerSeat 不得改 position（脱离文档流会破坏 DSH 的滚动锚定）',
    )
  }

  // scrollBody 的 padding 规则现在在 SUSPECT_CSS 分组里（真机二分用），两处都要查。
  const scrollRules = [
    ...css.matchAll(/div\[class\*="wSkVaW_scrollBody"\]\s*\{([^}]*)\}/g),
    ...suspectCss(clientSrc).matchAll(/div\[class\*="wSkVaW_scrollBody"\]\s*\{([^}]*)\}/g),
  ].map((m2) => m2[1])
  assert.ok(scrollRules.length > 0, '应能查到 scrollBody 的 padding 规则（检查本身不能空转）')
  for (const b of scrollRules) {
    assert.ok(
      !/--dsh-composer-height/.test(b),
      'scrollBody 的 padding-bottom 不得含 --dsh-composer-height（会破坏滚动锚定）',
    )
  }

  // 只在「移动端增强层」里查，排除只读诊断函数 setupMobileDiag（它读 visualViewport
  // 只是为了把真机指标画在屏幕上，不参与任何布局计算）。
  const diagStart = clientSrc.indexOf('function setupMobileDiag')
  const diagEnd = diagStart > 0 ? clientSrc.indexOf('\n}\n', diagStart) : -1
  const withoutDiag = diagStart > 0 && diagEnd > diagStart
    ? clientSrc.slice(0, diagStart) + clientSrc.slice(diagEnd)
    : clientSrc
  assert.ok(
    !/window\.visualViewport/.test(withoutDiag),
    '不得再引入 visualViewport 键盘补偿（差值会把地址栏高度误当键盘）',
  )
})


test('#2 面板监听必须只观察 body 直接子节点（全文档监听会拖垮主线程）', () => {
  // 2026-10-16 踩坑并已收窄：最初写成
  //   observe(document.body, { childList: true, subtree: true, attributes: true, ... })
  // 那是全文档级监听，会话流式输出时每秒上千次回调，每次还要 getComputedStyle +
  // getBoundingClientRect（触发布局）。真机症状：滚动卡住、界面与后端不同步。
  // 面板是 body 的直接子节点（实测 depth=1），只监听直接子节点就够，开销几乎为零。
  // 只在 setupPanelAwareness 函数体内检查 —— 插件另有一个**早就存在**的
  // panelObserver（带 subtree:true）不属于本次改动范围，不能一并断言。
  const start = clientSrc.indexOf('function setupPanelAwareness')
  assert.ok(start > 0, '应有 setupPanelAwareness')
  const end = clientSrc.indexOf('\n}', start)
  const body = clientSrc.slice(start, end)
  assert.ok(
    !/subtree:\s*true/.test(body),
    'setupPanelAwareness 的监听不得用 subtree:true（全文档级回调）',
  )
  assert.match(
    body,
    /observer\.observe\(document\.body, \{ childList: true \}\)/,
    'setupPanelAwareness 应只观察 body 的直接子节点',
  )
})

test('#6 双层头必须压缩：原生头的 min-height:76px 必须被覆盖', () => {
  // 2026-10-16 真机反馈："上面高度太高了，把对话框的空间压缩了"。
  // 实测：插件顶栏 52px + 原生头 76px = 128px（屏幕的 15%）。
  // 关键在于 **DSH 自带 min-height:76px** —— 只改 padding 压不下去，titleRow 会被
  // 拉伸填满（69px）。显式清零后原生头降到 37px，内容区 +51px。
  // 顶栏高度在主样式表；min-height/titleRow 的覆盖在本轮新增表（见 no-new 开关）
  const css = newMobileCss(clientSrc)
  const baseCss = injectedCss(clientSrc)

  // 插件顶栏必须比原来的 52px 矮
  const hMatch = /--dsh-mobile-header-h:\s*(\d+)px/.exec(baseCss)
  assert.ok(hMatch, '应定义 --dsh-mobile-header-h')
  assert.ok(
    Number(hMatch[1]) <= 44,
    `顶栏高度应已压缩（当前 ${hMatch[1]}px，原为 52px）`,
  )

  // 原生头必须显式清零 min-height
  const headerRule = /header\[class\*="wSkVaW_header"\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(headerRule, '应存在原生会话头的覆盖规则')
  assert.match(
    headerRule[1],
    /min-height:\s*0/,
    '原生会话头必须 min-height:0（DSH 自带的 76px 是两层头过高的主因）',
  )

  // titleRow 必须固定高度，否则会被父级 min-height 拉伸
  const titleRowRules = [...css.matchAll(/div\[class\*="wSkVaW_titleRow"\][^{]*\{([^}]*)\}/g)].map((m) => m[1])
  assert.ok(
    titleRowRules.some((b) => /height:\s*32px/.test(b)),
    'titleRow 应固定 height:32px（否则被父级拉伸到 69px）',
  )
})

test('#3 会话名不得再读已移除的 snap.current', () => {
  // DSH 0.1.7 起 sessions list 快照不再提供 current 字段。旧实现读 snap.current
  // → 恒 undefined → 静默回落到"新会话"，标题永远不更新（且不报错，所以很难发现）。
  // 正确判据来自 DSH 自己的 publishMain：retainedBy.mainView > 0 的那一个是当前会话。
  // 注意：只匹配**代码形态**，不匹配裸字符串 —— 注释里会提到这个字段名，
  // 用 includes 会被自己的注释"满足"掉（本文件已经踩过两次这个坑）。
  assert.ok(
    !/snap\.current\s*\?/.test(clientSrc),
    '不得再读 snap.current（DSH 0.1.7 已移除该字段）',
  )
  assert.ok(
    !/snap\.byId\?\.\[snap\.current\]/.test(clientSrc),
    '不得再用 snap.byId[snap.current] 取当前会话',
  )
  assert.ok(
    clientSrc.includes('retainedBy'),
    '应改用 retainedBy.mainView 判定当前会话（与 dsh-client-ui-session 的判据一致）',
  )
  assert.match(
    clientSrc,
    /retainedBy\?\.mainView\s*\?\?\s*0\)\s*>\s*0/,
    'retainedBy.mainView 判据应写成 (> 0)',
  )
  assert.ok(clientBundle.includes('retainedBy'), '构建产物未同步，请重跑 build:client')
})

test('#4 表格必须能横向滚动（table 的 overflow 需要 display:block 才生效）', () => {
  // 2026-10-16 实测：插件原来就写了 `table { overflow-x: auto }`，但**毫无效果** ——
  // table 元素的 overflow 在 CSS 里是被忽略的，必须配 display:block 才会变成可滚块盒。
  // 结果就是轨迹视图（本身就是一张 <table>）的右列一直被硬裁。
  const css = newMobileCss(clientSrc)
  const tableRule = /div\[class\*="wSkVaW_scrollBody"\]\s+table\s*\{([^}]*)\}/.exec(css)
  assert.ok(tableRule, '应存在 scrollBody 内 table 的规则')
  assert.match(tableRule[1], /display:\s*block/, 'table 必须 display:block（否则 overflow 被忽略）')
  assert.match(tableRule[1], /overflow-x:\s*auto/, 'table 必须 overflow-x:auto')
})

test('#4 轨迹的工具调用参数必须换行（17× 宽横滑读不了）', () => {
  // 实测：resultRequest 内容宽 3049px 挤在 180px 里（17×），横滑要划 17 屏。
  // 而助手文本列是 4.5×，靠表格横滚（C）即可 —— 两列口径不同，故拆开处理。
  const css = newMobileCss(clientSrc)
  const rule = /\[class\*="resultRequest"\]\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '应存在 resultRequest 的规则')
  assert.match(rule[1], /white-space:\s*normal/, 'resultRequest 必须换行')
  assert.match(
    rule[1],
    /overflow-wrap:\s*anywhere/,
    'resultRequest 必须 overflow-wrap:anywhere（bash 命令常有超长无空格 token）',
  )
})

test('#2 面板打开时顶栏必须让位（否则盖住面板标题）', () => {
  // 实测：渠道中心面板标题「渠道中心」在 y19，而插件顶栏占 y0-40（z-index 9998
  // vs 面板 80）→ 标题被盖住。修法是面板可见时给 body 打 dsh-panel-open 并隐藏顶栏。
  // 注意：不得用 CSS :has()（构建目标是 chrome100，:has() 需要 105+）。
  const css = newMobileCss(clientSrc)
  assert.match(
    css,
    /body\.dsh-panel-open\s+\.dsh-mobile-app-header\s*\{[^}]*display:\s*none/s,
    'body.dsh-panel-open 时必须隐藏顶栏',
  )
  assert.ok(
    clientSrc.includes('setupPanelAwareness'),
    '应有 setupPanelAwareness 负责检测面板可见性',
  )
  assert.ok(
    clientSrc.includes("classList.toggle('dsh-panel-open'"),
    '应切换 body.dsh-panel-open',
  )
  // 面板根选择器必须包含 chanhub 的渠道中心
  assert.ok(
    clientSrc.includes('.dshc-center-backdrop'),
    'PANEL_SELECTORS 应包含 .dshc-center-backdrop（渠道中心）',
  )
  assert.ok(clientBundle.includes('dsh-panel-open'), '构建产物未同步，请重跑 build:client')
})

test('#7 视图下拉必须是 body 级 portal（否则被祖先 overflow:hidden 裁掉）', () => {
  // 实测：下拉原先 append 在标题行的按钮里，而祖先链 titleRow 与 wSkVaW_root 都是
  // overflow:hidden（titleRow 那条还是插件自己为了省略号设的）→ 下拉落在头部下方
  // y78 被**整块裁掉**，中心点命中的是消息文本。z-index 再高也没用：裁剪发生在层叠之前。
  // 原生 popover（智能体胶囊用的）本来就是 body 级 portal，故不受影响 —— 这里对齐同一实现。
  const css = newMobileCss(clientSrc)
  const rule = /\.dsh-mobile-tab-dropdown\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '应存在 .dsh-mobile-tab-dropdown 规则')
  assert.match(rule[1], /position:\s*fixed/, '下拉必须 position:fixed（portal 定位）')
  // 关键：不能给 top/left 加 !important，否则会压过 JS 写的内联坐标，下拉钉在左上角
  assert.ok(
    !/top:\s*[^;]*!important/.test(rule[1]) && !/left:\s*[^;]*!important/.test(rule[1]),
    'top/left 不得带 !important（会压过 positionTabDropdown 的内联坐标）',
  )
  assert.ok(
    clientSrc.includes('document.body.appendChild(dropdown)'),
    '下拉必须挂到 document.body',
  )
  assert.ok(clientSrc.includes('positionTabDropdown'), '应有 positionTabDropdown 计算坐标')
  assert.ok(clientBundle.includes('positionTabDropdown'), '构建产物未同步，请重跑 build:client')
})

test('全文档 MutationObserver 必须按帧合并（否则流式输出时滚动卡死）', () => {
  // 2026-10-17 定位到的真凶：panelObserver 监听**全文档子树 + class 属性**，回调直接是
  // ensurePanelCloseButton（内含 openPanels() + querySelector，且无廉价早退）。
  // 会话流式输出时 DOM 每秒变上千次 → 该函数跑上千次 → 主线程被占满。
  // 真机症状：滚不到最新会话、"加载更早"后再也回不去、界面与后端不同步。
  // 修法是按帧合并（rAF）：最多每帧一次，同一帧内的多次变更只算一次。
  assert.ok(
    !/new MutationObserver\(ensurePanelCloseButton\)/.test(clientSrc),
    '不得把 ensurePanelCloseButton 直接当观察器回调',
  )
  assert.match(
    clientSrc,
    /new MutationObserver\(schedulePanelCloseButton\)/,
    '观察器必须接按帧合并后的 schedulePanelCloseButton',
  )
  assert.ok(clientSrc.includes('requestAnimationFrame'), '必须用 requestAnimationFrame 合并回调')
  assert.ok(clientBundle.includes('schedulePanelCloseButton'), '构建产物未同步，请重跑 build:client')
})

test('#8 _frame 不得设固定高度或裁剪（会让 DSH 只渲染约 4 条消息）', () => {
  // 2026-10-17 真机二分结论（用户逐项实测）：
  //   ?dsh-mobile=no-frame          → scrollH 从 795 恢复到 10 万+
  //   ?dsh-mobile=no-frameSize      （去掉 width:100vw + height:100dvh）→ 恢复
  //   ?dsh-mobile=no-frameOverflow  （去掉 overflow:hidden）            → 恢复
  // 即：**固定高度 + 裁剪**这个组合让 DSH 的布局测量算错，驻留窗口塌缩成 ~4 条消息，
  // 表现为「进去停在很久以前某条、滚不到最新会话」（外层 scrollHeight≈视口高）。
  // 这两个属性组已删除；_frame 只保留 padding-top（为固定顶栏腾空间）与
  // display/flex-direction/position（抽屉化的前提）。
  //
  // 教训：这个 bug 在仿真视口里**一直存在**（scrollH 996 vs 正确 11295），
  // 当时因为不知道正确值而误判为"复现不出来"。断言要能表达"正确量级"。
  const all = injectedCss(clientSrc) + newMobileCss(clientSrc) + suspectCss(clientSrc)
  const frameRules = [...all.matchAll(/div\[class\*="_frame"\]\s*\{([^}]*)\}/g)].map((m) => m[1])
  assert.ok(frameRules.length > 0, '应存在 _frame 规则（检查本身不能空转）')
  for (const b of frameRules) {
    assert.ok(!/height:\s*100dvh/.test(b), '_frame 不得设 height:100dvh（会让 DSH 只渲染约 4 条消息）')
    assert.ok(!/width:\s*100vw/.test(b), '_frame 不得设 width:100vw')
    assert.ok(!/overflow:\s*hidden/.test(b), '_frame 不得设 overflow:hidden')
    assert.ok(!/grid-template-columns/.test(b), '_frame 是 flex 容器，不该留 grid 属性')
  }
  // 目的属性必须保留：为固定顶栏腾出空间
  assert.ok(
    frameRules.some((b) => /padding-top:\s*var\(--dsh-mobile-header-h\)/.test(b)),
    '_frame 必须保留 padding-top（这是这条规则存在的目的）',
  )
})
