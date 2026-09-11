# dsh-bridge-gateway

English | [简体中文](./README.zh.md)

Remote-access plugin for DeepSeek Harness (DSH). Built on top of [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge), it adds a **public direct-connect gateway** so phones and other out-of-network devices can open and operate the Harness running on your computer — no tunnel required.

LAN access, Cloudflare tunnels, custom tunnels, and the IM bots all keep working exactly as before. The plugin is fully inert until you enable the features you want.

## Features

- **Public direct-connect gateway.** The computer listens on `0.0.0.0:<port>` with its own HTTPS self-signed certificate and a forced login gate, so outside devices connect straight to your machine. The link is terminated at the gateway and proxied to the DSH loopback, so plugin pages and RPC channels work unchanged.
- **LAN access.** Scan a QR code from the remote-access panel on the same Wi-Fi and you are in.
- **Public tunnels.** Cloudflare (temporary or fixed hostname) or a self-built tunnel, selectable per need alongside the direct gateway.
- **Remote workspace.** Browse the host's directory tree and pick workspace conversations from the phone.
- **Security.** Password gate + QR-based password-free token + admin unlock/lock for sensitive config + rate limiting against brute force. Client-claimed `isLocalhost` is never trusted.
- **IM bots.** WeChat / QQ / Feishu / Telegram bots connect through their own gateway links — no public IP needed. Per-platform guides live in [docs/](./docs).
- **Mobile-friendly web.** The remote web UI is deeply adapted for phone screens: drawer sidebar (fully hidden when closed, removing keyboard/screen-reader focus traps), top-bar mode and conversation-management controls that wrap instead of overlapping, git branch chips anchored to the viewport edge instead of being clipped, composer width aligned with the conversation column and stuck to the bottom, ~44px touch targets on the main controls via pseudo-element hit areas, and removal of full-screen overlays and decorative gradient strips that covered the input box.
- **All configuration in the UI.** Every feature above is configured from DSH Web's remote-access panel; nothing is edited by hand.

## Requirements

- Node `^22.19.0 || >=24.0.0`.
- DSH with a web profile (built and tested against `0.1.5-rc.2`; adapted for the 0.1.5 RPC/webServer entry points).

## Install

```sh
# Preferred: install straight from GitHub (no npm involved)
dsh plugin --profile web add github:lament-z/dsh-bridge-gateway

# Alternative: from npm
dsh plugin --profile web add dsh-bridge-gateway

# From a local clone / working copy
dsh plugin --profile web add link:<this directory>
```

Upgrade to the newest build: `dsh plugin --profile web add github:lament-z/dsh-bridge-gateway` again (or append `@latest` for the npm source). Then restart `dsh web`.

Nothing changes on install: the gateway is off by default and the original LAN/tunnel/IM behavior is untouched.

## Usage

### Public direct-connect gateway (core feature)

No tunnel needed — the computer exposes a port itself and outside devices connect directly.

1. Install, then open DSH Web -> Settings -> **Public Access** tab.
2. In the **Direct Gateway** card, set the port (default `7443`) and click save.
3. Click **Enable Direct Gateway**.
4. Map that port to this machine on your router / cloud server, then open `https://<public-IP-or-domain>:<port>` from outside.

First visit shows a certificate warning because the HTTPS certificate is self-signed — choose "always allow" to continue. External visitors must pass the login gate configured under **Security**; the gate policy is independent of your LAN settings.

### LAN access

Open the remote-access panel in DSH Web and scan the QR code with the phone on the same Wi-Fi.

### Public tunnel

In the same panel choose Cloudflare (temporary or fixed hostname) or a self-built tunnel. See [docs/custom-tunnel.md](./docs/custom-tunnel.md) for the custom-tunnel protocol.

### Security configuration

Settings -> Security: enable protection, set the password, manage the password-free token, and unlock/lock the admin surface. Unauthorized visitors are rejected before any page content is served.

### IM bots

WeChat / QQ / Feishu / Telegram guides: [docs/wechat-usage.md](./docs/wechat-usage.md), [docs/qq-usage.md](./docs/qq-usage.md), [docs/feishu-usage.md](./docs/feishu-usage.md), [docs/telegram-usage.md](./docs/telegram-usage.md).

## Security notes

- The direct gateway always enforces `public_only`-style gating: external visitors authenticate through the same AuthManager as LAN access, and loopback-only resources stay loopback-only.
- RPC channels are registered through the host web server and pass request-rejection authentication, so forged or unauthenticated channel calls are dropped at the entry.
- The self-signed certificate encrypts transport; it does not add identity. Anyone with the password can log in — keep the password strong and enable admin lock.

## Development

```sh
git clone https://github.com/lament-z/dsh-bridge-gateway
cd dsh-bridge-gateway
npm install
npm run build:client
npm test
dsh plugin --profile web add .
```

## Release notes

Pushing a `v*` tag to GitHub triggers automatic `npm publish` (GitHub Actions; the repository needs an `NPM_TOKEN` secret).

## License

[MIT](./LICENSE)
