// DSH Bridge - RPC constants (dependency-free, safe to import from browser client)

// 当前 RPC 通道名（与包名/插件 id 统一）。
export const BRIDGE_RPC_CHANNEL = '/dsh-bridge-gateway';

// 兼容用的旧通道名。**必须保留**，原因见下：
// 通道名会被构建期内联进浏览器 bundle。用户升级插件后，浏览器里**已缓存的旧 bundle**
// （以及已安装的 App / 反向代理后的缓存页面）仍会向旧路径发起请求。若服务端只注册
// 新路径，这些客户端会全部 404，表现为「升级后设置页所有按钮点了没反应」。
// 因此服务端同时注册新旧两条路径（webServer.register 按 path 为键，互不冲突），
// 客户端则先用新名、失败后回落旧名（见 client/index.js 的 rpcCall 适配）。
export const BRIDGE_RPC_CHANNEL_LEGACY = '/dsh-bridge';

// 服务端需要注册的全部通道路径（新名在前，决定客户端首选顺序）。
export const BRIDGE_RPC_CHANNELS = [BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNEL_LEGACY];

export const BRIDGE_ENDPOINTS = {
  getStatus: 'getStatus',
  startCustomTunnel: 'startCustomTunnel',
  stopCustomTunnel: 'stopCustomTunnel',
  startCloudflared: 'startCloudflared',
  stopCloudflared: 'stopCloudflared',
  resetCloudflared: 'resetCloudflared',
  saveCloudflaredConfig: 'saveCloudflaredConfig',
  setTunnelAutoStart: 'setTunnelAutoStart',
  saveCustomTunnelConfig: 'saveCustomTunnelConfig',
  setLanIp: 'setLanIp',
  // 公网直连网关（0.0.0.0:port HTTPS + 强制登录门禁）
  gatewayGetStatus: 'gatewayGetStatus',
  gatewayStart: 'gatewayStart',
  gatewayStop: 'gatewayStop',
  gatewaySaveConfig: 'gatewaySaveConfig',
  gatewaySetAutoStart: 'gatewaySetAutoStart',
  checkVersion: 'checkVersion',
  upgradePlugin: 'upgradePlugin',
  restartDsh: 'restartDsh',
  exportBackup: 'exportBackup',
  importBackup: 'importBackup',
  diagnoseNetwork: 'diagnoseNetwork',
  getSystemMetrics: 'getSystemMetrics',
  // 远程工作区管理与目录浏览
  listRemoteDirectories: 'listRemoteDirectories',
  addRemoteWorkspace: 'addRemoteWorkspace',
  listWorkspaces: 'listWorkspaces',
  // 访问安全认证（密码保护 / 扫码免密 Token）
  authGetStatus: 'authGetStatus',
  authUpdateConfig: 'authUpdateConfig',
  authRegenerateToken: 'authRegenerateToken',
  authAdminUnlock: 'authAdminUnlock',
  authAdminLock: 'authAdminLock',
  // 平台管理器（多 IM 平台统一接口）
  listPlatforms: 'listPlatforms',
  platformLogin: 'platformLogin',
  platformSetAllowFrom: 'platformSetAllowFrom',
  platformSetConfig: 'platformSetConfig',
  platformStop: 'platformStop',
  platformStart: 'platformStart',
  platformUnbind: 'platformUnbind',
  // Tailscale 隧道（访问配置 Tab：自动探测 Serve 地址 / 保存手动地址）
  tailscaleDetect: 'tailscaleDetect',
  tailscaleSaveUrl: 'tailscaleSaveUrl',
  // 远程连接监控（访客管理 Tab：可见 / 踢除 / 黑名单）
  connectionsGet: 'connectionsGet',
  connectionKick: 'connectionKick',
  blacklistSet: 'blacklistSet',
  // 微信 Bot（v1.x 向后兼容别名，deprecated）
  wechatGetStatus: 'wechatGetStatus',
  wechatLogin: 'wechatLogin',
  wechatSetAllowFrom: 'wechatSetAllowFrom',
  wechatSetConfig: 'wechatSetConfig',
  wechatStop: 'wechatStop',
  wechatStart: 'wechatStart',
  wechatUnbind: 'wechatUnbind',
};
