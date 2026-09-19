// lib/auth/manager.js
// 远程访问安全认证管理器：密码加盐哈希、Session 管理、免密安全 Token、防暴力破解与全协议鉴权拦截

import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionsFile as sessionsFilePath } from '../paths.js'

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_PERIOD_MS = 60 * 1000 // 连续失败封禁 60 秒

// 登录 Session 持久化：宿主（dsh web 进程）重启后，已登录设备免重输访问密码。
// 此前 sessions 是纯内存 Map，DSH 一重启手机就得重新登录。
// 落盘文件与 config.json 同目录（<DSH_HOME>/dsh-bridge-gateway/sessions.json，权限 600）；
// sessionToken 与 secretToken 同级机密（48 位随机 hex），同目录存储不扩大暴露面。
// 改密码 / 切模式 / 重新生成 token 时的 sessions.clear() 会同步清空文件（吊销语义保持）；
// 文件缺失或损坏时安全降级为空 Map（等价于旧行为：重新登录一次）。
//
class PersistentSessionMap extends Map {
  /** @param {string} file 会话落盘文件路径 */
  constructor(file) {
    super()
    this._file = file
  }

  _flush() {
    try {
      mkdirSync(dirname(this._file), { recursive: true })
      writeFileSync(this._file, JSON.stringify([...this.entries()]), { mode: 0o600 })
    } catch { /* 落盘失败降级为纯内存语义，不阻断认证流程 */ }
  }

  static load(file) {
    const m = new PersistentSessionMap(file)
    if (!file) return m
    try {
      const arr = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(arr)) {
        const now = Date.now()
        for (const [k, v] of arr) {
          // 只恢复结构合法且未过期的会话
          if (typeof k === 'string' && v && Number.isFinite(v.expiresAt) && v.expiresAt > now) {
            Map.prototype.set.call(m, k, { createdAt: Number(v.createdAt) || 0, expiresAt: Number(v.expiresAt) })
          }
        }
      }
    } catch { /* 文件缺失/损坏：降级为空 */ }
    return m
  }

  set(k, v) { super.set(k, v); this._flush(); return this }
  delete(k) { const r = super.delete(k); if (r) this._flush(); return r }
  clear() { super.clear(); this._flush() }
}

export class AuthManager {
  /**
   * @param {object} opts
   * @param {object} [opts.config]
   * @param {boolean} [opts.config.enabled=false]
   * @param {'token_and_password'|'password_only'|'token_only'} [opts.config.mode='token_and_password']
   * @param {string} [opts.config.passwordHash]
   * @param {string} [opts.config.passwordSalt]
   * @param {string} [opts.config.secretToken]
   * @param {boolean} [opts.config.allowLoopback=true]
   * @param {(patch: object) => Promise<void>|void} [opts.onPersist]
   * @param {string} [opts.sessionsFile] 登录会话持久化文件路径
   *        （默认 <DSH_HOME>/dsh-bridge-gateway/sessions.json；测试可注入临时目录，避免读写真实环境）
   * @param {object} [opts.logger]
   */
  constructor({ config = {}, onPersist, sessionsFile, logger = console } = {}) {
    this.logger = logger
    this.onPersist = onPersist
    this.config = config // 保留原始引用：黑名单等无独立字段的集合经此恢复

    this.enabled = Boolean(config.enabled)
    this.mode = config.mode || 'token_and_password'
    this.scope = config.scope || 'all' // 'all' | 'public_only' | 'lan_only'
    this.adminPolicy = config.adminPolicy || 'password_unlock' // 'password_unlock' | 'local_only' | 'open'
    this.passwordHash = config.passwordHash || ''
    this.passwordSalt = config.passwordSalt || ''
    this.adminPasswordHash = config.adminPasswordHash || ''
    this.adminPasswordSalt = config.adminPasswordSalt || ''
    this.secretToken = config.secretToken || this._generateToken()
    this.allowLoopback = config.allowLoopback !== false
    // 内部隧道专用鉴权密钥（内存生成，用于辨别本地自建隧道转发流量与真实本机访问）
    this.internalTunnelSecret = randomBytes(24).toString('hex')

    // Session 内存存储：sessionToken -> { createdAt, expiresAt }
    this.sessions = PersistentSessionMap.load(sessionsFile ?? sessionsFilePath())
    // 管理员解锁 Session 内存存储：adminToken -> { createdAt, expiresAt }
    this.adminSessions = new Map()
    // 防暴力破解：ip -> { failedCount, lockUntil }
    this.rateLimits = new Map()

    // 定期清理过期 Session (每小时)
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), 60 * 60 * 1000)
    if (this._cleanupTimer.unref) this._cleanupTimer.unref()
  }

  _generateToken() {
    return 'dsh_' + randomBytes(18).toString('hex')
  }

  _hashPassword(password, salt) {
    return pbkdf2Sync(String(password), salt, 10000, 32, 'sha256').toString('hex')
  }

  get hasPassword() {
    return Boolean(this.passwordHash && this.passwordSalt)
  }

  get hasAdminPassword() {
    return Boolean(this.adminPasswordHash && this.adminPasswordSalt)
  }

  /**
   * 获取安全认证状态（默认脱敏保护，防止普通接口泄露完整 Secret Token）
   */
  getStatus({ masked = true } = {}) {
    let token = this.secretToken;
    if (masked && token) {
      token = `${token.slice(0, 8)}****************`;
    }
    return {
      enabled: this.enabled,
      mode: this.mode,
      scope: this.scope,
      adminPolicy: this.adminPolicy,
      hasPassword: this.hasPassword,
      hasAdminPassword: this.hasAdminPassword,
      secretToken: token,
      allowLoopback: this.allowLoopback,
    }
  }

  /**
   * 仅限经过鉴权的管理员会话或公开策略下获取原始未脱敏 Secret Token
   */
  getRawSecretToken(adminToken) {
    if (this.adminPolicy !== 'open') {
      const hasAnyPassword = this.hasAdminPassword || this.hasPassword
      if (hasAnyPassword && (!adminToken || !this.validateAdminSession(adminToken))) {
        return null
      }
    }
    return this.secretToken
  }

  /**
   * 公开状态查询（供未认证访客/登录页使用，严格不包含 secretToken）
   */
  getPublicStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      scope: this.scope,
      adminPolicy: this.adminPolicy,
      hasPassword: this.hasPassword,
      hasAdminPassword: this.hasAdminPassword,
      allowLoopback: this.allowLoopback,
    }
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    this.sessions.clear()
    this.adminSessions.clear()
    await this._persist()
  }

  async setMode(mode) {
    if (['token_and_password', 'password_only', 'token_only'].includes(mode)) {
      this.mode = mode
      // 切换认证模式时清空所有现有 Session，确保新策略立即对所有设备生效
      this.sessions.clear()
      this.adminSessions.clear()
      await this._persist()
    }
  }

  async setScope(scope) {
    if (['all', 'public_only', 'lan_only'].includes(scope)) {
      this.scope = scope
      this.sessions.clear()
      this.adminSessions.clear()
      await this._persist()
    }
  }

  async setAdminPolicy(policy) {
    if (['password_unlock', 'local_only', 'open'].includes(policy)) {
      this.adminPolicy = policy
      this.adminSessions.clear()
      await this._persist()
    }
  }

  // 设置外部访客访问密码
  async setPassword(password) {
    if (!password) {
      this.passwordHash = ''
      this.passwordSalt = ''
    } else {
      const salt = randomBytes(16).toString('hex')
      const hash = this._hashPassword(password, salt)
      this.passwordHash = hash
      this.passwordSalt = salt
    }
    // 更改访问密码时使所有普通访客 Session 失效
    this.sessions.clear()
    await this._persist()
  }

  // 设置后台管理员密码
  async setAdminPassword(password) {
    if (!password) {
      this.adminPasswordHash = ''
      this.adminPasswordSalt = ''
    } else {
      const salt = randomBytes(16).toString('hex')
      const hash = this._hashPassword(password, salt)
      this.adminPasswordHash = hash
      this.adminPasswordSalt = salt
    }
    // 更改管理密码时使所有远程管理员解锁 Session 失效
    this.adminSessions.clear()
    await this._persist()
  }

  async regenerateSecretToken() {
    this.secretToken = this._generateToken()
    this.sessions.clear()
    await this._persist()
    return this.secretToken
  }

  // 管理员解锁控制
  createAdminSession(maxAgeMs = 30 * 60 * 1000) {
    const adminToken = randomBytes(24).toString('hex')
    const now = Date.now()
    this.adminSessions.set(adminToken, {
      createdAt: now,
      expiresAt: now + maxAgeMs,
    })
    return adminToken
  }

  validateAdminSession(adminToken) {
    if (!adminToken) return false
    const sess = this.adminSessions.get(adminToken)
    if (!sess) return false
    if (Date.now() > sess.expiresAt) {
      this.adminSessions.delete(adminToken)
      return false
    }
    return true
  }

  revokeAdminSession(adminToken) {
    if (adminToken) this.adminSessions.delete(adminToken)
  }

  verifyAdminPassword(inputPassword, clientIp = '') {
    if (this.isIpBlocked(clientIp)) {
      return { success: false, error: '尝试次数过多，请稍后再试' }
    }

    const targetHash = this.adminPasswordHash || this.passwordHash
    const targetSalt = this.adminPasswordSalt || this.passwordSalt

    if (!targetHash || !targetSalt) {
      return { success: true }
    }

    const inputHash = this._hashPassword(inputPassword, targetSalt)
    const bufA = Buffer.from(inputHash, 'hex')
    const bufB = Buffer.from(targetHash, 'hex')

    if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
      this.recordSuccess(clientIp)
      return { success: true }
    }

    this.recordFailedAttempt(clientIp)
    return { success: false, error: '管理员密码错误' }
  }

  unlockAdmin(password, clientIp = '') {
    if (this.adminPolicy === 'local_only') {
      return { ok: false, error: '当前已配置为仅限电脑本机管理设置' }
    }
    const hasAnyPassword = this.hasAdminPassword || this.hasPassword
    if (!hasAnyPassword) {
      const adminToken = this.createAdminSession()
      return { ok: true, adminToken }
    }
    const verify = this.verifyAdminPassword(password, clientIp)
    if (verify.success) {
      const adminToken = this.createAdminSession()
      return { ok: true, adminToken }
    }
    return { ok: false, error: verify.error || '管理员密码错误' }
  }

  async _persist() {
    if (typeof this.onPersist === 'function') {
      try {
        await this.onPersist({
          enabled: this.enabled,
          mode: this.mode,
          scope: this.scope,
          adminPolicy: this.adminPolicy,
          passwordHash: this.passwordHash,
          passwordSalt: this.passwordSalt,
          adminPasswordHash: this.adminPasswordHash,
          adminPasswordSalt: this.adminPasswordSalt,
          secretToken: this.secretToken,
          allowLoopback: this.allowLoopback,
        })
      } catch (err) {
        this.logger.error?.('[dsh-bridge auth] persist failed:', err?.message ?? err)
      }
    }
  }

  // ---- 认证校验逻辑 ----

  /**
   * 校验客户端密码
   */
  verifyPassword(inputPassword, clientIp = '') {
    if (this.isIpBlocked(clientIp)) {
      return { success: false, error: '尝试次数过多，请稍后再试' }
    }

    // 严禁 token_only 模式下通过密码登录接口获取 Session
    if (this.mode === 'token_only') {
      return { success: false, error: '当前仅允许专属安全 Token 扫码访问，不支持密码登录' }
    }

    if (!this.hasPassword) {
      // 若处于仅密码模式但尚未设置密码，不允许直接空白登录
      if (this.mode === 'password_only') {
        return { success: false, error: '管理员尚未设置访问密码，请先在控制台中设置密码' }
      }
      return { success: true }
    }

    const inputHash = this._hashPassword(inputPassword, this.passwordSalt)
    const bufA = Buffer.from(inputHash, 'hex')
    const bufB = Buffer.from(this.passwordHash, 'hex')

    if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
      this.recordSuccess(clientIp)
      return { success: true }
    }

    this.recordFailedAttempt(clientIp)
    return { success: false, error: '访问密码错误' }
  }

  /**
   * 校验安全 Token
   */
  validateSecretToken(token) {
    if (!token || !this.secretToken) return false
    const bufA = Buffer.from(String(token))
    const bufB = Buffer.from(String(this.secretToken))
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  }

  /**
   * 创建 Session
   */
  createSession(maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS) {
    const sessionToken = randomBytes(24).toString('hex')
    const now = Date.now()
    this.sessions.set(sessionToken, {
      createdAt: now,
      expiresAt: now + maxAgeMs,
    })
    return sessionToken
  }

  /**
   * 校验 Session
   */
  validateSession(sessionToken) {
    if (!sessionToken) return false
    const sess = this.sessions.get(sessionToken)
    if (!sess) return false
    if (Date.now() > sess.expiresAt) {
      this.sessions.delete(sessionToken)
      return false
    }
    return true
  }

  /**
   * 销毁 Session
   */
  revokeSession(sessionToken) {
    if (sessionToken) this.sessions.delete(sessionToken)
  }

  // ---- 防暴力破解 ----

  isIpBlocked(ip) {
    if (!ip) return false
    const record = this.rateLimits.get(ip)
    if (!record) return false
    if (record.lockUntil && Date.now() < record.lockUntil) {
      return true
    }
    if (record.lockUntil && Date.now() >= record.lockUntil) {
      this.rateLimits.delete(ip)
      return false
    }
    return false
  }

  recordFailedAttempt(ip) {
    if (!ip) return
    const now = Date.now()
    const record = this.rateLimits.get(ip) || { failedCount: 0, lockUntil: 0 }
    record.failedCount += 1
    if (record.failedCount >= MAX_FAILED_ATTEMPTS) {
      record.lockUntil = now + LOCKOUT_PERIOD_MS
      this.logger.warn?.(`[dsh-bridge auth] IP ${ip} locked out for 60s due to repeated failed attempts`)
    }
    this.rateLimits.set(ip, record)
  }

  recordSuccess(ip) {
    if (ip) this.rateLimits.delete(ip)
  }

  // ---- 持久黑名单（手动管理；与临时锁定是两套机制）----
  // 设计取舍：不做自动拉黑 —— 运营商 CGNAT 下大量用户共享出口 IP，
  // 自动误拉黑会殃及无辜。黑名单只来自管理员手动添加（含「踢除时一键加入」）。
  // 持久化走既有 onPersist 路径（与密码同文件），改密码不会意外清除。

  get blacklist() {
    this.blacklistSet ??= new Set(this.config?.blacklist ?? [])
    return this.blacklistSet
  }

  isBlacklisted(ip) {
    return this.blacklist.has(String(ip ?? '').trim())
  }

  async blacklistAdd(ip) {
    const normalized = String(ip ?? '').trim()
    if (!normalized) return false
    this.blacklist.add(normalized)
    await this._persistBlacklist()
    return true
  }

  async blacklistRemove(ip) {
    const removed = this.blacklist.delete(String(ip ?? '').trim())
    if (removed) await this._persistBlacklist()
    return removed
  }

  blacklistList() {
    return [...this.blacklist]
  }

  async _persistBlacklist() {
    try {
      await this.onPersist?.({ blacklist: [...this.blacklist] })
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge auth] blacklist persist failed:', err?.message ?? err)
    }
  }

  // ---- HTTP / WebSocket 请求总入口鉴权 ----

  /**
   * 检查请求是否已授权
   * @param {import('node:http').IncomingMessage} req
   * @returns {{ authenticated: boolean, fromToken?: boolean, sessionToken?: string, loopback?: boolean, bypass?: boolean, lanBypass?: boolean, publicBypass?: boolean }}
   */
  verifyRequest(req) {
    // 1. 未开启认证 -> 允许直通
    if (!this.enabled) {
      return { authenticated: true, bypass: true }
    }

    const remote = req.socket?.remoteAddress || ''
    const isLoopback = (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')

    // 辨别是否来自自建隧道或 Cloudflare 隧道 (只有从 127.0.0.1 传入且带有合法内部凭据/Cloudflare 标头才算)
    const internalTunnelHeader = req.headers?.['x-dsh-internal-tunnel']
    const isCustomTunnel = Boolean(isLoopback && internalTunnelHeader && internalTunnelHeader === this.internalTunnelSecret)
    const isCloudflare = Boolean(isLoopback && (req.headers?.['cf-ray'] || req.headers?.['cf-connecting-ip']))
    const isPublicTunnel = isCustomTunnel || isCloudflare

    // 黑名单判定 —— 判定依据是【隧道转发的真实来源】，不是 TCP 对端。
    // 经隧道时 TCP 对端恒为 127.0.0.1，真实 IP 在 x-forwarded-for / cf-connecting-ip；
    // 两个都取不到时退回对端地址（直连场景）。此判定必须在 loopback 放行之前 ——
    // 否则经隧道转发的黑名单 IP 会被误判为"本机"而放行。
    const forwarded = req.headers?.['cf-connecting-ip']
      || (String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim() || '')
      || ''
    const judgeIp = (isPublicTunnel && forwarded) ? forwarded : remote
    if (this.isBlacklisted(judgeIp)) {
      this.logger.warn?.(`[dsh-bridge auth] blacklisted IP ${judgeIp} rejected (${isPublicTunnel ? 'tunnel' : 'direct'})`)
      return { authenticated: false, blacklisted: true }
    }

    // 2. 本地环回免认证（真正的宿主机物理浏览器 127.0.0.1 访问，非 Tunnel 转发）
    if (this.allowLoopback && isLoopback && !isPublicTunnel) {
      const host = String(req.headers?.host || '')
      if (host.startsWith('127.0.0.1') || host.startsWith('localhost') || host === '') {
        return { authenticated: true, loopback: true }
      }
    }

    // 3. 检查防护范围 (scope: 'all' | 'public_only' | 'lan_only')
    if (this.scope === 'public_only' && !isPublicTunnel) {
      return { authenticated: true, lanBypass: true }
    }

    if (this.scope === 'lan_only' && isPublicTunnel) {
      return { authenticated: true, publicBypass: true }
    }

    // 4. 从 Query 参数中解析 ?auth=token 或 ?token=token (用于扫码免密登录)
    if (this.mode !== 'password_only') {
      try {
        const urlObj = new URL(req.url, 'http://localhost')
        const queryToken = urlObj.searchParams.get('auth') || urlObj.searchParams.get('token')
        if (queryToken && this.validateSecretToken(queryToken)) {
          return { authenticated: true, fromToken: true, secretToken: queryToken }
        }
      } catch {}
    }

    // 5. 从 Cookie 中解析 Session Token: dsh_bridge_auth=<token>
    const cookieHeader = req.headers?.cookie || ''
    const match = /(?:^|;\s*)dsh_bridge_auth=([a-f0-9]+)/i.exec(cookieHeader)
    if (match) {
      const sessionToken = match[1]
      if (this.validateSession(sessionToken)) {
        return { authenticated: true, sessionToken }
      }
    }

    // 未授权
    return { authenticated: false }
  }

  _cleanupExpired() {
    const now = Date.now()
    for (const [t, s] of this.sessions.entries()) {
      if (now > s.expiresAt) this.sessions.delete(t)
    }
    for (const [ip, r] of this.rateLimits.entries()) {
      if (r.lockUntil && now > r.lockUntil) this.rateLimits.delete(ip)
    }
  }

  dispose() {
    clearInterval(this._cleanupTimer)
    this.sessions.clear()
    this.rateLimits.clear()
  }
}
