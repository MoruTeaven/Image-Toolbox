const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { clipboard, nativeImage } = require('electron');

const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

// ── 文件操作 ──
window.readImageFile = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = MIME_MAP[ext] || 'image/png';
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
};

const _detectImageMime = (buffer) => {
  if (!buffer || buffer.length < 4) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const start = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trimStart().toLowerCase();
  if (start.startsWith('<svg') || start.startsWith('<?xml')) return 'image/svg+xml';
  return 'image/png';
};

const _payloadItems = (payload) => {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : [payload];
};

const _toLocalPath = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\r\n]/.test(text)) return null;
  if (/^file:\/\//i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch (e) {
      console.error('[preload] file URL 解析失败:', e);
      return null;
    }
  }
  return text;
};

const _getImagePath = (value) => {
  const filePath = _toLocalPath(value);
  if (!filePath) return null;
  try {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    if (!MIME_MAP[ext]) return null;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return filePath;
  } catch (e) {
    return null;
  }
};

const _dataURLFromBase64 = (value) => {
  const base64 = value.replace(/\s/g, '');
  try {
    const buffer = Buffer.from(base64, 'base64');
    return 'data:' + _detectImageMime(buffer) + ';base64,' + base64;
  } catch (e) {
    return null;
  }
};

const _dataURLFromBytes = (value) => {
  if (!value) return null;
  let buffer = null;
  if (Buffer.isBuffer(value)) {
    buffer = value;
  } else if (value instanceof ArrayBuffer) {
    buffer = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (!buffer || buffer.length === 0) return null;
  return 'data:' + _detectImageMime(buffer) + ';base64,' + buffer.toString('base64');
};

const _normalizeImageString = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  if (/^data:image\//i.test(text)) return text;
  if (/^image\/[a-z0-9.+-]+;base64,/i.test(text)) return 'data:' + text;

  const imagePath = _getImagePath(text);
  if (imagePath) {
    try {
      return window.readImageFile(imagePath);
    } catch (e) {
      console.error('[preload] 读取 payload 图片文件失败:', e);
      return null;
    }
  }

  if (/^(https?:|blob:)/i.test(text)) return text;

  if (text.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    return _dataURLFromBase64(text);
  }

  return null;
};

const _normalizeImagePayload = (payload) => {
  for (const item of _payloadItems(payload)) {
    if (typeof item === 'string') {
      const source = _normalizeImageString(item);
      if (source) return source;
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    if (typeof item.toDataURL === 'function') {
      try {
        const source = item.toDataURL();
        if (source) return source;
      } catch (e) {
        console.error('[preload] payload.toDataURL 失败:', e);
      }
    }

    const candidates = [item.path, item.filePath, item.url, item.src, item.dataURL, item.data, item.base64];
    for (const candidate of candidates) {
      const source = _normalizeImageString(candidate);
      if (source) return source;
    }
  }

  return null;
};

const _escapeHtmlAttr = (value) => {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const _decodeHtmlAttr = (value) => {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
};

const _extractImageDataURLFromHTML = (html) => {
  if (typeof html !== 'string' || !html) return null;

  const quotedMatch = html.match(/\bsrc\s*=\s*(["'])(data:image\/[a-z0-9.+-]+;base64,[^"']+)\1/i);
  const unquotedMatch = quotedMatch ? null : html.match(/\bsrc\s*=\s*(data:image\/[a-z0-9.+-]+;base64,[^\s>]+)/i);
  const source = quotedMatch ? quotedMatch[2] : unquotedMatch?.[1];
  return source ? _normalizeImageString(_decodeHtmlAttr(source)) : null;
};

const _readImageDataURLFromClipboardHTML = () => {
  try {
    return _extractImageDataURLFromHTML(clipboard.readHTML());
  } catch (e) {
    console.error('[preload] 读取剪贴板 HTML 图片失败:', e);
    return null;
  }
};

window.getImageSourceFromPluginPayload = (type, payload) => {
  if (type === 'file' || type === 'files') {
    return _normalizeImagePayload(payload);
  }

  if (type === 'img') {
    return _readImageDataURLFromClipboardHTML()
      || _normalizeImagePayload(payload)
      || window.readImageFromClipboard();
  }

  return null;
};

window.writeImageFile = (filePath, dataURL) => {
  const matches = dataURL.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!matches) return false;
  const buffer = Buffer.from(matches[2], 'base64');
  fs.writeFileSync(filePath, buffer);
  return true;
};

// ── 剪贴板操作 ──
window.copyImageToClipboard = (dataURL) => {
  const img = nativeImage.createFromDataURL(dataURL);
  try {
    clipboard.write({
      image: img,
      html: '<img src="' + _escapeHtmlAttr(dataURL) + '" alt="image">',
    });
  } catch (e) {
    console.error('[preload] 写入透明剪贴板图片失败，降级为系统图片格式:', e);
    clipboard.writeImage(img);
  }
};

window.readImageFromClipboard = () => {
  const htmlImage = _readImageDataURLFromClipboardHTML();
  if (htmlImage) return htmlImage;

  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toDataURL();
};

// ── 导出文件对话框 ──
window.showSaveImageDialog = (defaultName) => {
  return utools.showSaveDialog({
    title: '保存图片',
    defaultPath: utools.getPath('pictures') + '/' + (defaultName || 'edited'),
    filters: [
      { name: 'PNG 图片', extensions: ['png'] },
      { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      { name: 'WebP 图片', extensions: ['webp'] },
    ],
  });
};

// ── 打开文件对话框 ──
window.showOpenImageDialog = () => {
  return utools.showOpenDialog({
    title: '选择图片',
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg'] },
    ],
    properties: ['openFile'],
  });
};

// ── uTools 用户信息 ──
window.getUtoolsUser = () => {
  try {
    if (typeof utools !== 'undefined' && typeof utools.getUser === 'function') {
      return utools.getUser();
    }
  } catch (e) {
    console.error('[preload] 获取 uTools 用户信息失败:', e);
  }
  return null;
};

// ── 插件生命周期 ──
utools.onPluginEnter(({ code, type, payload }) => {
  if (code === 'image-edit') {
    let imageSource = null;
    try {
      imageSource = window.getImageSourceFromPluginPayload(type, payload);
    } catch (e) {
      console.error('[preload] 解析外部图片失败:', e);
    }

    // 通过 window 对象将图片源传递给前端
    window.__imageSource = imageSource;

    // 动态调整窗口高度
    utools.setExpendHeight(560);
  }
});

// 插件退出时清理
utools.onPluginOut(() => {
  window.__imageSource = null;
});
