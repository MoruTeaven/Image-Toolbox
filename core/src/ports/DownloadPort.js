/**
 * DownloadPort — 浏览器侧「下载/另存」降级通道
 *
 * 背景
 * ----
 * 三处各自实现了一遍「造 <a> → 设 download → 挂 body → click → 摘掉」：
 * ExportModule 的图片另存、ora 的工程文件另存、StatusBar 的导出。这段逻辑
 * 既重复又直接耦合 DOM，且散落在非 UI 层。
 *
 * 注意职责划分：宿主侧保存（对话框 + 写文件）走 HostAdapter，本端口只承担
 * 「当前环境没有宿主保存能力时，用浏览器下载兜底」这一件事。
 */

import { getDomPort } from './DomPort.js';

let _impl = null;

/**
 * 注入下载实现（例如 Web 端想改用 File System Access API）。
 * @param {((blob: Blob, filename: string) => boolean)|null} impl
 */
export function setDownloadImpl(impl) {
  _impl = typeof impl === 'function' ? impl : null;
}

/** 清空注入（测试用）。 */
export function resetDownloadPort() {
  _impl = null;
}

/**
 * 触发一次浏览器下载。
 *
 * @param {string|Blob} data dataURL 或 Blob
 * @param {string} filename 建议文件名（含扩展名）
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function downloadFile(data, filename) {
  if (_impl) {
    try {
      const ok = _impl(data, filename);
      return { ok: !!ok, reason: ok ? null : 'impl-rejected' };
    } catch (e) {
      console.error('[DownloadPort] 注入的下载实现失败:', e);
      return { ok: false, reason: e?.message || 'impl-threw' };
    }
  }

  const port = getDomPort();
  const link = port?.createElement?.('a');
  const body = port?.getBody?.();

  if (!link || !body) {
    return { ok: false, reason: 'no-dom' };
  }

  let objectUrl = null;
  try {
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      objectUrl = URL.createObjectURL(data);
      link.href = objectUrl;
    } else {
      link.href = String(data);
    }

    link.download = filename || 'download';
    body.appendChild(link);
    link.click();
    body.removeChild(link);

    return { ok: true, reason: null };
  } catch (e) {
    console.error('[DownloadPort] 下载失败:', e);
    return { ok: false, reason: e?.message || 'download-threw' };
  } finally {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) {
        // 回收失败不影响下载结果
      }
    }
  }
}

/**
 * 当前环境是否具备下载能力（用于决定是否走降级分支）。
 * @returns {boolean}
 */
export function canDownload() {
  if (_impl) return true;
  const port = getDomPort();
  return !!(port?.createElement && port?.getBody);
}
