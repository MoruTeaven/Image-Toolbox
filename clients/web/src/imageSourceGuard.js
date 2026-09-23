/**
 * imageSourceGuard.js
 * Web 端 ?img= 参数的来源校验。
 *
 * 背景：Web 版曾把 URL 里的 ?img=<任意字符串> 直接塞进 window.__imageSource，
 * 再原样交给 fabric.Image.fromURL 加载。任何第三方站点只要构造一条
 * `https://本站/?img=https://攻击者/xx.png` 的链接，就能诱导用户在该页面上
 * 加载并绘制攻击者的图片，造成跨域污染与信息泄露面。
 *
 * 本模块只做一件事：判定一个字符串是否允许作为图片源。
 * 独立成模块的原因——它是纯函数逻辑，不依赖 DOM，便于单测与复用。
 *
 * 允许的来源：
 *   1. data:image/*;base64,...  —— 站内粘贴/上传形成的 dataURL
 *   2. blob:                    —— 站内 Blob URL
 *   3. 同源相对路径（/foo.png、foo.png、./foo.png、../foo.png）
 *   4. 同源绝对地址（与当前页面 protocol + host + port 完全一致）
 *   5. 显式白名单中的 https 域名
 *
 * 明确拒绝：http:、javascript:、file:、ftp: 等非白名单协议，
 * 以及所有未列入白名单的跨源地址。
 */

/**
 * 允许外部加载的图片来源白名单（host 精确匹配，含其子域）。
 * 为空表示不信任任何跨源地址；需要时在此按需追加可信图床。
 * @type {string[]}
 */
export const TRUSTED_IMAGE_HOSTS = [];

/** 允许的协议白名单：只有这些协议可以作为图片源。 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'data:', 'blob:']);

/** dataURL 允许的 MIME 前缀：必须是图片，避免把 data:text/html 当图片加载。 */
const DATA_URL_IMAGE_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * 判断 host 是否命中白名单（精确匹配或为其子域）。
 * @param {string} host
 * @returns {boolean}
 */
function _isTrustedHost(host) {
  const target = String(host || '').toLowerCase();
  if (!target) return false;

  return TRUSTED_IMAGE_HOSTS.some((entry) => {
    const allowed = String(entry || '').toLowerCase().trim();
    if (!allowed) return false;
    if (target === allowed) return true;
    // 允许子域：img.example.com 命中 example.com
    return target.endsWith(`.${allowed}`);
  });
}

/**
 * 校验一个候选图片源是否允许加载。
 *
 * @param {string} raw - 待校验的图片源字符串（通常来自 URL 参数）
 * @param {string} [pageHref] - 当前页面地址，用于同源判断；
 *                              默认取 window.location.href
 * @returns {{ ok: boolean, value: string|null, reason: string }}
 */
export function validateImageSource(raw, pageHref) {
  if (typeof raw !== 'string') {
    return { ok: false, value: null, reason: 'not-a-string' };
  }

  const source = raw.trim();
  if (!source) {
    return { ok: false, value: null, reason: 'empty' };
  }

  // 含控制字符/换行的输入直接拒绝：这类输入常见于协议走私尝试
  // （如 "java\nscript:..."），不做任何清洗，直接拒绝更安全。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(source)) {
    return { ok: false, value: null, reason: 'control-characters' };
  }

  // ── dataURL：必须是 base64 编码的图片 ──
  if (/^data:/i.test(source)) {
    if (!DATA_URL_IMAGE_PREFIX.test(source)) {
      return { ok: false, value: null, reason: 'data-url-not-image' };
    }
    return { ok: true, value: source, reason: 'data-url' };
  }

  // ── blob: ──
  // blob URL 形如 blob:<origin>/<uuid>，天然绑定创建它的 origin，
  // 跨源 blob 实际加载不到。这里仍比对本源，保持「同源」模型一致，
  // 也避免将来把该值放进 DOM/CSS 时引入跨源注入面。
  if (/^blob:/i.test(source)) {
    let blobBase;
    try {
      blobBase = new URL(pageHref || (typeof window !== 'undefined' ? window.location.href : ''));
    } catch (e) {
      return { ok: false, value: null, reason: 'no-base-url' };
    }

    // 用 URL 解析取出内嵌 origin，而不是按 '/' 切分：
    // origin 本身可能含端口（https://a.com:8080），切分会截断。
    let blobOrigin = '';
    try {
      blobOrigin = new URL(source).origin;
    } catch (e) {
      return { ok: false, value: null, reason: 'blob-unparsable' };
    }

    if (!blobOrigin || blobOrigin !== blobBase.origin) {
      return { ok: false, value: null, reason: 'blob-cross-origin' };
    }
    return { ok: true, value: source, reason: 'blob-url' };
  }

  // 解析相对/绝对地址。以页面地址为基准解析，相对路径天然落到同源。
  let base;
  try {
    base = new URL(pageHref || (typeof window !== 'undefined' ? window.location.href : ''));
  } catch (e) {
    return { ok: false, value: null, reason: 'no-base-url' };
  }

  let resolved;
  try {
    resolved = new URL(source, base);
  } catch (e) {
    return { ok: false, value: null, reason: 'unparsable' };
  }

  // 协议必须在白名单内
  if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) {
    return { ok: false, value: null, reason: `blocked-protocol:${resolved.protocol}` };
  }

  // 同源放行（protocol + host + port 全等）
  if (resolved.protocol === base.protocol
    && resolved.host === base.host
    && resolved.origin === base.origin) {
    return { ok: true, value: resolved.href, reason: 'same-origin' };
  }

  // 跨源的 https 地址：仅白名单域名放行
  if (resolved.protocol === 'https:' && _isTrustedHost(resolved.hostname)) {
    return { ok: true, value: resolved.href, reason: 'trusted-host' };
  }

  return { ok: false, value: null, reason: 'untrusted-origin' };
}

/**
 * 校验并写入 window.__imageSource。
 *
 * 被拒绝时打印一条 warn 并返回 false，调用方据此决定是否提示用户。
 *
 * @param {string} raw - ?img= 参数值
 * @param {object} [win] - 目标 window（便于测试注入），默认全局 window
 * @param {string} [pageHref] - 当前页面地址，用于解析同源相对路径
 * @returns {{ ok: boolean, reason: string }}
 */
export function applyImageSourceParam(raw, win, pageHref) {
  const target = win || (typeof window !== 'undefined' ? window : null);
  const href = pageHref || (target && target.location ? target.location.href : undefined);
  const result = validateImageSource(raw, href);

  if (!result.ok) {
    console.warn('[web] 已拒绝非白名单的 ?img= 参数:', result.reason);
    return { ok: false, reason: result.reason };
  }

  if (target) {
    target.__imageSource = result.value;
  }
  return { ok: true, reason: result.reason };
}
