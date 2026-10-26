/**
 * ClipboardPort — 非 UI 层的系统剪贴板入口
 *
 * 背景
 * ----
 * ExportModule 直接调 `navigator.clipboard.write([...])`，
 * AccountPage 又自己实现了一遍「navigator.clipboard → execCommand」降级。
 * 剪贴板是纯粹的宿主能力，不该由业务模块和 UI 组件各自直取浏览器 API。
 *
 * 取值优先级（由调用方按能力选择）：
 *   1. 注入实现（测试 / 特殊平台）
 *   2. HostAdapter.clipboard（宿主原生，uTools / ZTools 主路径）
 *   3. DomPort 的 navigator.clipboard（Web 端标准 API）
 */

import { getDomPort } from './DomPort.js';

let _hostAdapter = null;
let _impl = null;

/**
 * 注入宿主适配器（提供 clipboard.writeImage/writeText/readText）。
 * @param {object|null} hostAdapter
 */
export function setClipboardHost(hostAdapter) {
  _hostAdapter = hostAdapter || null;
}

/**
 * 注入自定义实现（测试用）。
 * @param {object|null} impl
 */
export function setClipboardImpl(impl) {
  _impl = impl || null;
}

/** 清空注入（测试用）。 */
export function resetClipboardPort() {
  _hostAdapter = null;
  _impl = null;
}

const _navigatorClipboard = () => getDomPort()?.getNavigator?.()?.clipboard ?? null;

/**
 * 把图片 dataURL 写入剪贴板。
 * @param {string} dataURL
 * @returns {Promise<boolean>}
 */
export async function writeImage(dataURL) {
  if (!dataURL) return false;

  if (_impl?.writeImage) {
    return !!await _impl.writeImage(dataURL);
  }

  // 宿主原生剪贴板
  if (typeof _hostAdapter?.copyImage === 'function') {
    const ok = await _hostAdapter.copyImage(dataURL);
    if (ok) return true;
  }

  // Web 端：ClipboardItem（Chromium 系）
  const clipboard = _navigatorClipboard();
  if (!clipboard?.write) return false;

  try {
    const response = await fetch(dataURL);
    const blob = await response.blob();
    await clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch (e) {
    console.error('[ClipboardPort] 写入图片失败:', e);
    return false;
  }
}

/**
 * 写入纯文本。
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function writeText(text) {
  if (typeof text !== 'string') return false;

  if (_impl?.writeText) {
    return !!await _impl.writeText(text);
  }

  if (typeof _hostAdapter?.writeText === 'function') {
    try {
      const ok = await _hostAdapter.writeText(text);
      if (ok) return true;
    } catch (e) {
      console.warn('[ClipboardPort] 宿主写入文本失败，降级到浏览器 API:', e);
    }
  }

  const clipboard = _navigatorClipboard();
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('[ClipboardPort] navigator.clipboard 写入失败:', e);
    }
  }

  return false;
}

/**
 * 读取纯文本。
 * @returns {Promise<string|null>}
 */
export async function readText() {
  if (_impl?.readText) {
    return _impl.readText();
  }

  if (typeof _hostAdapter?.readText === 'function') {
    try {
      const text = await _hostAdapter.readText();
      if (text !== null && text !== undefined) return String(text);
    } catch (e) {
      console.warn('[ClipboardPort] 宿主读取文本失败，降级到浏览器 API:', e);
    }
  }

  const clipboard = _navigatorClipboard();
  if (clipboard?.readText) {
    try {
      return await clipboard.readText();
    } catch (e) {
      console.warn('[ClipboardPort] navigator.clipboard 读取失败:', e);
    }
  }

  return null;
}
