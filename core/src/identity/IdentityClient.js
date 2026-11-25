/**
 * IdentityClient — 认证客户端适配层
 *
 * 基于 @moruteaven/identity-sdk (TeavenIdentityClient)，
 * 对外保持与旧 IdentityClient 兼容的接口，同时桥接业务后端 API。
 *
 * 登录方式：
 * - Magic Link（requestMagicLink + verifyMagicLink）
 * - uTools 一键登录（loginWithUTools）
 *
 * 自动登录：
 * - token 由 SDK 持久化在宿主 dbStorage / localStorage，重启后仍在；
 * - ensureSession() 在启动时主动恢复会话（含过期续期与失败分类），
 *   UI 层（AccountPage / Toolbar）一律经 getSharedIdentity() 共享同一实例。
 */

import { TeavenIdentityClient, createWebStorage, MemoryTokenStorage } from '@moruteaven/identity-sdk';
import { getDomPort } from '../ports/DomPort.js';

const DEFAULT_IDENTITY_BASE = 'https://identity.moruteaven.com';
const DEFAULT_API_BASE = 'https://api.image-toolbox.moruteaven.com';
const DEFAULT_CLIENT_ID = 'image-toolbox';

/**
 * 会话自动恢复（ensureSession）的结果状态。
 *
 * 恢复不是布尔题：同样的「当前不可用」，有的是本地凭证彻底失效（要用户重新登录），
 * 有的只是网络或服务器暂时故障（必须保留凭证，否则一次离线启动就把用户登出）。
 * 调用方据此决定提示文案与 UI 走向。
 * @type {Readonly<{GUEST: string, OK: string, REFRESHED: string, OFFLINE: string, EXPIRED: string}>}
 */
export const SESSION_STATUS = {
  /** 本地无任何 token：从未登录过 */
  GUEST: 'guest',
  /** 已登录且 access token 仍有效 */
  OK: 'ok',
  /** access token 已过期，已用 refresh token 静默续期 */
  REFRESHED: 'refreshed',
  /** 续期请求因网络 / 服务器暂时故障失败，凭证已保留，待下次重试 */
  OFFLINE: 'offline',
  /** refresh token 已被服务端拒绝或本地无法续期，凭证已清除，需要重新登录 */
  EXPIRED: 'expired'
};

// 模块级共享实例。
// AccountPage 与 Toolbar 都需要身份会话；若各自 new 一个 IdentityClient，
// 就会存在两份互不相通的 token 内存态——一个实例刷新了 token，另一个仍持旧值，
// 服务端启用刷新轮换时旧 refresh token 再刷会被拒，直接把用户登出。
// 全部消费方一律经 getSharedIdentity() 取同一实例。
let _sharedInstance = null;

/**
 * 取共享的 IdentityClient 实例（惰性创建）。
 * @param {object} [options] 仅在首次创建时生效，后续调用忽略
 * @returns {IdentityClient}
 */
export function getSharedIdentity(options = {}) {
  if (!_sharedInstance) {
    _sharedInstance = new IdentityClient(options);
  }
  return _sharedInstance;
}

/**
 * 重置共享实例（仅供测试脚本使用）。
 * @returns {void}
 */
export function resetSharedIdentity() {
  _sharedInstance = null;
}

// 旧版 localStorage token key，用于迁移
const LEGACY_TOKEN_KEY = 'image_toolbox_tokens';

// 简单的 Base64 编码/解码，用于降低 localStorage 中 token 的明文可见性
const _encode = (str) => {
  try { return btoa(unescape(encodeURIComponent(str))); } catch { return str; }
};
const _decode = (str) => {
  try { return decodeURIComponent(escape(atob(str))); } catch { return str; }
};

/**
 * 解析 token 存储后端。
 *
 * 优先顺序：显式注入 → 宿主 dbStorage（经 DomPort 取宿主全局）→
 * 浏览器 localStorage（经 DomPort）→ SDK 内存存储。
 * 最后一级是为了让非浏览器环境（Node 测试、未来新宿主）仍能构造实例。
 *
 * @param {object} [injected] 显式注入的存储（三方法 getItem/setItem/removeItem）
 * @returns {object} 满足 getItem/setItem/removeItem 的存储对象
 */
function _resolveTokenStorage(injected) {
  if (injected && typeof injected.getItem === 'function') return injected;

  const win = getDomPort()?.getHostGlobal?.();
  const hostStorage = win?.hostTools?.dbStorage || win?.ztools?.dbStorage || win?.utools?.dbStorage;
  if (hostStorage && typeof hostStorage.getItem === 'function') return hostStorage;

  const webStorage = getDomPort()?.getStorage?.();
  if (webStorage && typeof webStorage.getItem === 'function') return webStorage;

  return new MemoryTokenStorage();
}

class IdentityClient {
  constructor(options = {}) {
    const identityBaseUrl = (options.identityBaseUrl || DEFAULT_IDENTITY_BASE).replace(/\/+$/, '');
    this._apiBaseUrl = (options.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
    this._clientId = options.clientId || DEFAULT_CLIENT_ID;

    // token 存储：经 DomPort 取得，不直接读 window.localStorage。
    // 宿主（uTools/ZTools）暴露 dbStorage 时优先用它，token 可跟随宿主账号；
    // 都取不到时退回 SDK 自带的内存存储，保证非浏览器环境仍可构造实例。
    this._tokenStorage = _resolveTokenStorage(options.storage);

    // 创建 SDK 客户端实例
    this._sdk = new TeavenIdentityClient({
      baseUrl: identityBaseUrl,
      clientId: this._clientId,
      storage: createWebStorage(this._tokenStorage),
      storagePrefix: 'teaven_identity_',
    });

    // 初始化标记 — init() 需要异步调用
    this._initialized = false;
    this._initPromise = null;
    // 会话自动恢复的单飞 Promise：同一时刻的多次 ensureSession 共享一次评估
    this._sessionPromise = null;
  }

  /**
   * 初始化 SDK 客户端（从存储加载已有 token）。
   * 幂等调用，多次调用返回同一个 Promise。
   */
  init() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        await this._migrateLegacyTokens();
        await this._sdk.init();
        this._initialized = true;
      })();
    }
    return this._initPromise;
  }

  /**
   * 迁移旧版 token 格式到 SDK 格式。
   * 旧格式：localStorage['image_toolbox_tokens'] = base64(JSON({accessToken, refreshToken, accessTokenExpiresAt}))
   * 新格式：localStorage['teaven_identity_access_token'] = token 等
   */
  async _migrateLegacyTokens() {
    try {
      const raw = this._tokenStorage.getItem(LEGACY_TOKEN_KEY);
      if (!raw) return;
      const decoded = _decode(raw);
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
        await this._sdk.saveTokens(parsed);
        this._tokenStorage.removeItem(LEGACY_TOKEN_KEY);
      }
    } catch {}
  }

  // ═══════════════════════════════════════
  // 会话自动恢复（自动登录）
  // ═══════════════════════════════════════

  /**
   * 恢复本地登录会话（自动登录入口）。
   *
   * SDK 只在「业务请求收到 401」时才刷新 token；若启动后不发请求，过期的
   * access token 会一直躺在存储里，UI 用同步 isAuthenticated() 判定又会把
   * 「token 存在」误当「已登录」。本方法在启动时主动把会话恢复到可用状态：
   *
   *   - access token 有效 → 直接可用（ok）；
   *   - access token 过期但有 refresh token → 主动续期（refreshed）；
   *   - 续期遇到网络 / 服务器暂时故障 → 保留凭证等下次（offline），绝不登出；
   *   - refresh token 被服务端拒绝 → 清除凭证，提示重新登录（expired）。
   *
   * 并发安全：同一时刻的多次调用共享同一次评估（单飞），评估完成后再次调用
   * 会重新评估（轻量本地检查，必要时才会再发网络请求）。
   * @returns {Promise<{status: string}>} 见 SESSION_STATUS
   */
  ensureSession() {
    if (!this._sessionPromise) {
      this._sessionPromise = this._ensureSessionInner().finally(() => {
        this._sessionPromise = null;
      });
    }
    return this._sessionPromise;
  }

  /** ensureSession 的实际执行体。 */
  async _ensureSessionInner() {
    await this.init();

    const hasAccess = Boolean(this._sdk.getAccessToken());
    const hasRefresh = Boolean(this._sdk.getRefreshToken());
    if (!hasAccess && !hasRefresh) {
      return { status: SESSION_STATUS.GUEST };
    }

    // SDK 的 isAuthenticated() 会核对存储中的过期时间（含 5 秒时钟余量）
    if (hasAccess && await this._sdk.isAuthenticated()) {
      return { status: SESSION_STATUS.OK };
    }

    if (!hasRefresh) {
      // 只剩一个已过期的 access token，无续期能力：清掉残留，等同未登录
      await this._sdk.clearTokens?.();
      return { status: SESSION_STATUS.EXPIRED };
    }

    try {
      await this._sdk.refreshAccessToken();
      return { status: SESSION_STATUS.REFRESHED };
    } catch (e) {
      if (this._isTransientError(e)) {
        // 网络 / 服务器暂时故障：保留凭证，下次启动再试。
        // 误清凭证的代价（用户被登出）远大于误保留（多试一次刷新）。
        console.warn('[IdentityClient] 会话续期暂不可用，已保留登录凭证:', e?.code || e);
        return { status: SESSION_STATUS.OFFLINE };
      }
      await this._sdk.clearTokens?.();
      console.warn('[IdentityClient] 登录会话已过期且无法续期:', e?.code || e);
      return { status: SESSION_STATUS.EXPIRED };
    }
  }

  /**
   * 判断刷新失败是否属于「暂时故障」（网络中断、服务器 5xx 等）。
   *
   * 依据 SDK 的错误形态（TeavenIdentityError 的 code / status）：
   *   - 不带业务码的错误不是 TeavenIdentityError：只可能来自请求适配器层
   *     （doRefreshToken 直接调用适配器，fetch 网络失败的原生异常会原样
   *     冒泡、没有 code），按暂时故障保守保留凭证；
   *   - NETWORK_ERROR / REQUEST_TIMEOUT：请求根本没到达服务端或超时；
   *   - status >= 500：服务端明确报错（包括统一码表把不认识的错误码兜底成
   *     HTTP 500 的情形，如网关返回 HTML 错误页时 SDK 合成的 REFRESH_FAILED）；
   *   - 服务端用 4xx 业务码明确拒绝（会话过期 / 被吊销）不属于暂时故障。
   * @param {*} e 捕获到的错误
   * @returns {boolean}
   */
  _isTransientError(e) {
    const code = e?.code;
    if (!code) {
      return true;
    }
    const text = String(code);
    if (text === 'NETWORK_ERROR' || text === 'REQUEST_TIMEOUT') {
      return true;
    }
    return Number(e?.status || 0) >= 500;
  }

  // ═══════════════════════════════════════
  // 认证状态（兼容旧接口）
  // ═══════════════════════════════════════

  /**
   * 检查是否已认证（token 存在且未过期）。
   * 旧版是同步方法，SDK 版是异步方法。
   * 为了兼容同步调用场景，先检查 isLoggedIn()，异步场景调用 isAuthenticated()。
   */
  isAuthenticated() {
    // 同步快速检查：token 是否存在
    return this._sdk.isLoggedIn();
  }

  /** 异步检查 token 有效性（含过期时间） */
  async isAuthenticatedAsync() {
    await this.init();
    return this._sdk.isAuthenticated();
  }

  // ═══════════════════════════════════════
  // Magic Link 登录
  // ═══════════════════════════════════════

  /** 请求 Magic Link 登录邮件（旧名 requestEmailCode 的替代） */
  async requestMagicLink(email) {
    await this.init();
    return this._sdk.requestMagicLink(email);
  }

  /** 验证 Magic Link token，完成登录 */
  async verifyMagicLink(token) {
    await this.init();
    return this._sdk.verifyMagicLink(token);
  }

  // ═══════════════════════════════════════
  // uTools 登录
  // ═══════════════════════════════════════

  /** uTools 一键登录（旧接口需 deviceId，新 SDK 不需要） */
  async loginWithUTools(accessToken, _deviceId) {
    await this.init();
    return this._sdk.loginWithUTools(accessToken);
  }

  // ═══════════════════════════════════════
  // 密码登录 / 注册
  // ═══════════════════════════════════════

  /** 密码登录 */
  async loginWithPassword(account, password) {
    await this.init();
    return this._sdk.loginWithPassword(account, password);
  }

  /** 邮箱注册 */
  async register(email, code) {
    await this.init();
    return this._sdk.register(email, code);
  }

  // ═══════════════════════════════════════
  // Token 管理
  // ═══════════════════════════════════════

  /** 刷新 Token */
  async refresh() {
    await this.init();
    return this._sdk.refreshAccessToken();
  }

  /** 注销 */
  async logout() {
    await this.init();
    return this._sdk.logout();
  }

  // ═══════════════════════════════════════
  // 用户信息（业务后端 API）
  // ═══════════════════════════════════════

  /**
   * 获取当前用户信息。
   * SDK 调用的是 Identity 服务的 /me 接口。
   */
  async getUserInfo() {
    await this.init();
    return this._sdk.getUserInfo();
  }

  /** 兼容旧接口 getProfile() */
  async getProfile() {
    await this.init();
    const info = await this._sdk.fetchProfile();
    return this._resolveAvatarUrl(info);
  }

  /** 更新用户信息（兼容旧接口 updateProfile） */
  async updateProfile(patch) {
    await this.init();
    // 旧版 patch 字段名 nickname → 新版 displayName
    const payload = {};
    if (patch.nickname !== undefined) payload.displayName = patch.nickname;
    if (patch.avatarUrl !== undefined) payload.avatarUrl = patch.avatarUrl;
    if (patch.email !== undefined) payload.email = patch.email;
    const result = await this._sdk.updateUserInfo(payload);
    return this._resolveAvatarUrl(result);
  }

  /**
   * 上传头像文件（multipart/form-data）。
   * 这是业务后端 API，SDK 不直接提供，需自行实现。
   */
  async uploadAvatar(file) {
    await this.init();
    const url = new URL('/api/me/avatar', this._apiBaseUrl + '/');
    const formData = new FormData();
    formData.append('file', file);

    const headers = {};
    const accessToken = this._sdk.getAccessToken();
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: formData,
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    // 401 → 尝试刷新
    if (res.status === 401) {
      try {
        await this.refresh();
        const newToken = this._sdk.getAccessToken();
        if (newToken) headers['Authorization'] = `Bearer ${newToken}`;
        const retryRes = await fetch(url.toString(), { method: 'POST', headers, body: formData });
        const retryText = await retryRes.text();
        let retryData = null;
        if (retryText) {
          try { retryData = JSON.parse(retryText); } catch { retryData = retryText; }
        }
        if (retryData && typeof retryData.code === 'string' && retryData.code === 'OK') {
          return this._resolveAvatarUrl(retryData.data);
        }
        throw retryData || { code: 'HTTP_ERROR', message: `HTTP ${retryRes.status}` };
      } catch {
        await this._sdk.clearTokens?.();
        throw { code: 'UNAUTHORIZED', message: 'Token expired, please login again' };
      }
    }

    if (!res.ok) {
      throw data || { code: 'HTTP_ERROR', message: `HTTP ${res.status}`, status: res.status };
    }

    if (data && typeof data.code === 'string') {
      if (data.code !== 'OK') throw data;
      return this._resolveAvatarUrl(data.data);
    }
    return data;
  }

  // ═══════════════════════════════════════
  // 积分（业务后端 API）
  // ═══════════════════════════════════════

  /**
   * 带鉴权的业务后端请求：401 时刷新 token 后重试一次。
   * 与 uploadAvatar 的 401 处理同源，供积分等 JSON 接口复用。
   * @param {string} path 相对 _apiBaseUrl 的路径，如 /api/credits
   * @param {object} [options] fetch 选项
   * @returns {Promise<*>} 后端 { code, message, data } 中的 data
   */
  async _apiFetch(path, options = {}) {
    await this.init();
    const url = new URL(path, this._apiBaseUrl + '/');
    const send = (token) => {
      const headers = { ...(options.headers || {}) };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(url.toString(), { ...options, headers });
    };

    let res = await send(this._sdk.getAccessToken());

    if (res.status === 401) {
      try {
        await this.refresh();
        res = await send(this._sdk.getAccessToken());
      } catch {
        await this._sdk.clearTokens?.();
      }
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    if (!res.ok) {
      throw data || { code: 'HTTP_ERROR', message: `HTTP ${res.status}`, status: res.status };
    }
    if (data && typeof data.code === 'string') {
      if (data.code !== 'OK') throw data;
      return data.data;
    }
    return data;
  }

  /** 查询积分概览：余额 / 累计获得 / 累计消耗 / 当日免费额度（UTC 零点刷新） */
  async getCredits() {
    return this._apiFetch('/api/credits');
  }

  /** 积分流水（keyset 分页） */
  async getCreditTransactions(cursor = null, limit = 20) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this._apiFetch(`/api/credits/transactions?${params.toString()}`);
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  /**
   * 将头像相对路径转为完整 URL。
   * SDK 返回的 UserInfo 中 avatarUrl 可能是相对路径。
   */
  _resolveAvatarUrl(profile) {
    if (!profile) return profile;
    // 兼容新旧字段名
    const result = {
      ...profile,
      nickname: profile.displayName || profile.nickname,
      avatar: profile.avatarUrl || profile.avatar,
    };
    if (result.avatar && result.avatar.startsWith('/api/avatars/')) {
      result.avatar = this._apiBaseUrl + result.avatar;
    }
    return result;
  }
}

export default IdentityClient;
