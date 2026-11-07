/**
 * 文件标识 — 让历史记录跟随当前编辑的文件。
 *
 * 同一个文件再次打开应当得到相同的 key（这样它自己的历史能被找回），
 * 不同文件必须得到不同的 key（这样历史不会串）。
 *
 * 取值策略按可靠性排序：
 *   - File：文件名 + 字节数 + 最后修改时间，跨会话稳定；
 *   - 带文件名的 Blob（uTools 传工程文件时补的 name）：文件名 + 大小；
 *   - dataURL：内容轻量指纹（长度 + 采样哈希 + 首尾片段），不整串哈希，
 *     避免对大图 base64 做一次完整遍历；
 *   - 其它字符串（路径 / http(s) / blob: URL）：原样作为标识。
 *
 * 纯函数，无环境依赖（File 用 typeof 探测）。
 */

/**
 * 生成文件标识。
 * @param {File|Blob|string|null} source 图片来源（与 CanvasManager.loadImage 的入参一致）
 * @returns {string}
 */
export function buildFileKey(source) {
  if (!source) return 'unknown';

  if (typeof File !== 'undefined' && source instanceof File) {
    return `file|${source.name}|${source.size}|${source.lastModified}`;
  }

  if (typeof source === 'object') {
    const name = typeof source.name === 'string' ? source.name : '';
    const size = Number.isFinite(source.size) ? source.size : 0;
    return name ? `blob|${name}|${size}` : `blob|${size}`;
  }

  if (typeof source === 'string') {
    if (source.startsWith('data:')) return `data|${fingerprint(source)}`;
    return `url|${source}`;
  }

  return 'unknown';
}

/**
 * 轻量内容指纹：不遍历整个字符串（图片 base64 可能上 MB），
 * 按固定步长抽样求和，再拼上长度与首尾片段。
 * @param {string} text
 * @returns {string}
 */
function fingerprint(text) {
  const length = text.length;
  let hash = 0;
  const step = Math.max(1, Math.floor(length / 199));

  for (let i = 0; i < length; i += step) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }

  return `${length}|${hash.toString(36)}|${text.slice(0, 32)}|${text.slice(-32)}`;
}
