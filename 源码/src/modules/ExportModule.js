import BaseModule from './BaseModule.js';

/**
 * 导出模块 — 将编辑结果导出为图片文件或复制到剪贴板
 */
class ExportModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      format: 'png',
      quality: 1,
      multiplier: 1,
      ...defaultOptions,
    });
  }

  /**
   * 导出为文件 — 先弹保存对话框，用户选择格式后自动匹配导出
   */
  async exportToFile() {
    if (typeof window.showSaveImageDialog !== 'function') {
      // 降级方案：默认 PNG
      const dataURL = this.exportToDataURL('png');
      if (!dataURL) return;
      this._browserDownload(dataURL, 'edited.png');
      return;
    }

    // 1. 弹出保存对话框，用户通过过滤器选择 PNG/JPEG/WebP
    const filePath = window.showSaveImageDialog('edited');
    if (!filePath) return; // 用户取消

    // 2. 从文件扩展名推断格式
    const ext = filePath.split('.').pop().toLowerCase();
    const formatMap = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
    const fmt = formatMap[ext] || 'png';
    const q = fmt === 'png' ? 1 : (this.options.quality ?? 1);

    // 3. 按选定格式生成 dataURL
    const dataURL = this.exportToDataURL(fmt, q);
    if (!dataURL) return;

    // 4. 写入文件
    const success = window.writeImageFile(filePath, dataURL);
    if (success) {
      this._showToast('图片已保存', 'success');
    }
  }

  /**
   * 导出到剪贴板
   */
  async exportToClipboard() {
    const dataURL = this.exportToDataURL('png', 1, { trimToImage: true });
    if (!dataURL) return;

    if (typeof window.copyImageToClipboard === 'function') {
      window.copyImageToClipboard(dataURL);
      this._showToast('已复制到剪贴板', 'success');
    } else {
      // 降级方案：使用 Clipboard API
      try {
        const blob = await (await fetch(dataURL)).blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
        this._showToast('已复制到剪贴板', 'success');
      } catch (err) {
        console.error('[ExportModule] 剪贴板操作失败:', err);
        this._showToast('复制失败', 'error');
      }
    }
  }

  /**
   * 获取 DataURL
   * @param {string} [format] - 'png' | 'jpeg' | 'webp'
   * @param {number} [quality] - 0~1
   * @param {object} [options]
   * @returns {string|null}
   */
  exportToDataURL(format, quality, options = {}) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return null;

    const fmt = format || 'png';
    const q = quality ?? 1;
    const dataURLOptions = {
      format: fmt,
      quality: q,
      multiplier: this.options.multiplier || 1,
    };

    if (options.trimToImage) {
      const bounds = this._getImageExportBounds();
      if (bounds) {
        Object.assign(dataURLOptions, bounds);
      }
    }

    return this._toDataURL(dataURLOptions, {
      resetViewport: !!options.trimToImage,
      transparentBackground: !!options.trimToImage,
    });
  }

  /**
   * 带选项导出
   */
  exportWithOptions(options = {}) {
    const opts = {
      format: 'png',
      multiplier: 1,
      quality: 1,
      ...options,
    };
    return this.exportToDataURL(opts.format, opts.quality);
  }

  _toDataURL(dataURLOptions, options = {}) {
    const canvas = this.canvasManager.canvas;
    const viewportTransform = canvas.viewportTransform?.slice();
    const backgroundColor = canvas.backgroundColor;

    try {
      if (options.resetViewport) {
        canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
      }
      if (options.transparentBackground) {
        canvas.backgroundColor = null;
      }
      return canvas.toDataURL(dataURLOptions);
    } finally {
      if (viewportTransform) {
        canvas.viewportTransform = viewportTransform;
      }
      canvas.backgroundColor = backgroundColor;
      canvas.requestRenderAll();
    }
  }

  _getImageExportBounds() {
    const canvas = this.canvasManager.canvas;
    const clipBounds = this._getObjectBounds(canvas.clipPath);
    if (clipBounds) {
      return this._normalizeBounds(clipBounds);
    }

    const imageBounds = this._getObjectBounds(this.canvasManager.originalImage);
    if (imageBounds) {
      return this._normalizeBounds(imageBounds);
    }

    return null;
  }

  _getObjectBounds(obj) {
    if (!obj) return null;

    try {
      obj.setCoords?.();
      const rect = obj.getBoundingRect?.(true, true);
      if (rect && this._isValidBounds(rect)) {
        return rect;
      }
    } catch (err) {
      console.warn('[ExportModule] 获取导出边界失败，使用备用计算:', err);
    }

    const scaleX = obj.scaleX ?? 1;
    const scaleY = obj.scaleY ?? 1;
    return {
      left: obj.left ?? 0,
      top: obj.top ?? 0,
      width: (obj.width ?? 0) * scaleX,
      height: (obj.height ?? 0) * scaleY,
    };
  }

  _normalizeBounds(bounds) {
    if (!this._isValidBounds(bounds)) return null;

    const left = Math.floor(bounds.left);
    const top = Math.floor(bounds.top);
    const right = Math.ceil(bounds.left + bounds.width);
    const bottom = Math.ceil(bounds.top + bounds.height);

    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  _isValidBounds(bounds) {
    return Number.isFinite(bounds.left)
        && Number.isFinite(bounds.top)
        && Number.isFinite(bounds.width)
        && Number.isFinite(bounds.height)
        && bounds.width > 0
        && bounds.height > 0;
  }

  /**
   * 浏览器下载（降级方案）
   */
  _browserDownload(dataURL, filename) {
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * 显示 Toast 提示
   * @param {string} message - 提示文字
   * @param {'success'|'error'} type - 类型
   */
  _showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const icons = {
      success: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v4M8 11h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `${icons[type] || ''}<span>${message}</span>`;
    document.body.appendChild(toast);

    toast.addEventListener('animationend', () => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
  }

  activate() {
    super.activate();
  }

  deactivate() {
    super.deactivate();
  }
}

export default ExportModule;
