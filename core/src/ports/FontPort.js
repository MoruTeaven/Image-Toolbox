/**
 * FontPort — 系统字体能力的取得入口（非 UI 层用）
 *
 * 背景
 * ----
 * `utils/fonts.js` 过去直接读 `window.getSystemFonts` / `window.getSystemFontsAsync`
 * —— 那是 preload 挂在页面 window 上的注入函数。非 UI 层直接嗅探宿主全局，
 * 正是本次要收敛的耦合之一。
 *
 * 取值优先级：
 *   1. 注入的 provider（测试 / 非宿主环境）
 *   2. HostAdapter.system.getSystemFonts（宿主能力域，正规入口）
 *   3. DomPort 上的同名注入函数（未启用 contextIsolation 的宿主兼容路径）
 */

import { getDomPort } from './DomPort.js';

let _provider = null;
let _hostAdapter = null;

/**
 * 注入自定义字体提供者（测试用）。
 * @param {{getSystemFonts?: Function, getSystemFontsAsync?: Function}|null} provider
 */
export function setFontProvider(provider) {
  _provider = provider || null;
}

/**
 * 注入宿主适配器。
 * @param {object|null} hostAdapter
 */
export function setFontHost(hostAdapter) {
  _hostAdapter = hostAdapter || null;
}

/** 清空注入（测试用）。 */
export function resetFontPort() {
  _provider = null;
  _hostAdapter = null;
}

/**
 * 同步获取系统字体列表。
 * @returns {string[]} 取不到时返回空数组
 */
export function getSystemFonts() {
  if (typeof _provider?.getSystemFonts === 'function') {
    try {
      return _normalize(_provider.getSystemFonts());
    } catch (e) {
      console.warn('[FontPort] 注入的字体提供者失败:', e);
      return [];
    }
  }

  // 宿主能力域（BaseHostAdapter.system.getSystemFonts）
  const hostFonts = _hostAdapter?.system?.getSystemFonts;
  if (typeof hostFonts === 'function') {
    try {
      const fonts = _normalize(hostFonts.call(_hostAdapter.system));
      if (fonts.length > 0) return fonts;
    } catch (e) {
      console.warn('[FontPort] 宿主获取系统字体失败:', e);
    }
  }

  // 兼容：preload 直接挂在页面上的注入函数
  const injected = getDomPort()?.getSystemFonts;
  if (typeof injected === 'function') {
    try {
      return _normalize(injected());
    } catch (e) {
      console.warn('[FontPort] 注入函数获取系统字体失败:', e);
    }
  }

  return [];
}

/**
 * 异步获取系统字体列表（宿主支持时走异步，避免主线程阻塞）。
 * @returns {Promise<string[]>}
 */
export function getSystemFontsAsync() {
  if (typeof _provider?.getSystemFontsAsync === 'function') {
    return Promise.resolve(_provider.getSystemFontsAsync()).then(_normalize).catch((e) => {
      console.warn('[FontPort] 注入的异步字体提供者失败:', e);
      return [];
    });
  }

  const hostAsync = _hostAdapter?.system?.getSystemFontsAsync;
  if (typeof hostAsync === 'function') {
    return Promise.resolve(hostAsync.call(_hostAdapter.system)).then(_normalize).catch((e) => {
      console.warn('[FontPort] 宿主异步获取系统字体失败:', e);
      return [];
    });
  }

  return Promise.resolve(getSystemFonts());
}

/**
 * 当前环境是否具备系统字体能力。
 * @returns {boolean}
 */
export function hasSystemFontCapability() {
  if (typeof _provider?.getSystemFonts === 'function') return true;
  if (typeof _provider?.getSystemFontsAsync === 'function') return true;
  if (typeof _hostAdapter?.system?.getSystemFonts === 'function') return true;
  if (typeof _hostAdapter?.system?.getSystemFontsAsync === 'function') return true;
  return typeof getDomPort()?.getSystemFonts === 'function';
}

function _normalize(fonts) {
  if (!Array.isArray(fonts)) return [];
  return fonts.map((font) => String(font || '').trim()).filter(Boolean);
}
