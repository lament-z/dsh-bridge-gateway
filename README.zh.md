# dsh-bridge-gateway

[English](./README.md) | 简体中文

DeepSeek Harness（DSH）远程访问插件。以 [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)
为根基，额外加入**「公网直连网关」**，让手机等外网设备不借助隧道就能直接访问、操作电脑上的
Harness。

局域网访问、Cloudflare 隧道、自建隧道、IM 机器人等原有能力保持不变；插件默认完全不启用，
装上后原有行为零改动，需要什么再开什么。

> **项目血缘**：本仓库是 [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)
> 的增强分支（fork），并持续跟进上游修复。详见 [与上游的关系](#与上游的关系)。

## 与上游的关系

本项目的**上游是 [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)**，
它提供了本插件的全部基础能力。本仓库在其之上做了一件事、并修了两类问题。

### 上游是谁

| 项 | 说明 |
|---|---|
| 仓库 | [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) |
| 定位 | DSH 多通道远程访问与安全守护插件 |
| 能力 | 局域网扫码直连、Cloudflare / 自建公网隧道、微信 / QQ / 飞书 / Telegram 机器人、全协议访问认证 |
| 协议 | MIT |
| 关系 | 本仓库的 fork 源头；本项目的局域网访问、隧道、IM 机器人、安全认证均来自上游 |

**上游是这类插件的开创性实现**：它把「手机上继续用 DSH」这件事用最省事的方式做通了 ——
扫码进局域网、隧道出公网、IM 里直接对话。本插件站在它的肩膀上。

### 本仓库做了什么

**一、新增：公网直连网关（上游没有）**

上游解决「外网访问」的方式是**隧道**（Cloudflare 或自建）。隧道需要第三方转发，
且免费临时域名每次重启都会变。

本插件新增**直连网关**：电脑直接监听 `0.0.0.0:<端口>`，自带 HTTPS 自签证书与强制登录门禁，
外网设备**不经任何第三方**直接连上来。适合「自己有公网 IP / 会做端口映射」的场景，
也适合不想把流量过第三方的情形。

**二、修正：与 DSH 原生能力的冲突（上游至今保留）**

| 问题 | 上游现状 | 本仓库做法 |
|---|---|---|
| 目录选择器 | 以 `priority:-10` 抢注 DSH 原生 `directoryFlow` 两个 Slot，并用 capture 阶段 click 拦截劫持「添加工作区」按钮 | **改用官方 browse 目录选择器**（成对挂载 host 后端 + 浏览器 UI 面），不再抢注 Slot、不再拦截 DOM |
| 代理层改写 HTML | 反向代理时截取 HTML 做字符串替换，注入 PWA meta | 改走官方 `webserver/index-inject` 机制，由宿主统一渲染；代理回归**纯透明转发** |
| 目录选择服务名 | 用 `ctx.workspaces.pickDirectory`（官方实为 `ctx.uiWorkspace`） | 不再依赖该服务；目录选择整体交还原生 |

> 上游这两处实现在其 CHANGELOG 中作为功能描述，但会导致「添加工作区点了没反应」。
> 本仓库已修复，并欢迎上游采纳。

**三、跟进：持续移植上游修复**

上游迭代很快，本仓库持续跟进。已移植的修复见 [CHANGELOG](./CHANGELOG.md)，主要包括：

- DSH 0.1.5 适配：agent preset 真实挂载、会话已存在误判、平台配置重启即丢、`/rename` 持久化；
- 隧道保活：WebSocket Ping/Pong 帧层应答、cloudflared 崩溃自愈与禁用 autoupdate；
- 可靠性：Telegram 代理在 Node ≥ 24 下失效、登录 Session 持久化。

> 由于两边都在演进，**功能上可能各有先后**。遇到问题时建议对照上游 README 确认某项能力
> 归属哪一侧。

### 命名说明

插件名由 `dsh-bridge` 改为 **`dsh-bridge-gateway`**（体现「网关」这一新增能力）。
老用户升级时数据目录、配置、密码、证书、登录态都会**自动迁移**，无需手工处理：

| 路径 | 变化 |
|---|---|
| `<DSH_HOME>/dsh-bridge/` | → `<DSH_HOME>/dsh-bridge-gateway/`（启动时自动迁移） |
| `~/.dsh-bridge/` | → `~/.dsh-bridge-cloudflared/`（cloudflared 缓存，自动迁移，免重下） |
| RPC 通道 `/dsh-bridge` | → `/dsh-bridge-gateway`，**新旧双通道并存**，旧缓存页面仍可用 |

## 功能

- **公网直连网关（本插件新增）。** 电脑直接监听 `0.0.0.0:<端口>`，自带 HTTPS 自签证书与
  强制登录门禁，外网设备直连访问。链路在网关处终结并转发到 DSH loopback，插件页面与 RPC
  通道原样可用。
- **局域网访问。** 同一 Wi-Fi 下用手机扫远程访问面板里的二维码即可进入。
- **公网隧道。** Cloudflare（临时/固定域名）或自建隧道，与直连网关按需二选一或并存。
- **远程工作区。** 手机端网页目录树直接浏览并选择工作区对话（走 DSH 官方 browse 选择器）。
- **安全认证。** 密码门禁 + 扫码免密 Token + 敏感配置的管理员解锁/锁定 + 防暴力破解限频、
  登录态持久化（宿主重启不必重新登录）；永不信任客户端自称的 `isLocalhost`。
- **IM 机器人。** 微信 / QQ / 飞书 / Telegram 机器人走各自网关链路，无需公网 IP；
  可配置会话级工作区 / Agent 预设 / 模型；分平台指南见 [docs/](./docs)。
- **移动端适配。** 远程网页 UI 针对手机屏幕深度适配（抽屉化侧边栏、点击热区扩至约 44px、
  输入框贴底等）。
- **全界面配置。** 以上全部功能都在 DSH Web 远程访问面板里配置，无需手改任何文件。

## 要求

- Node `^22.19.0 || >=24.0.0`。
- DSH web profile（构建与测试基于 `0.1.5-rc.2`，已适配 0.1.5 的 RPC/webServer 入口）。

## 安装

```sh
# 推荐：直接从 GitHub 安装（不经 npm）
dsh plugin --profile web add github:lament-z/dsh-bridge-gateway

# 备选：从 npm 安装
dsh plugin --profile web add dsh-bridge-gateway

# 从本地 clone / 工作副本安装
dsh plugin --profile web add link:<本目录>
```

升级到最新版：再次执行上面的 GitHub 安装命令（npm 来源可加 `@latest`）。然后重启 `dsh web`。

安装后默认不启用：直连网关关闭，原有局域网/隧道/IM 行为完全不变。

## 使用方法

### 公网直连网关（核心功能）

不需要隧道，让电脑直接监听公网端口，外网直连访问。

1. 安装后进入 DSH Web 设置 -> **公网访问** Tab。
2. 在**直连网关**卡片设置端口（默认 `7443`），点「保存端口」。
3. 点击「开启直连网关」。
4. 在路由器/云服务器把该端口映射到本机，即可通过 `https://<公网IP或域名>:端口` 访问。

HTTPS 证书为自签，浏览器首次访问会提示不安全，勾选「始终允许」即可继续。外部访客必须通过
**安全认证**里配置的登录门禁；门禁策略与局域网设置相互独立。

### 局域网访问

在 DSH Web 打开远程访问面板，用同一 Wi-Fi 下的手机扫二维码。

> 局域网可达性也交给 DSH 原生 `--host` / `trustedHosts` 处理；插件自带的局域网反代
> **默认关闭**，需要时可在面板手动开启。

### 公网隧道

同一面板里选择 Cloudflare（临时/固定域名）或自建隧道。自建隧道协议见
[docs/custom-tunnel.md](./docs/custom-tunnel.md)。

隧道具备自愈能力：cloudflared 意外退出会按指数退避自动重连，且已禁用其 24h 自动更新
自我替换；自建隧道在帧层自动应答 DSH 的 WebSocket 心跳，避免长连接被掐断。

### 工作区选择

点「添加工作区」会打开 DSH 官方目录浏览器（Miller 双列布局、面包屑、可编辑路径、
新建文件夹、显示隐藏文件），**本机与远程行为一致**，手机端同样可用。

### 安全配置

设置 -> 安全认证：开启防护、设置密码、管理免密 Token、解锁/锁定管理面。未认证访客在
任何页面内容返回之前就会被拒绝。

登录态会持久化到 `<DSH_HOME>/dsh-bridge-gateway/sessions.json`（权限 `600`），
宿主重启后已登录设备无需重新输入密码；改密码 / 切换模式 / 重新生成 Token 仍会吊销全部旧会话。

### IM 机器人

微信 / QQ / 飞书 / Telegram 使用指南：
[docs/wechat-usage.md](./docs/wechat-usage.md)、[docs/qq-usage.md](./docs/qq-usage.md)、
[docs/feishu-usage.md](./docs/feishu-usage.md)、[docs/telegram-usage.md](./docs/telegram-usage.md)。

每个平台卡片里都有 **「⚙️ 高级设置」**，可配置该平台远程会话的**工作区目录**、
**Agent 预设**、**模型提供方 / 模型**（留空表示使用 DSH 默认值）。这些配置随宿主重启保留。

### 从 dsh-bridge 升级

老用户升级后无需任何手工操作：数据目录、配置、访问密码、自签证书、登录态都会自动迁移。
迁移是**幂等**的 —— 新目录已存在时不会覆盖，旧目录也不会被删除（可自行清理）。
若迁移遇到问题，插件照常启动，旧数据留在原处，日志中会有说明。

## 安全说明

- 直连网关始终强制 `public_only` 式门禁：外部访客与局域网访问共用同一 AuthManager 认证，
  仅限 loopback 的资源绝不经网关暴露。
- RPC 通道经由宿主 web server 注册并通过请求拒绝（requestRejection）鉴权，
  伪造或未认证的通道调用在入口即被丢弃。
- 自签证书只加密传输、不提供身份：拿到密码的人就能登录——请设置强密码并开启管理员锁定。
- 登录会话文件权限为 `600`；文件缺失或损坏时安全降级为空（等价于重新登录一次）。

## 开发

```sh
git clone https://github.com/lament-z/dsh-bridge-gateway
cd dsh-bridge-gateway
npm install
npm run build:client
npm test
dsh plugin --profile web add .
```

测试会通过 `test/isolate-home.mjs` 把 `DSH_HOME` 指向一次性临时目录，不会污染你本机的
真实环境。

本项目 fork 自 [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)。
向上游反馈通用问题、向本仓库反馈直连网关相关问题。

## 发布说明

打 `v*` 标签推送到 GitHub 即自动 `npm publish`（GitHub Actions，需仓库配置 `NPM_TOKEN` secret）。

## 开源协议

[MIT](./LICENSE)
