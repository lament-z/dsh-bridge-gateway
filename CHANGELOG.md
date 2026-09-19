# 更新日志 (Changelog)

本项目 `dsh-bridge-gateway` 是基于 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 的移植增强分支，在保留原版能力之外，重点新增「公网直连网关」。

## [0.2.0] - 2026-09-19

### 破坏性变更（移除 dsh-mobile 协议舱；访问配置 Tab 重构；新增 Tailscale 隧道）

**移除 dsh-mobile 相关功能**

- **移动协议舱整体删除**：`lib/mobile/`（`/ws/mobile` WebSocket + 设备配对 + 会话跟随）、
  `lib/shared/kernel-link.mjs`（行间通信内核）、`client/mobile-panel.js`（移动设备卡）、
  面板「移动设备」Tab 及其全部 RPC 端点（`mobileStatus` / `mobilePair` / `mobileSetMode` /
  `mobileRevoke` / `mobileSaveEndpoints` / `mobileDetectTailnet`）。
- **`cordis.patch.yml` 从两个 cordis row 恢复为单个**：`dsh-bridge-gateway/mobile` row 一并
  移除；随之移除为移动舱 `search` 通道打开 `session-query-sqlite` 全文索引的那层 patch
  （恢复 dsh-web-app 默认的 `openAt: never`）。Kernel 的 `pathPolicy` 接缝删除后，
  代理的 WebSocket upgrade 鉴权恢复为单路 `authManager.verifyRequest()` 判断。
- **Linux 一键公网部署 CLI 整体删除**：`bin/setup-ip.mjs` 与
  `helper/dsh_mobile_gateway_helper.py`（`package.json` 的 `bin` 字段一并移除）。
  该链路只服务 `/ws/mobile` 的 443 发布（Nginx + certbot IP 证书 + root helper），
  协议舱移除后已无服务对象。**`npx dsh-bridge-gateway init / setup / status / remove`
  命令不再存在**，公网访问请改用 Tailscale Serve 或 Cloudflare 隧道。
- 依赖 `@deepseek-ai/schemastery` 移除（仅协议舱使用）。

> 注意：手机浏览器的**网页版移动端适配**（抽屉侧边栏、44px 热区、输入框贴底、
  `injectMobileStyles` / `setupMobileExperience` 等）与协议舱无关，**全部保留**。

**新增 Tailscale 隧道卡片（访问配置 Tab）**

- 网关**自动探测**本机 Tailscale Serve 地址（`tailscale status --json` 取
  `Self.DNSName`，`tailscale serve status --json` 反查 `Handlers["/"].Proxy` 指向本机
  反代端口的 host），点「🔍 自动探测并填入」填入、可手动编辑、保存后生成扫码二维码。
- **探测为只读**：只查询状态，绝不代用户执行 `tailscale serve` 修改 tailscale 配置。
  未 serve 时给出可复制的 `tailscale serve --bg <端口>` 命令引导用户自行执行一次。
- 探测结果 **30s TTL 缓存**，后台定时刷新；`getStatus()` 只读快照，
  不会因面板 3s 轮询而起子进程。用户显式点击「自动探测」时绕过缓存。
- 二维码 URL 复用既有 `appendToken` 逻辑：开启安全认证时自动附加 `?auth=<token>` 免密扫码。
- 新增配置项 `tailscale.url`（保存的用户地址）与 RPC 端点 `tailscaleDetect` /
  `tailscaleSaveUrl`（均需管理员门禁）。

**访客管理：查看开放，写操作仍归管理员**

- 「远程连接监控」的连接列表、来源 IP 与黑名单内容改为**对所有已通过访问门禁的
  访客可见**——「谁正连着本机」是只读事实，不是管理凭据。
  `getConnections` 不再要求 adminToken，改为用新增的 `canManage` 字段回报管理员身份。
- **写操作保持管理员门禁**：`connectionKick`（断开 / 断开并拉黑）与 `blacklistSet`
  （黑名单增删）仍走 `checkAdminAuth`。UI 侧用 `canManage` 决定是否渲染这些按钮，
  非管理员只看到列表与一行「断开与拉黑需要管理员权限」的说明，没有输入框与按钮。

**面板结构重构**

- **「局域网」+「公网访问」合并为「访问配置」Tab**，卡片顺序为
  直连网关 → Cloudflare 隧道 → Tailscale 隧道 → 自建隧道 → 局域网访问
  （局域网卡片移至最末）。
- **新增「访客管理」Tab**：远程连接监控（来源 IP 可见 / 断开 / 断开并拉黑）与
  持久黑名单从公网 Tab 独立出来。服务端 `getConnections` / `kickIp` / `setBlacklist`
  与 auth 模块的黑名单持久化逻辑保持原样，仅 UI 位置变更。
- Tab 数从 6 降为 5：访问配置 / 访客管理 / IM 机器人 / 安全认证 / 运维监控。
- **修复「运维监控」Tab 在桌面端不可见**：面板根容器 `maxWidth: 620`，6 个
  `flexWrap: nowrap` 的 Tab 合计约 626px 溢出，而 `injectMobileStyles()` 全局隐藏了
  滚动条（无 `@media` 包裹，桌面端同样生效），最后一个 Tab 被挤出可视区且无提示。
  Tab 合并后宽度恢复余量，无需改动容器尺寸。

**卡片折叠（新增交互）**

- 访问配置 Tab 的 5 张卡片、安全认证 Tab 的 3 张卡片全部支持折叠，
  点击标题行切换，右侧状态标签与开关按钮不触发折叠（`stopPropagation`）。
- 默认只展开每组的第一张：访问配置 → 直连网关；安全认证 → 全局访问安全防护体系。
- 折叠时保留一行关键信息（当前地址 / 异常阶段 / 未配置提示），
  避免折叠后完全看不到状态。折叠状态由 `BridgePanel` 持有，切换 Tab 不丢失。
- 抽出共用外壳 `CardShell`，`TunnelCard` / `GatewayCard` / `TailscaleCard` /
  安全认证三卡共用同一份标题行与折叠实现。

### 变更（命名统一：插件叫 dsh-bridge-gateway，数据目录也跟着改名）

- **数据目录 `~/.dsh/dsh-bridge/` → `~/.dsh/dsh-bridge-gateway/`**：fork 时把包名与
  cordis loader id 都改成了 `dsh-bridge-gateway`，但**数据目录名是散落在 8+ 处的硬编码
  字面量**，没跟着改，于是出现「插件叫 dsh-bridge-gateway，目录却叫 dsh-bridge」的
  不一致。现统一改名。
- **新增 `lib/paths.js`（路径中心）**：所有持久化路径的唯一来源
  （`dataDir()` / `configFile()` / `sessionsFile()` / `resetAuthFile()` /
  `accessLogFile()` / `certDir(port)` / `wechatContextTokenFile()`）。
  此前这些路径在 8 个文件里各自硬编码，改一次名字要动十几处且容易漏。
- **启动时自动迁移旧目录**（`migrateLegacyDataDir()`），规则按「绝不丢数据」排序：
  1. 新目录已存在 → **不动**（已迁移过，绝不覆盖新数据）；旧目录保留不删；
  2. 旧目录不存在 → 直接创建新目录；
  3. 旧目录存在 → 优先 `rename`（原子、瞬时）；跨设备失败时退化为递归复制，
     **复制成功才**处理旧目录（改名为 `.migrated-<ts>` 留档）。
  迁移失败**不抛出**、只记日志，插件仍能正常启动，旧数据留在原处。
  幂等，可安全重复调用。
- **同步修正命名**：`lib/index.js` 的 logger 命名空间与 `client/index.js` 导出的
  `name` 由 `dsh-bridge` 改为 `dsh-bridge-gateway`；设置页 section id 同步；
  **救急指令文案**（登录页 + 设置页共 3 处 `touch .../reset-auth`）指向新目录。
- **RPC 通道名 `/dsh-bridge` → `/dsh-bridge-gateway`，并对老用户双向兼容**：
  通道名会被**构建期内联进浏览器 bundle**，因此升级后「浏览器里已缓存的旧 bundle」
  仍会打旧路径 —— 若服务端只注册新名，这些客户端会全部 404，表现为
  **「升级后设置页所有按钮点了没反应」**。兼容做法是两侧各自兜住：
  - **服务端**：`webServer.register` 以 path 为键、不同 path 互不冲突，故**同时注册
    新旧两条路径**（`BRIDGE_RPC_CHANNELS`）。已实测两条路径均返回 200。
  - **客户端**：新 bundle 默认走新名，调用失败时**回落旧名**，覆盖「host 侧插件
    尚未更新」的中间态。
  - 端点名（`getStatus` / `authSetConfig` 等）**保持不变**，避免 second wire break。
  - 待旧客户端自然淘汰后（重大版本）再移除兼容路径。
- **cloudflared 缓存目录 `~/.dsh-bridge/` → `~/.dsh-bridge-cloudflared/`，并自动迁移**：
  这是外部依赖缓存（约 39MB 二进制），与插件数据目录分开存放。
  启动时 `migrateLegacyCloudflaredDir()` 自动迁移（优先 `rename`，跨设备退化复制），
  使老用户**免于重新下载 39MB**。该迁移失败代价仅为重新下载，故策略比数据目录更宽松
  （失败只记 warn，绝不阻断启动）。已实测：本机 39MB 二进制迁移成功，旧目录已消失。
- **未改动**：RPC **端点名**（除通道名外的全部 wire 词汇）、`BRIDGE_ENDPOINTS` 的键。

### 老用户升级路径（本次改名的完整兼容说明）

| 场景 | 行为 |
|---|---|
| 数据目录 `dsh-bridge/` | 启动时自动迁移到 `dsh-bridge-gateway/`；新目录已存在则**不动**且保留旧目录 |
| cloudflared 缓存 `.dsh-bridge/` | 启动时自动迁移，免于重下 39MB |
| 浏览器缓存着**旧** bundle | 服务端仍注册旧通道 `/dsh-bridge`，调用照常成功 |
| 浏览器加载**新** bundle、host 仍是旧的 | 客户端回落旧通道 |
| 认证密码 / token / 证书 / 登录会话 | **完全保留**（迁移为 rename 语义，已逐字节比对） |

### 修复（P2 批次，移植自上游 dsh-bridge）

- **Telegram 代理在 Node ≥ 24 下失效（上游 issue #32）**：把自定义 `createConnection`
  作为 `https.Agent` 的**构造参数**会被 Node ≥ 24 静默忽略（`https.Agent` 不拷贝构造
  入参里的 `createConnection`，回退到原型上的默认直连方法），表现是「配了代理却永远走
  直连」且**不报任何错**。本机 Node v24.19.0 已实证复现。现改为**构造后赋值实例自有
  属性**（自有属性正确覆盖原型方法，Node 22/24 均生效）。
- **自建隧道 WebSocket 长连接被 DSH 主动掐断**：隧道此前是纯裸 TCP 字节转发，
  而 WebSocket 的 Ping/Pong 属协议层控制帧，不会被自动应答；DSH API Gateway 每 2s 发
  一次 Ping，收不到 Pong 就 terminate —— 表现为隧道频繁断连、会话中断。现新增帧层解析
  `_processWsFrames()`：拦截 Ping (0x9) **自动回复遮罩后的 Pong (0xA)**，其余帧原样转发。
  回复必须加 mask（client→server 方向协议要求），否则服务端 ws 库判定协议错误（1002）
  —— 修好一个断连反而制造另一个。已覆盖分片重组、单 chunk 多帧、126/64K 长度分支。
- **Cloudflare 隧道崩溃后不再恢复（上游 issue #34）**：此前已就绪后意外退出（崩溃 /
  OOM / 被误杀 / autoupdate 自替换）只把状态置为 `idle` 就「死透无人管」，公网入口
  失联且永不恢复。现按**指数退避自动重启**（5s 起步、翻倍、封顶 5min、最多 12 次），
  成功连接后计数清零；用户手动「关闭 / 重置」会取消待执行的重连。
- **禁用 cloudflared 24h autoupdate 自我替换**：cloudflared 的自动更新会在运行中把自身
  替换成新版本，导致连接静默中断且版本控制权外流。现于参数层注入 `--no-autoupdate`
  （已核对本机 cloudflared 2024.10.0 确实支持该 flag 及其 `NO_AUTOUPDATE` 环境变量），
  并同时设置 `NO_AUTOUPDATE=true` 双保险。注意该全局 flag 必须位于 `run` 子命令**之前**。
- **登录 Session 持久化（上游 issue #36 / PR #37）**：`sessions` 此前是纯内存 Map，
  宿主（`dsh web` 进程）一重启，所有已登录设备都要重新输访问密码。现落盘到
  `<DSH_HOME>/dsh-bridge/sessions.json`（**权限 600**），只恢复结构合法且未过期的会话；
  文件缺失/损坏安全降级为空（等价于旧行为：重新登录一次）。
  **安全语义保持不变**：改密码 / 切模式 / 重新生成 token 时走的 `sessions.clear()`
  会同步清空落盘文件，吊销后重启**不会**让旧会话复活。

### 测试基础设施

- **测试隔离**：`npm test` 现通过 `--import ./test/isolate-home.mjs` 把 `DSH_HOME`
  指向一次性临时目录。此前部分测试构造 `AuthManager` 时会命中默认路径，
  在真实的 `~/.dsh` 下留下文件（本次开发中实际发生过）。现在跑测试不会污染真实环境。

### 新增（设置页「高级设置」：会话级配置终于有界面入口）

- **每个 IM 平台卡片新增「⚙️ 高级设置」**：可直接配置该平台远程会话的 **工作区目录
  （cwd）**、**Agent 预设**、**模型提供方**、**模型**。此前这四个字段**没有任何界面
  入口**，只能手改 `config.json`，且改了还会在重启后丢失。留空表示使用 DSH 默认值。
- **新增 `lib/platform/session-config.js`**：会话级配置的读写归一
  （`SESSION_CONFIG_FIELDS` / `readSessionConfig` / `applySessionConfig` /
  `sessionConfigPatch`）。四个字段同时出现在「cordis 配置 → 设置页写入 → 启动恢复」
  三处，共用同一套字段名与空值语义，避免再次出现「配了不生效 / 重启就丢」。
  空串是**显式清除**（回落 DSH 默认值），非字符串入参一律忽略。

### 修复（平台配置重启即丢，移植自上游 dsh-bridge issue #40）

- **新增 `lib/platform/config-restore.js`**，把四个平台（微信 / QQ / 飞书 / Telegram）
  的重启恢复逻辑收敛成一个纯函数 `applyRestoredPlatformConfig()`。此前各平台恢复链路
  只挑字段回写：
  - 微信 / Telegram：只恢复 `allowFrom` + 时序参数，**四个会话级字符串字段全丢**；
  - **QQ / 飞书：连时序参数都没恢复**（`digestIntervalSec` / `approvalTimeoutSec` /
    `sendChunkDelayMs` 只活到下一次重启）。
  现在统一透传 `cwd` / `agentPreset` / `agentProvider` / `agentModel` 与时序参数。
- **写入侧同步打通**：四个平台的 `setConfig()` 此前**只接受时序参数**，会话级配置根本
  没有入口——已扩展为接受并持久化这四个字段（`...sessionPatch` + `sessionConfigPatch`），
  否则恢复侧无源可读。配置**导入 / 备份恢复**链路一并补齐（此前同样只恢复 `allowFrom`）。
- **设置页新增的四个输入框参与脏检查**，否则只改这几项时「保存」按钮不激活。

### 修复（`/rename` 重启即失效，移植自上游 dsh-bridge）

- 此前调用的是 `ctx.sessionPersistence.update()`——**DSH 的持久化服务根本没有这个方法**
  （本机核实：`update` 在该包中出现 0 次），可选链把调用静默跳过，改名只改了内存对象，
  重启与 Web 侧边栏都看不到。现改用 **DSH 原生会话标题服务**
  `ctx.get('sessionTitle').rename(session, title)`（本机核实：服务存在，签名为
  `rename(session, title)`，会追加 `session/title` 事件并落盘）。
  会话尚未在内存中恢复时**明确告知**「需先发一条消息重新挂载」，而不是假报成功。

### 修复（DSH 0.1.5-rc.2 适配，移植自上游 dsh-bridge）

- **Agent preset 现在会真正挂载（对应上游 issue #40）**：DSH 从 `0.1.5` 起把 agent
  侧的工具、提示词与技能目录整体挪到了 agent preset 后面（宿主 composition 里
  `tool-fs` / `tool-bash` / `tool-jobs` / `tool-skill` 等行被显式禁用），改由每个
  会话在创建时挂载 preset 提供。此前桥只把预设名写进会话 meta、**从未真正挂载**，
  会话因此落在「空预设层」，表现为**远程 Agent 缺少工具**（例如没有读文件的工具），
  且 `dsh-agent-presets` 会打 `published without joining an agent preset` 警告。
  现新增 `_composeAgentPreset()`：经 `ctx.get('agentPresets')` 解析真实 preset id，
  并提供 `agents.create` / `agents.resume` 所需的 **`setup` 回调**
  （`await presets.mount(agentCtx, resolvedId)`）——与 DSH 自身会话控制器的
  `resolve()` + `mount()` 一致。旧版 DSH（无 `agentPresets` 服务）保持原行为不传
  `setup`；配置的 preset 在本机不存在时**回退默认 preset 并在会话创建提示里明示**，
  不再静默降级，也绝不在空层上建会话。
- **移除硬编码的 `'routing-suite'` 默认 preset**：此前 `createSession` 在未配置
  preset 时硬编码 `agentPreset: 'routing-suite'`，而该 preset **在本机并不存在**
  （实际可用为内置 `standard`/`minimal`/`ptc`/`cordis` 与自定义 `liangshen`），
  等于每个 IM 新会话都指向一个空预设。现改为不设硬编码默认，交给 DSH 默认 preset。
- **修复已存在会话被误判为新会话（对应上游 issue #39）**：判断会话是否已持久化时
  沿用了旧的数据结构假设。DSH 0.1.5 的 `sessionPersistence.list()` 返回
  `{ header, revision, sizeBytes }` 快照，`entry.id` 恒为空 → 已存在的历史会话被
  误判成新会话 → 走 `agents.create` 建同名会话失败，报
  `session "..." already exists`，随后卡在「当前没有活动会话」。现新增
  `sessionHeaderOf()` 按真实结构取会话头（兼容新旧两种形态），**恢复会话时还会读回
  该会话自身记录的 preset**（与 DSH 会话控制器一致），未记录时才回落到桥配置。
- **测试**：新增 `test/dsh-015-compat.test.mjs`（10 项），钉住 `sessionHeaderOf`
  的新旧形态兼容、`_composeAgentPreset` 的解析/回退/`setup` 装配语义，以及
  "不再硬编码不存在的默认 preset"这条不变量。

> 说明：上游同版本还包含 `lib/connection-compat.js`（DSH 0.1.5 的
> `connection.rpc.handle` 注册回归垫片）。**本项目无需该垫片** —— 本地早在
> `[0.1.5]` 就已完成「RPC 通道从 `connection.rpc.handle` 迁到 `webServer` 直注册」，
> 根本不触发该回归（上游是因为未迁移才需要垫片）。

### 新增（远程可用的目录选择器）

- **挂载 browse 目录选择器，修复远程/手机端「添加工作区」无入口**：DSH 原生的
  `dsh-host-directory-picker-auto` 按 `ctx.webServer.host` 解析，而 `dsh web`
  的 CLI 层拒绝 `--host 0.0.0.0`（*"Binding all network interfaces is not
  supported"*），故 `bindHost` 恒为 `127.0.0.1`，在 macOS 上**恒解析为
  `native`** —— 只在主机屏幕弹系统对话框，远程浏览器看不到也点不到。
  本插件改为仿 `-auto` 的做法，通过 `ctx.loader.create` **成对挂载**
  `@deepseek-ai/dsh-host-directory-picker-browse`（host 后端）与
  `@deepseek-ai/dsh-client-ui-directory-picker-browse`（浏览器 UI 面），
  使本机与远程统一使用网页版目录树。该组件自带 Miller 双列布局、面包屑、
  可编辑路径、新建文件夹与「显示隐藏文件」，并已做窄屏适配。
  - 新增 `loader` 到插件 `inject`。
  - 两面包必须成对挂载：`dsh-host-directory-picker-browse` 是纯 host 包
    （`package.json` 无 `dsh.client` 字段），其 UI 面只由该 client 包自己的
    `apply` 注册；且 `directoryFlow` 是 `single` 洞口，只取
    `entriesOfSlot[0]`，后注册者被静默丢弃。
  - 需要同时在 profile 的 `cordis.patch.yml` 中禁用原生 `directory-picker`
    行，否则 `-auto` 会抢先注册 `native` 面并赢得单例洞口。

### 移除（与 DSH 原生能力重复、且会破坏宿主行为的实现）

- **不再抢占原生目录选择 Slot（修复「添加工作区点了没反应」）**：此前插件以
  `priority: -10` 注册 `conversation.hero.workspace.directoryFlow` 与
  `sidebar.workspaces.directoryFlow`，覆盖了 DSH 原生 directory-picker；且
  `inject` 里只尝试 `ctx.workspaces.pickDirectory`（官方服务名是
  `ctx.uiWorkspace.pickDirectory`），拿不到 `pick` 就退化成依赖 bridge RPC 的
  自绘弹窗。这两个洞口的职责本就由原生承担：本机走 `native`，远程走 `browse`
  （网页版目录树）。插件不再注册该 Slot，`RemoteDirectoryFlow` 一并删除。
- **不再用 capture 阶段 click 拦截劫持「添加工作区 / 打开文件夹」按钮**：此前
  对匹配按钮执行 `preventDefault + stopImmediatePropagation`，会掐断宿主事件链，
  使原生选择器永远无法弹出（远程访问时尤甚）。拦截已整体删除。
- **移除「远程工作区管理」设置卡片**（`RemoteWorkspaceCard`）及其弹窗与相关死
  CSS：原生工作区面板 + `browse` picker 已覆盖该能力。
- **不再改写 HTML 响应体**：代理层此前会截取未压缩 HTML、用正则往 `<head>`
  插入 viewport/PWA meta 与 `crypto.randomUUID` polyfill，并手工重算
  `content-length`。现改由 DSH 官方 `webserver/index-inject` 机制贡献结构化注入
  行，由宿主统一渲染与转义；`ProxyServer` 回归纯透明转发，直连与代理两条路径
 看到的页面一致。相关常量 `HTML_HEAD_INJECTIONS` / `INJECT_MARK` /
  `isCompressed` 已删除。
- **局域网反向代理默认不再自动启动**：局域网可达性交给 DSH 原生
  `dsh web --host 0.0.0.0 --trusted-host <authority>`，避免与原生监听重复。需
  要时可在「远程访问」面板手动开启，或设
  `<DSH_HOME>/dsh-bridge/config.json` 的 `lan.autoStart = true`。

### 保留（原生没有的能力）

- 公网直连网关（`0.0.0.0:port` + 自签 HTTPS）、Cloudflare / 自建隧道、访问门禁与
  访问日志、多 IM 平台会话桥（微信 / QQ / 飞书 / Telegram）保持不变。
- 移动端适配本轮**未改动**。

### 修复（公网直连网关：外网长连接会永久挂起 + 无法追溯来源）
- **长连接保活与回收**：WebSocket 在 upgrade 成功后即脱离 HTTP 解析器，`server.timeout` / `keepAliveTimeout` / `headersTimeout` 对它全部失效；此前网关没有任何应用层保活，对端静默消失（进电梯断网、被系统杀进程、NAT 表项过期）的连接会一直挂到内核 TCP 保活兜底（macOS 默认 2 小时）。现在每 15s 巡检一次台账：连续 60s 无任何入向字节先发一个 WebSocket ping 探活，再等 30s 一个字节都收不回来即判定死链并销毁（原因记为 `dead-peer`），真正死掉的连接最长 90s 内回收。
- **不再误杀活跃连接**：判定只依据「有没有入向字节」，客户端回的 pong 或任何业务帧都会解除探活状态；可选的绝对空闲上限 `GW_WS_MAX_IDLE_MS` 默认关闭。
- **来源可追溯（新增访问日志）**：新增 `<DSH_HOME>/dsh-bridge/access.log`（JSONL，5MB 滚动保留一份历史），记录每一次 WebSocket 建立/关闭（含**来源 IP、鉴权方式 token/session/loopback、连接时长、收发字节、关闭原因**）、被拒绝的 upgrade、访问密码登录成功/失败、URL Token 免密登录。此前插件完全不记录来访 IP，出事后无法判断连接归属。
- **真实连接台账**：`activeConnections` 此前只在初始化和 `stop()` 时归零、从未自增，面板「活动连接数」恒为 0；现在随 socket 增减实时维护，并且 `gatewayGetStatus` 额外返回 `wsConnections`（当前长连接数）与 `clients`（按来源 IP 聚合的明细，**仅管理员可见**）。
- **显式锁定 HTTP 层超时**：`headersTimeout` 60s / `requestTimeout` 300s / `keepAliveTimeout` 5s，保住「握手前慢速攻击」防护，不因存在长连接而放宽。

## [0.1.7] - 2026-09-12

### 变更（移动端第三批：标题行密度）
- 对话/轨迹/上下文 改为标题行内的「对话 ▾」下拉按钮（弃用胶囊方案）：插在标准模式与访达图标之间，原生样式观感，点开下拉切换视图，文案动态读取、语言无关。
- 修复 tabs 胶囊与标题行折成两行的问题：删除级联中残留的 titleRow wrap 规则，标题行强制单行。
- 原生 corner 按钮（打开右侧边栏）负边距归零，单行布局下不再被裁切。

### 修复
- workbuddy-connect 的 Reasoning levels 按钮：移动端删除文字节点只留图标（此前裁切露字），悬停宽度锁定不再引起工具栏抖动。
- 修复标签文案同步无条件写入 textContent 触发 MutationObserver 死循环导致页面卡死的问题。

## [0.1.6] - 2026-09-12

### 修复（移动端第二批：布局密度与面板）
- 输入框贴底：收掉 scrollBody 的 16px 底部衬距，只保留 6px 呼吸位 + 安全区，底部统计药丸完整可见。
- workbuddy-connect 的 Reasoning levels 按钮收成纯图标（26px，结构锚点不依赖语言），不再把左侧按钮挤到上一行；工具栏恢复单行。
- 对话/轨迹/上下文标签行折叠为标题行下缘的悬浮胶囊（原生 tooltip 灰配色），不再独占一行，中间内容区净增约 33px。
- 底部面板（better-sidebar panel-host）不再被一刀切隐藏：展开时以底部面板形态显示内容（zsh 会话等），收起时隐藏；收掉展开时原生预留的 220px 空白。展开信号用语言无关的 aria-pressed 锚点（body.dsh-workbench-open 在收起后残留，不可用）。
- 抽屉化侧边栏顶部对齐到标签条之下（top: 38px），不再与最上面的栏重叠。

## [0.1.5] - 2026-09-12

### 变更
- 适配 DSH 0.1.5：RPC 通道从 `connection.rpc.handle` 迁到 webServer 直注册 + `connection.requestRejection` 鉴权（0.1.5 inject 守卫使旧入口不可用，wire 格式不变）。

### 修复（移动端深度适配批次，基于 390px/320px 真机实测坐标）
- 顶栏「标准模式」与「对话管理」水平重叠（390px 下重叠 11px）：titleRow 允许换行，titleCluster/headerActions/headerUtilities 各自可收缩并限宽（45vw/50vw），内部按钮限宽省略号。
- 输入框被撑到 780px 而消息列仅 318px：从会话根节点收窄 `--dsh-chat-content-width`/`--dsh-composer-card-max-width` 变量，并补上此前遗漏的 `uV2eYG_root` 约束层，输入框祖先链整体不超视口。
- 320px 下 git 分支 chip 溢出屏幕右侧 39px 被裁切：chip 限宽 `min(120px, 30vw)`，其 `position:absolute` 浮层锚点改用 `right: 8px` 覆盖内联 `left`。
- 主要控件（模型/权限/工作区/分支 chip/会话操作等 10 类按钮）点击热区经伪元素 `inset: -8px` 扩至约 44px，视觉尺寸不变。
- 侧边栏关闭时仅被 transform 移出屏幕、内部 7 个按钮仍可被 Tab 聚焦：改用 `visibility: hidden` + `pointer-events: none`，抽屉打开时恢复。
- 隐藏 dsh-better-sidebar 注入的全屏 `panel-host` 遮罩（z-index 25 压住输入框并拦截点击）与主题装饰性 `glass-fade` 渐变条（右下角小方块）。
- 输入框底部工具栏（权限选择器/模型选择器/添加命令/发送）弹性自适应互不重叠。
- 侧边栏抽屉底部溢出屏幕 38px：`box-sizing: border-box` + `100dvh` 高度约束。

## [0.1.4] - 2026-08-30

### 修复
- 修复「远程访问」面板在宿主连接未建立时无限卡在「加载中」的问题：为状态拉取增加兜底超时（15s），超时后释放 in-flight 锁并给出可用的「🔄 重试」按钮，避免面板永远无法自行恢复。

## [0.1.3] - 待发布

### 修复
- 修复移动端对话时底部输入框横向超出屏幕右缘的问题：约束输入卡片与编辑器最大宽度不超视口，长内容自动折行。

## [0.1.2] - 待发布

### 新增
- 公网直连网关新增插件 host 反向代理：`/points-checkin/*` 路径转发到本机 points-checkin bridge，使积分签到插件在公网 HTTPS 网关页面下同步可用。

### 修复
- 修复移动端模型/权限选择下拉在底部输入栏被挤出视口、仅剩右下角横条的问题：改为固定在输入栏上方的底部浮层。

## [0.1.1] - 待发布

### 修复
- bundle patch 改为指向自身包名 `dsh-bridge-gateway`，修复 DSH 装载时引用原版包的问题。

## [0.1.0] - 首次发布

### 新增
- `dsh-bridge-gateway` 工程（fork 自 `dsh-bridge`）。
- 公网直连网关：`0.0.0.0:<端口>` 自带 HTTPS(自签证书) + 强制登录门禁，配置项全界面可配。
- 公网访问区：隧道 / 直连网关 二选一。

### 优化
- 修复移动端选择模型时界面溢出屏幕。
- 修复跨平台路径穿越安全漏洞。

### 说明
- 版本检查 / 在线更新已重定向到本插件自身，不再指向原版 `@wenbin_wb/dsh-bridge`。