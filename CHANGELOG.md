# 更新日志 (Changelog)

本项目 `dsh-bridge-gateway` 是基于 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 的移植增强分支，在保留原版能力之外，重点新增「公网直连网关」。

## [未发布]

### 修复（移动端深度适配批次，基于 390px/320px 真机实测坐标）
- 顶栏「标准模式」与「对话管理」水平重叠（390px 下重叠 11px）：titleRow 允许换行，titleCluster/headerActions/headerUtilities 各自可收缩并限宽（45vw/50vw），内部按钮限宽省略号。
- 输入框被撑到 780px 而消息列仅 318px：从会话根节点收窄 `--dsh-chat-content-width`/`--dsh-composer-card-max-width` 变量，并补上此前遗漏的 `uV2eYG_root` 约束层，输入框祖先链整体不超视口。
- 320px 下 git 分支 chip 溢出屏幕右侧 39px 被裁切：chip 限宽 `min(120px, 30vw)`，其 `position:absolute` 浮层锚点改用 `right: 8px` 覆盖内联 `left`。
- 主要控件（模型/权限/工作区/分支 chip/会话操作等 10 类按钮）点击热区经伪元素 `inset: -8px` 扩至约 44px，视觉尺寸不变。
- 侧边栏关闭时仅被 transform 移出屏幕、内部 7 个按钮仍可被 Tab 聚焦：改用 `visibility: hidden` + `pointer-events: none`，抽屉打开时恢复。
- 隐藏 dsh-better-sidebar 注入的全屏 `panel-host` 遮罩（z-index 25 压住输入框并拦截点击）与主题装饰性 `glass-fade` 渐变条（右下角小方块）。
- 输入框底部工具栏（权限选择器/模型选择器/添加命令/发送）弹性自适应互不重叠。
- 侧边栏抽屉底部溢出屏幕 38px：`box-sizing: border-box` + `100dvh` 高度约束。

## [0.1.4] - 待发布

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