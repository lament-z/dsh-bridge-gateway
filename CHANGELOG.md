# 更新日志 (Changelog)

本项目 `dsh-bridge-gateway` 是基于 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) 的移植增强分支，在保留原版能力之外，重点新增「公网直连网关」。

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