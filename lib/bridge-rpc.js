// DSH Bridge - RPC Interface (server side)
// Loopback-only RPC methods for browser UI

import QRCode from 'qrcode';
import { BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNELS, BRIDGE_ENDPOINTS } from './bridge-rpc-constants.js';
import { RateLimiter } from './security/rate-limiter.js';

export { BRIDGE_RPC_CHANNEL, BRIDGE_RPC_CHANNELS, BRIDGE_ENDPOINTS };

const rpcRateLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60000 });

function ok(value) {
  return { ok: true, value };
}

function fail(code, message, details = {}) {
  const allowedCodes = new Set([
    'bad-request', 'cancelled', 'internal', 'settings-rejected', 'command-error'
  ]);
  const safeCode = allowedCodes.has(code) ? code : 'bad-request';
  return {
    ok: false,
    error: {
      code: safeCode,
      message,
      details: { issues: [{ message }], ...details },
    },
  };
}

// 把登录态里的二维码载荷渲染成浏览器可展示的 dataURL（带缓存，避免重复生成）
async function renderQr(loginState) {
  if (!loginState?.qrPayload) return null;
  const cacheKey = `${loginState.qrKind}:${loginState.qrPayload.slice(0, 80)}`;
  if (renderQr.cache && renderQr.cache.key === cacheKey) return renderQr.cache.url;
  let url = null;
  const payload = loginState.qrPayload;
  if (loginState.qrKind === 'img') {
    url = /^data:/i.test(payload) ? payload : `data:image/png;base64,${payload}`;
  } else {
    try {
      url = await QRCode.toDataURL(payload, {
        width: 300, margin: 2, color: { dark: '#1F2421', light: '#FFFFFF' },
      });
    } catch { url = null; }
  }
  renderQr.cache = { key: cacheKey, url };
  return url;
}

/** 归一化 wechat 状态返回：把 loginState 里的 qrPayload 渲染成 qr dataURL。 */
async function wechatStatusValue(wechatService, logger) {
  const status = wechatService.getStatus();
  const qr = await renderQr(status.login).catch((err) => {
    logger.warn('dsh-bridge: render wechat qr failed: %s', err?.message ?? err);
    return null;
  });
  return { ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } };
}

function checkAdminAuth(authManager, payload) {
  if (!authManager) return null;
  if (authManager.adminPolicy === 'open') return null;
  // 若系统尚未设置任何管理密码或访客密码，允许免密管理
  const hasAnyPassword = authManager.hasAdminPassword || authManager.hasPassword;
  if (!hasAnyPassword) {
    return null;
  }
  // 已设置密码时，必须提供经服务端校验有效的 adminToken（绝不依赖客户端自称的 isLocalhost）
  if (payload?.adminToken && authManager.validateAdminSession(payload.adminToken)) {
    return null;
  }
  return fail('bad-request', '操作已被拦截：需要管理员权限，请先在控制台输入管理密码解锁');
}

// ---- RPC wire 助手（对齐 @deepseek-ai/dsh-client-connection 0.1.5 协议）----
// DSH 0.1.5 起 connection.rpc.handle 会在宿主 connection 上下文上访问 webServer
// （inject 守卫），第三方插件无法再从插件上下文调用；改为在自身 inject 的
// webServer 作用域注册等价 prefix 路由，认证走 connection.requestRejection
// （oh-my-dsh 升级卡 DSH-0.1.2-A1-08 的自定义通道配方），wire 格式保持不变。

const MAX_RPC_BODY_BYTES = 314572800;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.~-]+$/;

function endpointFromChannelPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s))) {
    return undefined;
  }
  return endpoint;
}

function fullResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

function errorResponse(rpcId, error) {
  return fullResponse(rpcId, { ok: false, error });
}

async function bridgeRpcFetch(channel, handler, request) {
  const endpoint = endpointFromChannelPath(channel, new URL(request.url).pathname);
  if (request.method !== 'POST' || endpoint === undefined) {
    return new Response('not found', { status: 404 });
  }
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('body is not JSON', { status: 400 });
  }
  const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request';
  if (body?.type !== 'client-request' || body?.method !== endpoint) {
    return errorResponse(rpcId, {
      code: 'gateway/bad-request',
      message: 'invalid client-request message',
      details: { issues: [] },
    });
  }
  try {
    const result = await handler(endpoint, body.payload, request.signal);
    return fullResponse(rpcId, result);
  } catch (error) {
    return new Response(`handler failure: ${String(error)}`, { status: 500 });
  }
}

async function bridgeChannelRequest(req, res, connection, channel, handler) {
  const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined;
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
    return;
  }
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  const url = new URL(req.url ?? '/', 'http://dsh.internal');
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.byteLength;
    if (received > MAX_RPC_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    signal: abort.signal,
  });
  const response = await bridgeRpcFetch(channel, handler, request);
  const responseHeaders = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, responseHeaders);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
    }
  }
  res.end();
}

export function installBridgeRpc(ctx, { service, authManager, wechat, platformManager, logger, saveCustomTunnelConfig, exportBackup, importBackup }) {
  if (!ctx?.connection) {
    logger.warn('dsh-bridge: Connection service unavailable — UI will not work');
    return () => {};
  }

  const handleBridgeRpc = async (endpoint, payload = {}, signal) => {
      if (signal?.aborted) return fail('cancelled', 'Request was cancelled');

      try {
        if (endpoint === BRIDGE_ENDPOINTS.getStatus) {
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          const status = await service.getStatus({ adminAuthValid: isAdmin });
          return ok(status);
        }

        // ---- Tailscale 隧道（访问配置 Tab）----
        // 探测为只读操作：只查询 tailscale 状态与 serve 规则，绝不代用户改配置。
        // 结果由服务端口做 30s TTL 缓存，force 表示用户显式点击「自动探测」。
        if (endpoint === BRIDGE_ENDPOINTS.tailscaleDetect) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          try {
            return ok(await service.detectTailnetEndpoint({ force: true }));
          } catch (err) {
            return fail('bad-request', `探测失败: ${err?.message ?? err}`);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.tailscaleSaveUrl) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          try {
            return ok(await service.saveTailscaleUrl({ url: payload.url }));
          } catch (err) {
            return fail('bad-request', err?.message ?? String(err));
          }
        }

        // ---- 远程连接监控（访客管理 Tab）：可见 / 踢除 / 黑名单 ----
        if (endpoint === BRIDGE_ENDPOINTS.connectionsGet) {
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          const data = await service.getConnections({ adminAuthValid: isAdmin });
          return ok(data);
        }

        if (endpoint === BRIDGE_ENDPOINTS.connectionKick) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          try {
            const result = await service.kickIp({ ip: payload.ip, blacklist: payload.blacklist === true });
            return ok(result);
          } catch (err) {
            return fail('bad-request', err?.message ?? String(err));
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.blacklistSet) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          try {
            const result = await service.setBlacklist({ ip: payload.ip, action: payload.action });
            return ok(result);
          } catch (err) {
            return fail('bad-request', err?.message ?? String(err));
          }
        }

        // ---- 访问安全认证 ----

        if (endpoint === BRIDGE_ENDPOINTS.authGetStatus) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          return ok(authManager.getStatus({ masked: !isAdmin }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authUpdateConfig) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { enabled, mode, scope, adminPolicy, password, adminPassword } = payload;
          if (enabled != null) await authManager.setEnabled(enabled);
          if (mode != null) await authManager.setMode(mode);
          if (scope != null) await authManager.setScope(scope);
          if (adminPolicy != null) await authManager.setAdminPolicy(adminPolicy);
          if (password !== undefined) await authManager.setPassword(password);
          if (adminPassword !== undefined) await authManager.setAdminPassword(adminPassword);
          return ok(authManager.getStatus({ masked: false }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authRegenerateToken) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await authManager.regenerateSecretToken();
          return ok(authManager.getStatus({ masked: false }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authAdminUnlock) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const { password } = payload;
          const res = authManager.unlockAdmin(password);
          if (res.ok) return ok({ adminToken: res.adminToken });
          return fail('bad-request', res.error || '管理员密码错误');
        }

        if (endpoint === BRIDGE_ENDPOINTS.authAdminLock) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          if (payload?.adminToken) authManager.revokeAdminSession(payload.adminToken);
          return ok({ locked: true });
        }

        if (endpoint === BRIDGE_ENDPOINTS.saveCustomTunnelConfig) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { serverUrl = '', accessToken = '' } = payload;
          await saveCustomTunnelConfig(serverUrl.trim(), accessToken.trim());
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.saveCloudflaredConfig) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { token = '', hostname = '' } = payload;
          await service.saveCloudflaredConfig({ token, hostname });
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.setTunnelAutoStart) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { tunnel, autoStart } = payload;
          await service.setTunnelAutoStart({ tunnel, autoStart });
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.setLanIp) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { ip } = payload;
          const status = await service.setLanIp({ ip });
          return ok(status);
        }

        // ---- 公网直连网关（0.0.0.0:port HTTPS + 强制登录门禁）----

        if (endpoint === BRIDGE_ENDPOINTS.gatewayGetStatus) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          return ok(service.gatewayStatus());
        }

        if (endpoint === BRIDGE_ENDPOINTS.gatewaySaveConfig) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          const { port, autoStart } = payload;
          await service.saveGatewayConfig({ port, autoStart });
          return ok(service.getStatus());
        }

        if (endpoint === BRIDGE_ENDPOINTS.gatewaySetAutoStart) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          await service.setGatewayAutoStart({ autoStart: payload?.autoStart });
          return ok(service.getStatus());
        }

        if (endpoint === BRIDGE_ENDPOINTS.gatewayStart) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          try {
            await service.startGateway();
            return ok(service.getStatus());
          } catch (err) {
            logger.error('Failed to start public gateway: %s', err.message);
            return fail('bad-request', err.message);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.gatewayStop) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;
          await service.stopGateway();
          return ok(service.getStatus());
        }

        if (endpoint === BRIDGE_ENDPOINTS.startCustomTunnel) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          try {
            await service.startCustomTunnel();
            const status = await service.getStatus();
            return ok(status);
          } catch (err) {
            logger.error('Failed to start custom tunnel: %s', err.message);
            return fail('bad-request', err.message);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.stopCustomTunnel) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          service.stopCustomTunnel();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.startCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          try {
            await service.startCloudflared();
            const status = await service.getStatus();
            return ok(status);
          } catch (err) {
            logger.error('Failed to start cloudflared: %s', err.message);
            return fail('bad-request', err.message);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.stopCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          service.stopCloudflared();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.resetCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await service.resetCloudflared();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.checkVersion) {
          const result = await service.checkVersion();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.upgradePlugin) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const result = await service.upgradePlugin(payload);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.restartDsh) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const result = await service.restartDsh();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.exportBackup) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          if (!exportBackup) return fail('bad-request', '备份导出服务不可用');
          const backup = await exportBackup();
          return ok(backup);
        }

        if (endpoint === BRIDGE_ENDPOINTS.importBackup) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          if (!importBackup) return fail('bad-request', '备份导入服务不可用');
          const result = await importBackup(payload?.backup);
          const status = await service.getStatus({ adminAuthValid: true });
          return ok({ result, status });
        }

        if (endpoint === BRIDGE_ENDPOINTS.diagnoseNetwork) {
          const result = await service.diagnoseNetwork();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.getSystemMetrics) {
          const metrics = service.getSystemMetrics();
          return ok(metrics);
        }

        // ---- 远程工作区管理与目录浏览 ----

        if (endpoint === BRIDGE_ENDPOINTS.listRemoteDirectories) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const clientKey = payload?.clientIp || payload?.adminToken || 'default';
          const rateCheck = rpcRateLimiter.check(clientKey, 30);
          if (!rateCheck.allowed) {
            return fail('bad-request', `请求过于频繁，请等待 ${rateCheck.retryAfterSec} 秒后再试`);
          }

          const result = await service.listRemoteDirectories(payload?.path);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.addRemoteWorkspace) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const clientKey = payload?.clientIp || payload?.adminToken || 'default';
          const rateCheck = rpcRateLimiter.check(clientKey, 20);
          if (!rateCheck.allowed) {
            return fail('bad-request', `添加工作区请求过于频繁，请等待 ${rateCheck.retryAfterSec} 秒后再试`);
          }

          const result = await service.addWorkspace(payload?.path);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.listWorkspaces) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const result = await service.getWorkspaces();
          return ok(result);
        }

        // ---- 平台管理器（多 IM 平台）----

        if (endpoint === BRIDGE_ENDPOINTS.listPlatforms) {
          if (!platformManager) return ok({});
          // 每个平台的 login.qrPayload 渲染为 dataURL 后返回
          const raw = platformManager.getStatus();
          const out = {};
          for (const [id, status] of Object.entries(raw)) {
            let qr = null;
            try { qr = await renderQr(status.login).catch(() => null); } catch { /* ignore */ }
            out[id] = { ...status, login: { ...(status.login ?? {}), qr, qrPayload: undefined, qrKind: undefined } };
          }
          return ok(out);
        }

        // ---- 平台操作（统一接口）----

        if (endpoint === BRIDGE_ENDPOINTS.platformLogin) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, qrType } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          const result = await platform.login({ qrType });
          if (!result.ok) return fail('bad-request', result.error ?? '登录启动失败');
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformSetAllowFrom) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, allowFrom } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.setAllowFrom(allowFrom);
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformSetConfig) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, ...config } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.setConfig(config);
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformStop) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.stop();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformStart) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.start();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformUnbind) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.unbind();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        // ---- 微信 Bot（v1.x 向后兼容别名，deprecated）----

        if (endpoint === BRIDGE_ENDPOINTS.wechatGetStatus) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatLogin) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { qrType } = payload;
          const result = await wechat.login({ qrType });
          if (!result.ok) return fail('bad-request', result.error ?? '登录启动失败');
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatSetAllowFrom) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await wechat.setAllowFrom(payload.allowFrom);
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatSetConfig) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await wechat.setConfig(payload);
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatStop) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await wechat.stop();
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatStart) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await wechat.gateway.start().catch((err) => {
            logger.error('wechat start enabled: %s', err?.message ?? err);
          });
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        if (endpoint === BRIDGE_ENDPOINTS.wechatUnbind) {
          if (!wechat) return fail('bad-request', '微信 Bot 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await wechat.unbind();
          const value = await wechatStatusValue(wechat, logger);
          return ok(value);
        }

        return fail('bad-request', `Unknown endpoint: ${endpoint}`);
      } catch (err) {
        logger.error('RPC endpoint %s failed: %s', endpoint, err.message);
        return fail('bad-request', err.message);
      }
  };

  return ctx.inject(['connection', 'webServer'], (c) => {
    const connection = c.connection;
    return c.effect(() => {
      // 同时注册新通道名与旧通道名。
      // 为什么不能只注册新名：通道名被内联进浏览器 bundle，升级后**已缓存的旧 bundle**
      // 仍会向旧路径发请求；只注册新名会让这些客户端全部 404
      //（表现为「升级后设置页所有按钮点了没反应」）。
      // webServer.register 以 path 为键，不同 path 互不冲突，可安全并存；
      // 待旧客户端自然淘汰后（重大版本）再移除兼容路径。
      const unregisterList = BRIDGE_RPC_CHANNELS.map((channel) =>
        c.webServer.register({
          kind: 'prefix',
          path: channel,
          handler: (req, res) => {
            void bridgeChannelRequest(req, res, connection, channel, handleBridgeRpc);
          },
        }),
      );
      return () => {
        for (const unregister of unregisterList) {
          try {
            unregister?.();
          } catch {}
        }
      };
    }, 'dsh-bridge-gateway: rpc channels (current + legacy)');
  });
}

