// lib/auth/theme-tokens.js
// ---------------------------------------------------------------------------
// 登录页设计 token 层：DSH 设计系统的静态快照 + 亮/暗双主题生成
// ---------------------------------------------------------------------------
// 为什么需要这一层（两个硬约束）：
//
// 1. 登录页跑在 DSH 之前 —— 它是网关在未认证时自己吐出的 HTML，DSH 的
//    `--dsw-*` 样式表根本没加载。所以每个 token 都必须带静态 hex 兜底，
//    写成 `var(--dsw-x, #hex)` 形式：DSH token 在场就跟随，不在场就用快照。
//    这与本仓库既有惯例一致（见 client/index.js 里每一处内联样式）。
//
// 2. `color-mix()` 在 Chrome 100 上整条声明失效 —— 本插件的浏览器下限是
//    Chrome 100（client/build.mjs 的 target: ['chrome100']，另有 2026-10-11
//    统信 UOS / 360 浏览器 Chrome 108 实测记录）。DSH 的 token 表里有若干别名
//    是用 color-mix() 算出来的（--dsw-alias-label-deep-diving / -shimmer /
//    --dsw-alias-tooltip-key-bg / --dsw-alias-bg-document-selection 等）。
//    在旧内核上这些变量解析为空 —— 不是降级，是"文字直接消失"。
//    → 因此本文件**只收录可直接写死的静态色值**，一个 color-mix() 都不引。
//
// 快照来源：@deepseek-ai/dsh-client-ui-theme  lib/client.js (~line 1148)
//   即 DSH 的 design-platform 样式表（--dsw-static-* 原始调色板 +
//   --dsw-alias-* 语义层）。DSH 升级后如需跟随，重新比对该处即可；
//   即使不跟也**不会崩**，只是配色停留在快照版本。
// ---------------------------------------------------------------------------

/**
 * token 表：本地变量名 ← DSH token 名 + 亮/暗静态快照值。
 *
 * 只收录登录页**真正用得到**的语义槽位 —— 每个 token 都必须在 login-template.js
 * 里被 var() 引用，否则就该删掉（同一个"无死参数"标准，见模板头部注释第 3 条）。
 * `dsh` 字段仅作溯源与 var() 兜底用。
 *
 * 值为纯静态色（hex / rgba），**禁止**出现 color-mix() 等 Chrome 100 不支持的函数。
 * 注意：这里有意不收 DSH 的成功绿 #22c55e —— 旧版登录页误把"成功色"当成品牌主色，
 * 测试里有反向断言钉死它不得再出现。
 */
export const TOKEN_TABLE = [
  // ---- 画布与层次 ----
  // 画布有意不用 --dsw-alias-bg-base：DSH 里那个值是纯白（亮）/ 近黑（暗），
  // 因为 DSH 的卡片永远叠在有遮罩的弹层上。登录页没有遮罩，白卡片贴纯白画布
  // 会失去层次。亮色改用 DSH 的模块层色 #f5f6f7 把白卡片托起来（dsh: null 表示
  // 这是刻意的快照值，不跟随任何 DSH token）。
  { name: 'bg', dsh: null, light: '#f5f6f7', dark: '#151517', note: '页面画布（亮色取 DSH 模块层色以拉开层次）' },
  { name: 'layer-2', dsh: '--dsw-alias-bg-layer-2', light: '#ffffff', dark: '#2c2c2e', note: '卡片面' },
  { name: 'module', dsh: '--dsw-alias-bg-module-platform', light: '#f5f6f7', dark: '#353638', note: '模块底（代码块/帮助面板）' },

  // ---- 文字 ----
  { name: 'label', dsh: '--dsw-alias-label-primary', light: '#0f1115', dark: '#f9fafb', note: '正文' },
  { name: 'label-2', dsh: '--dsw-alias-label-secondary', light: '#61666b', dark: '#cfd3d6', note: '次要' },
  { name: 'label-3', dsh: '--dsw-alias-label-tertiary', light: '#81858c', dark: '#adb2b8', note: '三级（页脚/占位符）' },
  { name: 'label-fg', dsh: '--dsw-alias-label-primary-foreground', light: '#ffffff', dark: '#0f1115', note: '强调色上的前景' },

  // ---- 边框 ----
  { name: 'border', dsh: '--dsw-alias-border-l2', light: 'rgba(0,0,0,0.10)', dark: 'rgba(255,255,255,0.12)', note: '常规描边' },
  { name: 'border-strong', dsh: '--dsw-alias-border-l4', light: 'rgba(0,0,0,0.16)', dark: 'rgba(255,255,255,0.20)', note: '强描边' },

  // ---- 表单 ----
  { name: 'input-bg', dsh: '--dsw-specific-login-input', light: '#f9fafb', dark: '#1b1b1c', note: 'DSH 专有"登录输入底"token' },

  // ---- 强调 / 业务色 ----
  { name: 'accent', dsh: '--dsw-alias-state-business-primary', light: '#4176e6', dark: '#7aaaff', note: '主 CTA + 鲸鱼标（DSH 业务蓝）' },
  { name: 'accent-hover', dsh: '--dsw-alias-button-info-hover', light: '#7aaaff', dark: '#4176e6', note: 'CTA 悬停（同 DSH info 按钮语义）' },
  { name: 'focus-ring', dsh: '--dsw-alias-state-business-primary', light: 'rgba(65,118,230,0.22)', dark: 'rgba(122,170,255,0.28)', note: '输入框聚焦光晕' },
  { name: 'link', dsh: '--dsw-alias-link', light: '#4176e6', dark: '#7aaaff', note: '链接' },

  // ---- 交互态 ----
  { name: 'hover', dsh: '--dsw-alias-interactive-bg-hover', light: 'rgba(38,49,72,0.06)', dark: 'rgba(255,255,255,0.08)', note: '通用悬停底' },

  // ---- 状态：错误 ----
  { name: 'danger', dsh: '--dsw-alias-state-error-primary', light: '#ec1313', dark: '#f25a5a', note: '错误文字' },
  { name: 'danger-bg', dsh: '--dsw-alias-interactive-bg-hover-danger', light: 'rgba(236,19,19,0.05)', dark: 'rgba(242,90,90,0.15)', note: '错误底' },
  { name: 'danger-border', dsh: '--dsw-alias-state-error-secondary', light: 'rgba(242,90,90,0.45)', dark: 'rgba(242,90,90,0.40)', note: '错误描边' },

  // ---- 状态：警示（锁定倒计时）----
  { name: 'warn', dsh: '--dsw-alias-state-warn-primary', light: '#f59e0b', dark: '#f59e0b', note: '警示文字' },
  { name: 'warn-bg', dsh: '--dsw-alias-state-warn-tertiary', light: '#fef5e7', dark: '#27241f', note: '警示底' },
];

/**
 * 圆角梯度，对齐 DSH --dsw-radius-*。
 *
 * 只保留登录页真正用到的档位（xs / sm / md / xl）—— 与 TOKEN_TABLE 同一条标准：
 * 没人用的就不放进来，需要时再加。DSH 自己全量输出 6 档，但那是它的设计系统；
 * 这里是一个具体页面的 token 层。
 */
const RADIUS = { xs: 4, sm: 8, md: 12, xl: 20 };


/** 动效时长与缓动（对齐 DSH --ds-transition-duration* / --ds-ease-in-out）。 */
const MOTION = {
  ease: 'cubic-bezier(.4, 0, .2, 1)',
  fast: '.1s',
  base: '.2s',
  slow: '.3s',
};

/**
 * 把 token 表渲染成 CSS 自定义属性块。
 *
 * 输出结构：
 *   :root { ...亮色... }                                  ← 默认（无 JS 也正确）
 *   @media (prefers-color-scheme: dark) { :root:not([data-gw-theme=light]) {...} }
 *   :root[data-gw-theme=dark] { ...暗色... }              ← 显式覆盖
 *
 * 默认走亮色是有意的：DSH 自身默认亮色（见 docs/screenshots/admin-lock-screen.jpg），
 * 旧版登录页写死暗色，导致远程用户经历"深绿 → 纯白"的硬切闪变。
 *
 * @returns {string} CSS 文本（不含 <style> 标签）
 */
export function renderTokenCss() {
  // dsh 为 null 的 token 是刻意的快照值，不跟随任何 DSH token（见 TOKEN_TABLE 注释）
  const val = (t, v) => (t.dsh ? `var(${t.dsh}, ${v})` : v);
  const rootVars = TOKEN_TABLE.map((t) => `  --gw-${t.name}: ${val(t, t.light)};`).join('\n');
  const darkVarsList = TOKEN_TABLE.map((t) => `    --gw-${t.name}: ${val(t, t.dark)};`).join('\n');
  const darkExplicit = TOKEN_TABLE.map((t) => `  --gw-${t.name}: ${val(t, t.dark)};`).join('\n');
  // 从 RADIUS 对象生成，而不是逐个手抄 —— 手抄会在增删档位时漂移成 `undefinedpx`
  const radiusVars = Object.entries(RADIUS)
    .map(([k, v]) => `  --gw-radius-${k}: ${v}px;`)
    .join('\n');

  return `:root {
${rootVars}
${radiusVars}
  --gw-ease: ${MOTION.ease};
  --gw-dur-fast: ${MOTION.fast};
  --gw-dur: ${MOTION.base};
  --gw-dur-slow: ${MOTION.slow};
  --gw-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --gw-font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei', monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-gw-theme='light']) {
${darkVarsList}
  }
}

:root[data-gw-theme='dark'] {
${darkExplicit}
}
`;
}
