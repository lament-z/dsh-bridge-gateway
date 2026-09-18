# dsh-bridge-gateway

English | [简体中文](./README.zh.md)

Remote-access plugin for DeepSeek Harness (DSH). Built on top of [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge), it adds a **public direct-connect gateway** so phones and other out-of-network devices can open and operate the Harness running on your computer — no tunnel required.

LAN access, Cloudflare tunnels, custom tunnels, and the IM bots all keep working exactly as before. The plugin is fully inert until you enable the features you want.

> **Lineage**: this repository is an enhanced fork of [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) and keeps tracking its fixes. See [Relationship to upstream](#relationship-to-upstream).

## Relationship to upstream

This project's **upstream is [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)**, which provides all of the plugin's foundational capabilities. This repository adds one thing and fixes two classes of problems on top of it.

### Who upstream is

| | |
|---|---|
| Repository | [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) |
| Role | Multi-channel remote access and security plugin for DSH |
| Capabilities | LAN QR direct-connect, Cloudflare / self-built tunnels, WeChat / QQ / Feishu / Telegram bots, full-protocol access authentication |
| License | MIT |
| Relationship | The fork source for this repository. LAN access, tunnels, IM bots, and security authentication all come from upstream. |

**Upstream is the pioneering implementation of this class of plugin**: it made "keep using DSH from your phone" work the easy way — scan into the LAN, tunnel out to the internet, talk straight from an IM app. This plugin stands on its shoulders.

### What this repository adds

**1. New: public direct-connect gateway (not in upstream)**

Upstream solves "access from outside" with **tunnels** (Cloudflare or self-built). Tunnels require a third-party relay, and the free temporary hostname changes on every restart.

This plugin adds a **direct gateway**: the computer listens on `0.0.0.0:<port>` with its own self-signed HTTPS certificate and a forced login gate, and outside devices connect **without any third party in the middle**. It fits deployments that have a public IP / port-forwarding, or that simply do not want traffic routed through someone else's infrastructure.

**2. Fixed: conflicts with native DSH capabilities (still present upstream)**

| Problem | Upstream state | This repository |
|---|---|---|
| Directory picker | Claims DSH's native `directoryFlow` slots with `priority:-10`, plus a capture-phase click interceptor that hijacks the "Add workspace" button | **Uses the official browse directory picker** (mounts the host backend and browser surface as a pair). No slot claiming, no DOM interception. |
| Proxy-layer HTML rewriting | Intercepts HTML responses during reverse proxying and does string replacement to inject PWA metas | Uses the official `webserver/index-inject` mechanism so the host renders it; the proxy is a **pure transparent forwarder**. |
| Directory-picker service name | Calls `ctx.workspaces.pickDirectory` (the official service is `ctx.uiWorkspace`) | No longer depends on that service; directory picking is fully handed back to native. |

> Upstream describes the first two as features in its CHANGELOG, but they cause "clicking Add workspace does nothing". This repository fixes them and would welcome upstream adopting the fix.

**3. Tracking: continuously porting upstream fixes**

Upstream iterates quickly and this repository keeps up. Ported fixes are listed in [CHANGELOG](./CHANGELOG.md), notably:

- DSH 0.1.5 adaptation: real agent-preset mounting, already-persisted session misdetection, platform config lost on restart, `/rename` durability;
- Tunnel keepalive: WebSocket Ping/Pong answered at the frame layer, cloudflared crash self-healing and autoupdate disabled;
- Reliability: Telegram proxy broken on Node >= 24, login session persistence.

> Both sides evolve, so **feature coverage may lead on either side**. When in doubt, check upstream's README to see which side owns a given capability.

### Naming

The plugin was renamed from `dsh-bridge` to **`dsh-bridge-gateway`** (reflecting the added gateway capability). Existing users need no manual work — the data directory, configuration, passwords, certificates, and login state all migrate automatically:

| Path | Change |
|---|---|
| `<DSH_HOME>/dsh-bridge/` | → `<DSH_HOME>/dsh-bridge-gateway/` (migrated automatically at startup) |
| `~/.dsh-bridge/` | → `~/.dsh-bridge-cloudflared/` (cloudflared cache; migrated automatically, no re-download) |
| RPC channel `/dsh-bridge` | → `/dsh-bridge-gateway`, with **both channels served**, so stale cached pages keep working |

## Features

- **Public direct-connect gateway (added here).** The computer listens on `0.0.0.0:<port>` with its own HTTPS self-signed certificate and a forced login gate, so outside devices connect straight to your machine. The link is terminated at the gateway and proxied to the DSH loopback, so plugin pages and RPC channels work unchanged.
- **LAN access.** Scan a QR code from the remote-access panel on the same Wi-Fi and you are in.
- **Public tunnels.** Cloudflare (temporary or fixed hostname) or a self-built tunnel, selectable per need alongside the direct gateway.
- **Remote workspace.** Browse the host's directory tree and pick workspace conversations from the phone (via DSH's official browse picker).
- **Security.** Password gate + QR-based password-free token + admin unlock/lock for sensitive config + rate limiting against brute force, plus persisted login state (no re-login after a host restart). Client-claimed `isLocalhost` is never trusted.
- **IM bots.** WeChat / QQ / Feishu / Telegram bots connect through their own gateway links — no public IP needed. Per-platform workspace / agent preset / model selection is configurable. Guides live in [docs/](./docs).
- **Mobile-friendly web.** The remote web UI is deeply adapted for phone screens (drawer sidebar, ~44px touch targets, bottom-stuck composer, and more).
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

> LAN reachability is also delegated to DSH's native `--host` / `trustedHosts`. The plugin's own LAN reverse proxy is **off by default** and can be started from the panel when needed.

### Public tunnel

In the same panel choose Cloudflare (temporary or fixed hostname) or a self-built tunnel. See [docs/custom-tunnel.md](./docs/custom-tunnel.md) for the custom-tunnel protocol.

Tunnels are self-healing: cloudflared restarts with exponential backoff after an unexpected exit, and its 24h self-replacing autoupdate is disabled. The custom tunnel answers DSH's WebSocket heartbeats at the frame layer so long-lived connections are not terminated.

### Workspace selection

"Add workspace" opens DSH's official directory browser (Miller two-column layout, breadcrumb, editable path, new folder, show hidden files) with **identical behavior locally and remotely** — it works on phones too.

### Security configuration

Settings -> Security: enable protection, set the password, manage the password-free token, and unlock/lock the admin surface. Unauthorized visitors are rejected before any page content is served.

Login state is persisted to `<DSH_HOME>/dsh-bridge-gateway/sessions.json` (mode `600`), so already-signed-in devices survive a host restart without re-entering the password. Changing the password, switching mode, or regenerating the token still revokes every existing session.

### IM bots

WeChat / QQ / Feishu / Telegram guides: [docs/wechat-usage.md](./docs/wechat-usage.md), [docs/qq-usage.md](./docs/qq-usage.md), [docs/feishu-usage.md](./docs/feishu-usage.md), [docs/telegram-usage.md](./docs/telegram-usage.md).

Each platform card has an **"Advanced settings"** section where you can configure that platform's remote-session **workspace directory**, **agent preset**, and **provider / model** (leave blank to use DSH defaults). These survive host restarts.

### Upgrading from dsh-bridge

Nothing manual is required: the data directory, configuration, access password, self-signed certificate, and login state all migrate automatically. Migration is **idempotent** — an existing new directory is never overwritten, and the old directory is never deleted (clean it up yourself whenever you like). If migration hits a problem the plugin still starts, the old data stays where it was, and the log explains what happened.

## Security notes

- The direct gateway always enforces `public_only`-style gating: external visitors authenticate through the same AuthManager as LAN access, and loopback-only resources stay loopback-only.
- RPC channels are registered through the host web server and pass request-rejection authentication, so forged or unauthenticated channel calls are dropped at the entry.
- The self-signed certificate encrypts transport; it does not add identity. Anyone with the password can log in — keep the password strong and enable admin lock.
- The session file is mode `600`; a missing or corrupt file degrades safely to empty (equivalent to signing in once more).

## Development

```sh
git clone https://github.com/lament-z/dsh-bridge-gateway
cd dsh-bridge-gateway
npm install
npm run build:client
npm test
dsh plugin --profile web add .
```

Tests point `DSH_HOME` at a throwaway temporary directory via `test/isolate-home.mjs`, so they never touch your real environment.

This project is forked from [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge). Report general issues upstream and direct-gateway issues to this repository.

## Release notes

Pushing a `v*` tag to GitHub triggers automatic `npm publish` (GitHub Actions; the repository needs an `NPM_TOKEN` secret).

## License

[MIT](./LICENSE)
