import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

function getGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const match = out.split('\n').find((l) => l.startsWith('password='));
    if (match) return match.split('=')[1].trim();
  } catch {}
  return null;
}

/**
 * 从 CHANGELOG.md 取出某个版本的正文（供 Release 正文兜底）。
 *
 * 本仓 CHANGELOG 的版本标题写作 `## [0.2.2] - 2026-10-11`（**无** v 前缀），而 tag 是
 * `v0.2.2`。旧实现只认 `## [v<version>]`，于是永远匹配不到、静默返回空串 —— 这条分支
 * 事实上是死代码。这里两种写法都接受，避免改一次标题风格就悄悄退化成 `Release vX.Y.Z`。
 *
 * @param {string} version package.json 的 version，如 `0.2.2`
 * @param {string} [changelogText] 便于测试注入的 CHANGELOG 文本；省略时读 ./CHANGELOG.md
 */
export function extractChangelogForVersion(version, changelogText) {
  try {
    const changelog = changelogText ?? fs.readFileSync('CHANGELOG.md', 'utf8');
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const header = new RegExp(`^## \\[v?${escaped}\\][^\\n]*$`, 'm').exec(changelog);
    if (!header) return '';
    const afterHeader = changelog.slice(header.index + header[0].length);
    const endIdx = afterHeader.search(/^## \[/m);
    const content = endIdx === -1 ? afterHeader : afterHeader.slice(0, endIdx);
    return content.trim();
  } catch {
    return '';
  }
}

async function createRelease() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const token = getGitHubToken();

  if (!token) {
    console.error('❌ 未找到有效的 GitHub Token，无法自动创建 Release');
    process.exit(1);
  }

  // releaseNotes 优先：本仓每次发版都手工维护它（【包名 版本】+ 要点），格式比整段
  // CHANGELOG 更适合当 Release 正文；CHANGELOG 只在漏写 releaseNotes 时兜底。
  const notes = pkg.releaseNotes || extractChangelogForVersion(version) || `Release ${tag}`;
  console.log(`🚀 准备为 ${tag} 创建 GitHub Release...`);

  const payload = {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: false,
    prerelease: false,
  };

  const res = await fetch('https://api.github.com/repos/lament-z/dsh-bridge-gateway/releases', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-bridge-gateway-release-bot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 201) {
    const data = await res.json();
    console.log(`✅ GitHub Release 创建成功: ${data.html_url}`);
  } else if (res.status === 422) {
    console.log(`ℹ️ GitHub Release ${tag} 已存在或标签未变动`);
  } else {
    console.error(`❌ GitHub Release 创建失败 HTTP ${res.status}:`, await res.text());
  }
}

// 只有被直接执行时才真的发 Release。被 import（例如单元测试取
// extractChangelogForVersion）时绝不能触发：否则跑一次测试就会去打 GitHub API。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRelease().catch(console.error);
}
