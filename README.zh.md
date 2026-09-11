# dsh-bridge-gateway

[English](./README.md) | 简体中文

DeepSeek Harness（DSH）远程访问插件。以 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)
为根基，额外加入**「公网直连网关」**，让手机等外网设备不借助隧道就能直接访问、操作电脑上的
Harness。

局域网访问、Cloudflare 隧道、自建隧道、IM 机器人等原有能力保持不变；插件默认完全不启用，
装上后原有行为零改动，需要什么再开什么。

## 功能

- **公网直连网关。** 电脑直接监听 `0.0.0.0:<端口>`，自带 HTTPS 自签证书与强制登录门禁，
  外网设备直连访问。链路在网关处终结并转发到 DSH loopback，插件页面与 RPC 通道原样可用。
- **局域网访问。** 同一 Wi-Fi 下用手机扫远程访问面板里的二维码即可进入。
- **公网隧道。** Cloudflare（临时/固定域名）或自建隧道，与直连网关按需二选一或并存。
- **远程工作区。** 手机端网页目录树直接浏览并选择工作区对话。
- **安全认证。** 密码门禁 + 扫码免密 Token + 敏感配置的管理员解锁/锁定 + 防暴力破解限频；
  永不信任客户端自称的 `isLocalhost`。
- **IM 机器人。** 微信 / QQ / 飞书 / Telegram 机器人走各自网关链路，无需公网 IP；
  分平台指南见 [docs/](./docs)。
- **移动端适配。** 远程网页 UI 针对手机屏幕适配（抽屉导航、工作区选择器、软键盘处理）。
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

### 公网隧道

同一面板里选择 Cloudflare（临时/固定域名）或自建隧道。自建隧道协议见
[docs/custom-tunnel.md](./docs/custom-tunnel.md)。

### 安全配置

设置 -> 安全认证：开启防护、设置密码、管理免密 Token、解锁/锁定管理面。未认证访客在
任何页面内容返回之前就会被拒绝。

### IM 机器人

微信 / QQ / 飞书 / Telegram 使用指南：
[docs/wechat-usage.md](./docs/wechat-usage.md)、[docs/qq-usage.md](./docs/qq-usage.md)、
[docs/feishu-usage.md](./docs/feishu-usage.md)、[docs/telegram-usage.md](./docs/telegram-usage.md)。

## 安全说明

- 直连网关始终强制 `public_only` 式门禁：外部访客与局域网访问共用同一 AuthManager 认证，
  仅限 loopback 的资源绝不经网关暴露。
- RPC 通道经由宿主 web server 注册并通过请求拒绝（requestRejection）鉴权，
  伪造或未认证的通道调用在入口即被丢弃。
- 自签证书只加密传输、不提供身份：拿到密码的人就能登录——请设置强密码并开启管理员锁定。

## 开发

```sh
git clone https://github.com/lament-z/dsh-bridge-gateway
cd dsh-bridge-gateway
npm install
npm run build:client
npm test
dsh plugin --profile web add .
```

## 发布说明

打 `v*` 标签推送到 GitHub 即自动 `npm publish`（GitHub Actions，需仓库配置 `NPM_TOKEN` secret）。

## 开源协议

[MIT](./LICENSE)
