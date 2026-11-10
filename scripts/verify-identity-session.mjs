/**
 * 身份会话自动恢复（自动登录）验证 —— 独立门禁，不在 pnpm build 调用链里。
 *
 * 守护 core/src/identity/IdentityClient.js 的 ensureSession() 状态机：
 * 自动登录的核心风险是把「暂时不可用」误判成「凭证失效」——一次离线启动
 * 或一次网关 5xx 就把用户的 refresh token 清掉，等于把自动登录变成
 * 「下次必须手动重登」。这里用注入存储 + mock fetch 逐分支钉死：
 *
 *   1. guest        —— 本地无任何 token，不发网络请求；
 *   2. ok           —— access token 未过期，直接可用；
 *   3. refreshed    —— access 过期，用 refresh token 续期并落盘；
 *   4. expired      —— access 过期且无 refresh token，清残留；
 *   5. offline      —— 续期网络失败（fetch reject），凭证必须保留；
 *   6. offline      —— 网关 5xx 错误页（SDK 合成 REFRESH_FAILED），凭证必须保留；
 *   7. expired      —— 服务端 4xx 业务码明确拒绝，凭证清除；
 *   8. 单飞          —— 并发 ensureSession 只发一次续期请求；
 *   9. 共享单例      —— getSharedIdentity() 全局唯一（双 UI 组件共享会话的前提）。
 *
 * 用法：node scripts/verify-identity-session.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 */

import IdentityClient, {
  getSharedIdentity,
  resetSharedIdentity,
  SESSION_STATUS
} from '../core/src/identity/IdentityClient.js';

const failures = [];
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 桩件 ──────────────────────────────────

const TOKEN_KEY = 'teaven_identity_access_token';
const REFRESH_KEY = 'teaven_identity_refresh_token';
const EXPIRES_KEY = 'teaven_identity_access_token_expires_at';

const FUTURE = Date.now() + 3600_000;
const PAST = Date.now() - 3600_000;
const IDENTITY_BASE = 'https://identity.moruteaven.com';

function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: { forEach() {} }
  };
}

function htmlResponse(status, html) {
  return {
    status,
    ok: false,
    text: async () => html,
    headers: { forEach() {} }
  };
}

/** 覆盖 globalThis.fetch，返回调用记录与还原函数。 */
function installFetchMock(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

/** 造一个「access 过期 + 有 refresh token」的客户端。 */
function makeExpiredClient(storage) {
  return new IdentityClient({ storage });
}

const okSession = (status) => status === SESSION_STATUS.OK;
const tokensKept = (storage) =>
  storage.getItem(TOKEN_KEY) !== null && storage.getItem(REFRESH_KEY) !== null;

// ── 用例 ──────────────────────────────────

console.log('\n1. guest：本地无 token，不发起任何网络请求');
{
  const storage = createMemoryStorage();
  const mock = installFetchMock(() => jsonResponse(200, { code: 'OK', data: {} }));
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 guest', result.status === SESSION_STATUS.GUEST, JSON.stringify(result));
    check('未发起网络请求', mock.calls.length === 0, `calls=${mock.calls.length}`);
  } finally {
    mock.restore();
  }
}

console.log('\n2. ok：access token 未过期，直接可用');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at',
    [EXPIRES_KEY]: String(FUTURE)
  });
  const mock = installFetchMock(() => jsonResponse(200, { code: 'OK', data: {} }));
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 ok', okSession(result.status), JSON.stringify(result));
    check('未发起网络请求', mock.calls.length === 0, `calls=${mock.calls.length}`);
    check('凭证未被改动', storage.getItem(TOKEN_KEY) === 'at');
  } finally {
    mock.restore();
  }
}

console.log('\n3. refreshed：access 过期，自动续期并落盘');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [REFRESH_KEY]: 'rt-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(() => jsonResponse(200, {
    code: 'OK',
    message: 'ok',
    data: {
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      accessTokenExpiresAt: FUTURE
    }
  }));
  try {
    const client = makeExpiredClient(storage);
    const result = await client.ensureSession();
    check('返回 refreshed', result.status === SESSION_STATUS.REFRESHED, JSON.stringify(result));
    check('恰好一次续期请求', mock.calls.length === 1, `calls=${mock.calls.length}`);
    check('续期打到 /auth/refresh', mock.calls[0]?.url === `${IDENTITY_BASE}/auth/refresh`, mock.calls[0]?.url);
    check('请求携带旧 refresh token', String(mock.calls[0]?.body || '').includes('rt-old'), mock.calls[0]?.body);
    check('新 access token 已落盘', storage.getItem(TOKEN_KEY) === 'at-new', storage.getItem(TOKEN_KEY));
    check('新 refresh token 已落盘', storage.getItem(REFRESH_KEY) === 'rt-new', storage.getItem(REFRESH_KEY));
    const again = await client.ensureSession();
    check('续期后再评估为 ok', okSession(again.status), JSON.stringify(again));
  } finally {
    mock.restore();
  }
}

console.log('\n4. expired：access 过期且无 refresh token，清残留');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(() => jsonResponse(200, { code: 'OK', data: {} }));
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 expired', result.status === SESSION_STATUS.EXPIRED, JSON.stringify(result));
    check('过期 access 已清除', storage.getItem(TOKEN_KEY) === null, storage.getItem(TOKEN_KEY));
    check('未发起网络请求', mock.calls.length === 0, `calls=${mock.calls.length}`);
  } finally {
    mock.restore();
  }
}

console.log('\n5. offline：续期网络失败，凭证必须保留');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [REFRESH_KEY]: 'rt-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 offline', result.status === SESSION_STATUS.OFFLINE, JSON.stringify(result));
    check('access token 保留', storage.getItem(TOKEN_KEY) === 'at-old', storage.getItem(TOKEN_KEY));
    check('refresh token 保留', storage.getItem(REFRESH_KEY) === 'rt-old', storage.getItem(REFRESH_KEY));
  } finally {
    mock.restore();
  }
}

console.log('\n6. offline：网关 5xx 错误页（SDK 兜底 REFRESH_FAILED），凭证必须保留');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [REFRESH_KEY]: 'rt-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(() => htmlResponse(502, '<html>Bad Gateway</html>'));
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 offline（不把网关故障当凭证失效）', result.status === SESSION_STATUS.OFFLINE, JSON.stringify(result));
    check('凭证保留', tokensKept(storage));
  } finally {
    mock.restore();
  }
}

console.log('\n7. expired：服务端 4xx 业务码明确拒绝，凭证清除');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [REFRESH_KEY]: 'rt-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(() => jsonResponse(401, {
    code: '1050301',
    message: '会话续期失败'
  }));
  try {
    const result = await makeExpiredClient(storage).ensureSession();
    check('返回 expired', result.status === SESSION_STATUS.EXPIRED, JSON.stringify(result));
    check('access token 已清除', storage.getItem(TOKEN_KEY) === null, storage.getItem(TOKEN_KEY));
    check('refresh token 已清除', storage.getItem(REFRESH_KEY) === null, storage.getItem(REFRESH_KEY));
  } finally {
    mock.restore();
  }
}

console.log('\n8. 单飞：并发 ensureSession 只发一次续期请求');
{
  const storage = createMemoryStorage({
    [TOKEN_KEY]: 'at-old',
    [REFRESH_KEY]: 'rt-old',
    [EXPIRES_KEY]: String(PAST)
  });
  const mock = installFetchMock(() => jsonResponse(200, {
    code: 'OK',
    data: { accessToken: 'at-new', refreshToken: 'rt-new', accessTokenExpiresAt: FUTURE }
  }));
  try {
    const client = makeExpiredClient(storage);
    const [a, b] = await Promise.all([client.ensureSession(), client.ensureSession()]);
    check('两个并发调用都返回 refreshed',
      a.status === SESSION_STATUS.REFRESHED && b.status === SESSION_STATUS.REFRESHED,
      `${a.status}/${b.status}`);
    check('续期请求只发一次', mock.calls.length === 1, `calls=${mock.calls.length}`);
  } finally {
    mock.restore();
  }
}

console.log('\n9. 共享单例：getSharedIdentity() 全局唯一');
{
  resetSharedIdentity();
  const a = getSharedIdentity();
  const b = getSharedIdentity();
  check('两次取到同一实例', a === b);
  resetSharedIdentity();
  const c = getSharedIdentity();
  check('重置后生成新实例', c !== a && c === getSharedIdentity());
  resetSharedIdentity();
}

// ── 汇总 ──────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`❌ 身份会话验证失败：${failures.length} 项`);
  for (const f of failures) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(`✅ 通过：${passed} 项断言（自动登录会话恢复全分支 + 单飞 + 共享单例）`);
