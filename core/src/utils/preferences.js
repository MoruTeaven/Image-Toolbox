/**
 * PreferenceStore — 界面偏好的统一读写入口（非 UI 层用）
 *
 * 背景
 * ----
 * 偏好项（主题、工具栏展开、侧栏布局等）过去散落在各处直接读写
 * `localStorage`，带来三个问题：
 *   1. 违反 AGENTS.md §3（core/ 不直接访问 localStorage）；
 *   2. 宿主（uTools/ZTools）的 dbStorage 与浏览器 localStorage 是两套存储，
 *      直写 localStorage 会让偏好无法跟随宿主账号同步；
 *   3. 写入失败（隐私模式、配额满）无处上报，静默丢数据。
 *
 * 取值顺序：宿主适配器 storage → DomPort 存储 → 内存兜底。
 * 三者都不可用时静默降级为内存存储，保证功能可用、只是不持久。
 *
 * 与 UI 层的分工：UI 层组件可以继续用本模块，但不强制 —— UI 层记忆自己的
 * 界面偏好属于正当职责，不算越界（见 AGENTS.md §3）。
 */

import { getDomPort } from '../ports/DomPort.js';

// 宿主适配器存储不可用时的内存兜底，避免同一会话内偏好反复丢失
const _memoryFallback = new Map();

let _hostAdapter = null;

/**
 * 注入宿主适配器（提供 storage.get/set/remove）。
 * 由装配处调用；不注入时自动走 DomPort 存储 / 内存。
 * @param {object|null} hostAdapter
 */
export function setPreferenceHost(hostAdapter) {
  _hostAdapter = hostAdapter || null;
}

/** 清空注入与内存兜底（测试用）。 */
export function resetPreferenceStore() {
  _hostAdapter = null;
  _memoryFallback.clear();
}

const _hostStorage = () => {
  const storage = _hostAdapter?.storage;
  if (!storage) return null;
  if (typeof storage.get !== 'function' || typeof storage.set !== 'function') return null;
  return storage;
};

/**
 * 读取一个偏好值。
 * @param {string} key
 * @returns {string|null}
 */
export function getPreference(key) {
  if (!key) return null;

  const host = _hostStorage();
  if (host) {
    try {
      const value = host.get(key);
      if (value !== null && value !== undefined) return String(value);
    } catch (e) {
      console.warn('[PreferenceStore] 宿主存储读取失败，降级到本地存储:', e);
    }
  }

  try {
    const storage = getDomPort()?.getStorage?.();
    const value = storage?.getItem?.(key);
    if (value !== null && value !== undefined) return String(value);
  } catch (e) {
    console.warn('[PreferenceStore] 本地存储读取失败:', e);
  }

  return _memoryFallback.has(key) ? _memoryFallback.get(key) : null;
}

/**
 * 写入一个偏好值。任何一层成功即视为成功。
 * @param {string} key
 * @param {string|number|boolean} value
 * @returns {boolean} 是否至少写入了一层持久化存储
 */
export function setPreference(key, value) {
  if (!key) return false;

  const text = String(value);
  _memoryFallback.set(key, text);

  let persisted = false;

  const host = _hostStorage();
  if (host) {
    try {
      host.set(key, text);
      persisted = true;
    } catch (e) {
      console.warn('[PreferenceStore] 宿主存储写入失败:', e);
    }
  }

  try {
    const storage = getDomPort()?.getStorage?.();
    if (storage?.setItem) {
      storage.setItem(key, text);
      persisted = true;
    }
  } catch (e) {
    // 隐私模式 / 配额满：偏好记忆丢失不影响功能，不升级为错误
    console.warn('[PreferenceStore] 本地存储写入失败:', e);
  }

  return persisted;
}

/**
 * 删除一个偏好值。
 * @param {string} key
 */
export function removePreference(key) {
  if (!key) return;

  _memoryFallback.delete(key);

  const host = _hostStorage();
  if (host && typeof host.remove === 'function') {
    try {
      host.remove(key);
    } catch (e) {
      console.warn('[PreferenceStore] 宿主存储删除失败:', e);
    }
  }

  try {
    getDomPort()?.getStorage?.()?.removeItem?.(key);
  } catch (e) {
    console.warn('[PreferenceStore] 本地存储删除失败:', e);
  }
}

/**
 * 读取一个 JSON 偏好值。
 * @param {string} key
 * @param {*} fallback 解析失败或不存在时的返回值
 * @returns {*}
 */
export function getJSONPreference(key, fallback = null) {
  const raw = getPreference(key);
  if (raw === null) return fallback;

  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

/**
 * 写入一个 JSON 偏好值。
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
export function setJSONPreference(key, value) {
  try {
    return setPreference(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[PreferenceStore] 偏好序列化失败:', e);
    return false;
  }
}
