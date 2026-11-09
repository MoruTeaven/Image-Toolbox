/**
 * AIPort — AI 能力的环境接合点（非 UI 层 AI 网络出口的唯一出口）
 *
 * 职责
 * ----
 * 1. 统一收口 AI 相关的网络访问（云端指令编辑走 OpenAI 兼容接口）。
 *
 * AI 能力注册表见 core/src/ai/AI_PROVIDERS.js（唯一权威来源）。
 */

import { getDomPort } from './DomPort.js';

/**
 * 通用资源获取出口（AI 相关的网络访问只允许经此方法）。
 * @param {string} url
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export function aiFetch(url, init) {
  const hostGlobal = getDomPort()?.getHostGlobal?.();
  const fetchFn = hostGlobal && typeof hostGlobal.fetch === 'function'
    ? hostGlobal.fetch.bind(hostGlobal)
    : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) {
    return Promise.reject(new Error('[AIPort] 当前环境无 fetch 能力'));
  }
  return fetchFn(url, init);
}
