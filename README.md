# dsh-bridge-gateway

DeepSeek Harness 远程访问插件：以 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 为基础，额外加入 **「公网直连网关」**，让手机/外网设备能直接访问操作电脑上的 Harness。

局域网、Cloudflare 隧道、自建隧道、IM 机器人等原有能力保持不变。

## 一键安装

```bash
dsh plugin --profile web add dsh-bridge-gateway
```

> 源码安装：`git clone https://github.com/lament-z/dsh-bridge-gateway && dsh plugin --profile web add ./dsh-bridge-gateway`

升级到最新版：`dsh plugin --profile web add dsh-bridge-gateway@latest`

## 核心功能：公网直连网关

不需要隧道，让电脑直接监听公网端口，外网直连访问。

- **HTTPS 自签证书**：本机自动生成，公网传输加密。
- **强制登录门禁**：外部访问必须输入你在「安全认证」里设置的密码，与局域网策略相互独立。
- **全界面配置**：端口、随 DSH 自动启动等，都在「公网访问」设置页里配置。

### 开启方式

1. 安装后进入 DSH Web 设置 → 「公网访问」Tab。
2. 在「直连网关」卡片设置端口（默认 `7443`），点「保存端口」。
3. 点击「开启直连网关」。
4. 在路由器/云服务器把该端口映射到本机，即可通过 `https://<公网IP或域名>:端口` 访问。

浏览器首次访问会提示证书不安全，勾选「始终允许」即可继续。

## 其他能力

- **局域网访问**：同一 Wi-Fi 扫码即可。
- **公网隧道**：Cloudflare（临时/固定域名）或自建隧道二选一，与直连网关按需选用。
- **远程工作区**：手机端网页目录树直接浏览并选择工作区对话。
- **安全认证**：密码 + 扫码免密 Token + 管理后台防篡改 + 防暴力破解。
- **IM 机器人**：微信 / QQ / 飞书 / Telegram 扫码直连，无需公网。

## 开发

```bash
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