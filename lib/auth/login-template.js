// lib/auth/login-template.js
// ---------------------------------------------------------------------------
// DSH 远程访问认证登录页（A′ 门厅式）
// ---------------------------------------------------------------------------
// 设计目标：让远程访客第一眼就认出这是 DSH 的入口，而不是一个通用安全卡片。
// 品牌资产来自 DSH 本体（见 brand-assets.js），配色走 DSH 设计系统快照
// （见 theme-tokens.js）。
//
// 三条硬约束（改动前务必先读）：
//
//   1. 零外部请求。字体、图标、样式、脚本全部内联或同源。登录页是公网第一触面，
//      任何第三方 CDN 都等于把可用性与隐私外包出去。DSH 官方包里的 Montserrat
//      品牌字体有意不引（省 60–90KB，且标题用系统字体栈已足够）。
//
//   2. 浏览器下限 Chrome 100。依据 client/build.mjs 的 target: ['chrome100']，
//      以及 2026-10-11 统信 UOS / 360 浏览器（Chrome 108 内核）实测。
//      → 禁用：dvh / :has() / color-mix() / @container / CSS 嵌套 /
//              text-wrap:balance / @starting-style / light-dark() / View Transitions。
//      动效一律用 SVG SMIL（Chrome 100 原生支持，不需要 polyfill）。
//
//   3. 无死参数。renderLoginPage 的每个入参都必须在模板里真正被使用，
//      否则就是又一个"服务器算好了但页面不理会"的缺陷（历史教训：locked /
//      hasPassword 曾是死参数，锁定态仍渲染完全可用的表单）。
// ---------------------------------------------------------------------------

import { whaleSvg } from './brand-assets.js';
import { renderTokenCss } from './theme-tokens.js';

/** 防护范围 → 副标题文案（scope 是活参数，不是装饰）。 */
const SCOPE_SUBTITLE = {
  all: '远程安全访问认证',
  public_only: '公网访问认证',
  lan_only: '局域网访问认证',
};

/** 网关仓库地址（页脚外链，同源之外唯一的外链目标，仅为 <a href>）。 */
const REPO_URL = 'https://github.com/lament-z/dsh-bridge-gateway';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染远程认证登录页。
 *
 * 状态完全由入参推导，不接收自由文本错误 —— 服务端在渲染本页时唯一已知的
 * 异常就是 IP 被限流（由 locked + lockRemainingMs 表达），其余错误都发生在
 * 提交之后，由页面内 JS 填入 #alert。少一个"谁都不传"的参数，就少一处死代码。
 *
 * @param {object} [opts]
 * @param {'token_and_password'|'password_only'|'token_only'} [opts.mode='token_and_password']
 *        认证模式。决定表单区渲染：token_only 不渲染密码框（否则是永远失败的死路）。
 * @param {'all'|'public_only'|'lan_only'} [opts.scope='all'] 防护范围，用于副标题。
 * @param {boolean} [opts.hasPassword=true] 是否已设置访问密码。
 *        password_only 且未设密码时改为引导卡，而不是让人对着必然失败的输入框。
 * @param {boolean} [opts.locked=false] 当前来源 IP 是否处于暴力破解锁定期。
 * @param {number} [opts.lockRemainingMs=0] 锁定剩余毫秒，用于倒计时与按钮置灰。
 *        由服务端按 AuthManager 的 LOCKOUT_PERIOD_MS 计算后传入；模板**不再自带
 *        默认时长** —— 手抄一份 60 秒副本，会在上游把锁定时长改大时让页面提前解除置灰。
 * @param {boolean} [opts.isLocal=false] 是否来自本机/局域网。
 *        仅在此情况下展示 `reset-auth` 救急路径 —— 避免向匿名公网访客披露宿主内部路径。
 * @param {string} [opts.version=''] 网关版本号，展示在页脚便于远程报障。
 * @returns {string} 完整 HTML 文档
 */
export function renderLoginPage({
  mode = 'token_and_password',
  scope = 'all',
  hasPassword = true,
  locked = false,
  lockRemainingMs = 0,
  isLocal = false,
  version = '',
} = {}) {
  const subtitle = SCOPE_SUBTITLE[scope] || SCOPE_SUBTITLE.all;

  // ---- 表单区形态判定（消灭两条死路）----
  const isTokenOnly = mode === 'token_only';
  const needsSetup = mode === 'password_only' && !hasPassword;
  const showPasswordForm = !isTokenOnly && !needsSetup;

  // 锁定态只在"确实还在锁定期"且"有密码表单可提交"时才有意义：
  //   - 剩余时长为 0 或非法 = 锁已到期，按未锁定处理（不置灰、不提示）；
  //     兜底成一个凭空的 60 秒会让用户白等，且与"服务端才是真源"矛盾。
  //   - token_only / 未设密码：压根没有可提交的东西，提示"稍后重试"是误导；
  //     而且这两种形态下倒计时元素不存在，硬渲染会永久显示 `--`。
  const lockMs = Number.isFinite(Number(lockRemainingMs)) && Number(lockRemainingMs) > 0
    ? Math.floor(Number(lockRemainingMs))
    : 0;
  const lockActive = Boolean(locked) && lockMs > 0;
  const showLockNote = lockActive && showPasswordForm;

  const footVersion = version ? ` · v${escapeHtml(version)}` : '';

  // #alert 必须无条件存在：倒计时结束后用户仍可能提交失败，届时靠它显示错误。
  // 锁定提示是独立的一条，与 #alert 并列。
  const statusArea = `${showLockNote
    ? `<div class="note note-warn" role="alert">
          <span class="note-icon" aria-hidden="true">&#9203;</span>
          <span>尝试次数过多，请在 <strong id="lockCountdown">--</strong> 秒后重试</span>
        </div>`
    : ''}<div class="note note-error" id="alert" role="alert" hidden>
          <span class="note-icon" aria-hidden="true">&#9888;</span>
          <span id="alertMsg"></span>
        </div>`;


  let formArea;
  if (isTokenOnly) {
    formArea = `<div class="guide">
        <div class="guide-title">当前仅允许专属安全 Token 访问</div>
        <p class="guide-body">管理员已关闭密码登录。请使用带 <code>?auth=</code> 参数的专属链接，或在电脑本机的网关控制台扫码获取。</p>
      </div>`;
  } else if (needsSetup) {
    formArea = `<div class="guide">
        <div class="guide-title">管理员尚未设置访问密码</div>
        <p class="guide-body">当前为「仅密码」模式但密码为空，暂时无法通过密码进入。请在运行本网关的电脑本机打开 DSH，于「设置 → 远程访问」中设置访问密码。</p>
      </div>`;
  } else {
    const tokenHint = mode === 'token_and_password'
      ? `<p class="hint">也可使用带 <code>?auth=</code> 参数的专属链接直接进入。</p>`
      : '';
    formArea = `<form id="loginForm" novalidate>
        <div class="field">
          <label for="password">访问密码 / PIN 码</label>
          <div class="input-wrap">
            <input type="password" id="password" name="password" placeholder="请输入管理员设置的访问密码"
                   autocomplete="current-password" spellcheck="false" required${lockActive ? ' disabled' : ''}>
            <button type="button" class="eye" id="eyeBtn" aria-label="显示密码" aria-pressed="false" aria-controls="password"${lockActive ? ' disabled' : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
        </div>
        <button type="submit" id="submitBtn" class="cta"${lockActive ? ' disabled' : ''}>
          <span class="spinner" id="btnSpinner" aria-hidden="true"></span>
          <span id="btnText">解锁并访问</span>
        </button>
        ${tokenHint}
      </form>`;
  }

  // ---- 帮助区：仅密码表单下才有意义；救急路径仅对本机/局域网可见 ----
  const helpArea = showPasswordForm
    ? `<div class="help">
        <button type="button" class="help-toggle" id="helpToggle" aria-expanded="false" aria-controls="helpPanel">忘记密码怎么办？</button>
        <div class="help-panel" id="helpPanel" hidden>
          <p><strong>电脑本机免密直连</strong>：在运行本网关的电脑上打开 DSH，物理机享有永久免密特权，可直接修改或清除密码。</p>
          ${isLocal
            ? `<p><strong>服务器救急指令</strong>：在宿主电脑终端执行
                 <code>touch ~/.dsh/dsh-bridge-gateway/reset-auth</code> 即可恢复初始免密状态。</p>`
            : `<p>远程设备无法自助重置，请联系部署者在本机处理。</p>`}
        </div>
      </div>`
    : '';

  const bootConfig = JSON.stringify({
    lockActive,
    lockMs,
    showPasswordForm,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f5f6f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151517" media="(prefers-color-scheme: dark)">
<title>远程访问认证 - DeepSeek Harness</title>
<style>
${renderTokenCss()}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--gw-font);
  background-color: var(--gw-bg);
  color: var(--gw-label);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
.gate { width: 100%; max-width: 400px; }

/* ---------- 品牌区 ---------- */
.brand { text-align: center; margin-bottom: 24px; }
.whale { display: block; margin: 0 auto 14px; color: var(--gw-accent); }
h1 {
  font-size: 20px; font-weight: 600; line-height: 1.3; margin: 0 0 6px;
  color: var(--gw-label); letter-spacing: -0.01em;
}
.sub { font-size: 13px; line-height: 1.5; margin: 0; color: var(--gw-label-2); }

/* ---------- 卡片 ---------- */
.card {
  background: var(--gw-layer-2);
  border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius-xl);
  padding: 24px 22px;
  box-shadow: 0 12px 32px -18px rgba(0, 0, 0, 0.35);
  animation: rise var(--gw-dur-slow) var(--gw-ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

/* ---------- 状态条 ---------- */
.note {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 12px; border-radius: var(--gw-radius-md);
  font-size: 13px; line-height: 1.5; margin-bottom: 16px;
  border: 1px solid transparent;
}
.note[hidden] { display: none; }
.note-icon { flex: none; line-height: 1.5; }
.note-error { background: var(--gw-danger-bg); border-color: var(--gw-danger-border); color: var(--gw-danger); }
.note-warn { background: var(--gw-warn-bg); border-color: var(--gw-border); color: var(--gw-warn); }
.shake { animation: shake var(--gw-dur-slow) ease; }
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-5px); }
  40%, 80% { transform: translateX(5px); }
}

/* ---------- 表单 ---------- */
.field { margin-bottom: 16px; }
label {
  display: block; font-size: 12px; font-weight: 500; line-height: 1.4;
  color: var(--gw-label-2); margin-bottom: 8px;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.input-wrap { position: relative; display: flex; align-items: center; }
input[type='password'], input[type='text'] {
  width: 100%; font-family: inherit; font-size: 15px; line-height: 1.4;
  color: var(--gw-label); background: var(--gw-input-bg);
  border: 1px solid var(--gw-border); border-radius: var(--gw-radius-md);
  padding: 13px 44px 13px 14px;
  outline: none;
  transition: border-color var(--gw-dur) var(--gw-ease), box-shadow var(--gw-dur) var(--gw-ease);
}
input::placeholder { color: var(--gw-label-3); }
input:focus {
  border-color: var(--gw-accent);
  box-shadow: 0 0 0 3px var(--gw-focus-ring);
}
input:disabled { opacity: 0.6; cursor: not-allowed; }
.eye {
  position: absolute; right: 8px;
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0;
  background: none; border: none; border-radius: var(--gw-radius-sm);
  color: var(--gw-label-2); cursor: pointer;
  transition: color var(--gw-dur) var(--gw-ease), background-color var(--gw-dur) var(--gw-ease);
}
.eye:hover:not(:disabled) { color: var(--gw-label); background: var(--gw-hover); }
.eye:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---------- 主按钮 ---------- */
.cta {
  width: 100%; font-family: inherit; font-size: 15px; font-weight: 600; line-height: 1.4;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 13px 16px; border: none; border-radius: var(--gw-radius-md);
  background: var(--gw-accent); color: var(--gw-label-fg);
  cursor: pointer;
  transition: background-color var(--gw-dur) var(--gw-ease), transform var(--gw-dur-fast) var(--gw-ease);
}
.cta:hover:not(:disabled) { background: var(--gw-accent-hover); }
.cta:active:not(:disabled) { transform: translateY(1px); }
.cta:disabled { opacity: 0.55; cursor: not-allowed; }
.spinner {
  display: none; width: 16px; height: 16px;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.spinner.on { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }

.hint { font-size: 12px; line-height: 1.5; color: var(--gw-label-3); margin: 12px 0 0; text-align: center; }
code {
  font-family: var(--gw-font-mono); font-size: 0.92em;
  background: var(--gw-module); border-radius: var(--gw-radius-xs);
  padding: 2px 5px; color: var(--gw-label-2);
  word-break: break-all;
}

/* ---------- 引导卡（Token 模式 / 未设密码）---------- */
.guide { text-align: center; padding: 4px 2px; }
.guide-title { font-size: 14px; font-weight: 600; color: var(--gw-label); margin-bottom: 8px; }
.guide-body { font-size: 13px; line-height: 1.7; color: var(--gw-label-2); margin: 0; }

/* ---------- 帮助区 ---------- */
.help { margin-top: 16px; text-align: center; }
.help-toggle {
  font-family: inherit; font-size: 12px; line-height: 1.5;
  background: none; border: none; padding: 4px 6px;
  color: var(--gw-label-2); cursor: pointer;
  border-radius: var(--gw-radius-sm);
}
.help-toggle:hover { color: var(--gw-link); }
.help-panel {
  margin-top: 12px; padding: 12px 14px; text-align: left;
  background: var(--gw-module); border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius-md);
  font-size: 12px; line-height: 1.7; color: var(--gw-label-2);
}
.help-panel[hidden] { display: none; }
.help-panel p { margin: 0 0 8px; }
.help-panel p:last-child { margin-bottom: 0; }
.help-panel strong { color: var(--gw-label); font-weight: 600; }

/* ---------- 页脚 ---------- */
.foot { margin-top: 22px; text-align: center; font-size: 12px; line-height: 1.6; color: var(--gw-label-3); }
.foot a { color: var(--gw-label-2); text-decoration: none; border-bottom: 1px solid var(--gw-border-strong); }
.foot a:hover { color: var(--gw-link); }
.foot-note { margin-top: 4px; font-size: 11px; color: var(--gw-label-3); }

/* ---------- 无 JS 兜底 ---------- */
.noscript {
  margin-top: 16px; padding: 10px 12px; font-size: 12px; line-height: 1.6;
  background: var(--gw-warn-bg); border: 1px solid var(--gw-border);
  border-radius: var(--gw-radius-md); color: var(--gw-warn);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
@media (max-width: 360px) {
  .card { padding: 20px 16px; }
  h1 { font-size: 18px; }
}
</style>
</head>
<body>
<main class="gate">
  <div class="brand" id="brand">
    ${whaleSvg({ size: 52, fill: 'currentColor' })}
    <h1>DeepSeek Harness</h1>
    <p class="sub">${escapeHtml(subtitle)}</p>
  </div>

  <section class="card">
    ${statusArea}
    ${formArea}
    ${helpArea}
    <noscript><div class="noscript">本页面需要启用 JavaScript 才能完成认证。</div></noscript>
  </section>

  <footer class="foot">
    <div>由 <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">dsh-bridge-gateway</a> 安全网关守护${footVersion}</div>
    <div class="foot-note">第三方网关，非 DeepSeek 官方产品</div>
  </footer>
</main>

<script>
(function () {
  var CFG = ${bootConfig};

  function $(id) { return document.getElementById(id); }

  // ---------- 鲸鱼游动（SVG SMIL，Chrome 100 原生可用）----------
  // 仅在用户与页面交互时启动；尊重 prefers-reduced-motion。
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { reduceMotion = false; }

  var swimEl = $('dsh-whale-swim');
  var canSwim = !reduceMotion && swimEl && typeof swimEl.beginElement === 'function';

  function startSwim() {
    if (!canSwim) return;
    try { swimEl.beginElement(); } catch (e) { /* 旧内核不支持则静默降级 */ }
  }
  function stopSwim() {
    if (!canSwim) return;
    try { if (typeof swimEl.endElement === 'function') swimEl.endElement(); } catch (e) { /* 同上 */ }
  }

  var brand = $('brand');
  if (brand) {
    brand.addEventListener('mouseenter', startSwim);
    brand.addEventListener('mouseleave', stopSwim);
  }

  // ---------- 密码可见性 ----------
  function togglePassword() {
    var input = $('password');
    var btn = $('eyeBtn');
    if (!input || !btn) return;
    var toText = input.type === 'password';
    input.type = toText ? 'text' : 'password';
    btn.setAttribute('aria-label', toText ? '隐藏密码' : '显示密码');
    btn.setAttribute('aria-pressed', toText ? 'true' : 'false');
    btn.innerHTML = toText
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  }

  var eyeBtn = $('eyeBtn');
  if (eyeBtn) eyeBtn.addEventListener('click', togglePassword);

  // ---------- 帮助区折叠 ----------
  var helpToggle = $('helpToggle');
  var helpPanel = $('helpPanel');
  if (helpToggle && helpPanel) {
    helpToggle.addEventListener('click', function () {
      var open = helpPanel.hasAttribute('hidden');
      if (open) { helpPanel.removeAttribute('hidden'); } else { helpPanel.setAttribute('hidden', ''); }
      helpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // ---------- 锁定倒计时 ----------
  var submitBtn = $('submitBtn');
  var passwordEl = $('password');

  function showError(msg) {
    var alert = $('alert');
    var msgEl = $('alertMsg');
    if (!alert || !msgEl) return;
    msgEl.textContent = msg;
    alert.removeAttribute('hidden');
    alert.classList.remove('shake');
    void alert.offsetWidth; // 强制 reflow 以重放动画
    alert.classList.add('shake');
  }

  if (CFG.lockActive) {
    var cd = $('lockCountdown');
    // 用绝对截止时间算剩余，而不是每秒做一次 remain 自减：
    // 浏览器会节流后台标签页的 timer，累减法会让切走再切回的用户看到偏慢的倒计时。
    var deadline = Date.now() + CFG.lockMs;
    var tick = function () {
      var remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (cd) cd.textContent = String(remain);
      if (remain <= 0) {
        clearInterval(timer);
        // 锁定解除：恢复表单可用性。服务端每次提交仍会复核，这里只是不让人干等。
        if (submitBtn) submitBtn.removeAttribute('disabled');
        if (passwordEl) passwordEl.removeAttribute('disabled');
        if (eyeBtn) eyeBtn.removeAttribute('disabled');
      }
    };
    tick();
    var timer = setInterval(tick, 500);
  }

  // ---------- 提交 ----------
  var form = $('loginForm');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var btn = $('submitBtn');
      var spinner = $('btnSpinner');
      var btnText = $('btnText');
      var alert = $('alert');
      var input = $('password');
      if (!input || !btn) return;

      var pwd = input.value;
      if (!pwd) { showError('请输入访问密码'); input.focus(); return; }

      startSwim();
      btn.disabled = true;
      if (spinner) spinner.classList.add('on');
      if (btnText) btnText.textContent = '验证中…';
      if (alert) alert.setAttribute('hidden', '');

      fetch('/__dsh_bridge__/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      }).then(function (resp) {
        return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
      }).then(function (res) {
        if (res.data && res.data.ok) {
          if (btnText) btnText.textContent = '认证成功，正在进入…';
          if (spinner) spinner.classList.remove('on');
          window.location.reload();
          return;
        }
        throw new Error((res.data && res.data.error) || '访问密码错误');
      }).catch(function (err) {
        stopSwim();
        showError(err && err.message ? err.message : '网络请求失败，请重试');
        btn.disabled = false;
        if (spinner) spinner.classList.remove('on');
        if (btnText) btnText.textContent = '解锁并访问';
        input.focus();
        input.select();
      });
    });

    if (passwordEl) {
      passwordEl.addEventListener('focus', startSwim);
      passwordEl.addEventListener('blur', stopSwim);
    }

    // 桌面端才自动聚焦：触屏上立刻弹出键盘会把版面顶飞
    try {
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        if (passwordEl && !CFG.lockActive) passwordEl.focus();
      }
    } catch (e) { /* 不支持 matchMedia 就不聚焦，不影响使用 */ }
  }
})();
</script>
</body>
</html>`;
}
