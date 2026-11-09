import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { SAVE_STATUS, normalizeSaveResult } from '../adapters/BaseHostAdapter.js';
import { downloadFile as downloadViaBrowser } from '../ports/DownloadPort.js';
import { writeImage as writeImageToClipboard } from '../ports/ClipboardPort.js';

/**
 * 导出模块 — 将编辑结果导出为图片文件或复制到剪贴板
 *
 * 接受可选 host adapter 注入。未注入时降级到浏览器原生行为。
 */

// 浏览器画布边长硬上限（Chrome/Firefox 约 16384px，即 2^14）：
// 导出画布超过该尺寸会静默产出空白文件，倍率补偿时按此截断
const MAX_EXPORT_EDGE_PX = 16384;
class ExportModule extends BaseModule {
  /**
   * @param {import('../CanvasManager.js').default} canvasManager
   * @param {import('../HistoryManager.js').default} historyManager
   * @param {object} [defaultOptions]
   * @param {object} [host]
   */
  constructor(canvasManager, historyManager, defaultOptions = {}, host = null) {
    super(canvasManager, historyManager, {
      format: 'png',
      quality: 1,
      multiplier: 1,
      ...defaultOptions,
    });
    this._host = host;
  }

  /**
   * 注入 host adapter（可在运行时设置）。
   * @param {object} host
   */
  setHost(host) {
    this._host = host;
  }

  /**
   * 导出为文件 — 先弹保存对话框，用户选择格式后自动匹配导出
   *
   * 所有失败分支都必须给出用户可见的提示：此前 host.saveImage 返回 false
   * 时直接 return，界面毫无反应，用户会误以为已保存而关闭窗口丢失编辑成果。
   * @param {string} [presetFormat] - 预设格式 ('png'|'jpeg'|'webp')，优先于对话框选择
   */
  async exportToFile(presetFormat) {
    // 如果指定了预设格式，直接使用该格式导出
    const format = presetFormat || null;

    // 优先使用 host adapter 的原生对话框 + 写入能力
    if (this._host?.showSaveImageDialog && this._host?.writeImageFile) {
      const ext = format || 'png';
      // 传入格式，让保存对话框只显示该格式的过滤器
      const filePath = this._host.showSaveImageDialog(`edited.${ext}`, ext);
      // 对话框返回空 = 用户主动取消，属于正常操作，不提示错误
      if (!filePath) {
        return;
      }

      // 如果有预设格式，强制使用；否则从文件名推断
      const actualFormat = format || this._getFormatFromFilePath(filePath);
      const dataURL = this.exportToDataURL(actualFormat);
      if (!dataURL) {
        this._notifyToast('导出失败：无法生成图片数据', 'error');
        return;
      }

      const result = normalizeSaveResult(this._host.writeImageFile(filePath, dataURL));
      this._reportSaveResult(result);
      return;
    }

    const actualFormat = format || 'png';
    const dataURL = this.exportToDataURL(actualFormat);
    if (!dataURL) {
      this._notifyToast('导出失败：无法生成图片数据', 'error');
      return;
    }

    // 次选：host adapter 的 saveImage（自带保存对话框）
    if (this._host?.saveImage) {
      let result;
      try {
        result = normalizeSaveResult(await this._host.saveImage(dataURL, `edited.${actualFormat}`));
      } catch (err) {
        // 宿主抛异常也算写入失败，不能让异常静默逃逸
        console.error('[ExportModule] 保存图片失败:', err);
        this._notifyToast('保存失败：' + (err?.message || '写入文件时出错'), 'error');
        return;
      }

      // 平台无保存能力时继续走浏览器下载降级，不当作失败打扰用户
      if (result.status === SAVE_STATUS.UNSUPPORTED) {
        this._browserDownload(dataURL, `edited.${actualFormat}`);
        return;
      }

      this._reportSaveResult(result);
      return;
    }

    // 降级：浏览器下载
    this._browserDownload(dataURL, `edited.${actualFormat}`);
  }

  /**
   * 根据保存结果给出用户提示。
   * - saved    → 成功提示
   * - canceled → 用户主动取消，静默（不是错误）
   * - failed   → 明确错误提示，绝不静默
   * @param {{ ok: boolean, status: string, reason: string|null }} result
   */
  _reportSaveResult(result) {
    if (result.status === SAVE_STATUS.SAVED || result.ok) {
      this._notifyToast('图片已保存', 'success');
      return;
    }
    if (result.status === SAVE_STATUS.CANCELED) {
      return;
    }
    this._notifyToast('保存失败：' + (result.reason || '无法写入文件'), 'error');
  }

  /**
   * 导出到剪贴板
   */
  async exportToClipboard() {
    const dataURL = this.exportToDataURL('png', 1, { trimToImage: true });
    if (!dataURL) return;

    // 宿主原生剪贴板优先，Web 端由 ClipboardPort 自动降级到 ClipboardItem API
    const ok = await writeImageToClipboard(dataURL);
    this._notifyToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
  }

  /**
   * 获取 DataURL
   *
   * 分辨率还原：图片加载后按 fitToCanvas 缩放显示（scale ≤ 1），画布尺寸跟随
   * 窗口容器——直接按画布尺寸导出会把输出分辨率绑死在窗口大小上（用户反馈的
   * 「导出后分辨率被更改」）。导出时按原图显示缩放反向补偿 multiplier，让输出
   * 分辨率回到图片资源的原始像素（裁剪场景 = 裁剪区域的原始像素）。
   *
   * @param {string} [format] - 'png' | 'jpeg' | 'webp'
   * @param {number} [quality] - 0~1
   * @param {object} [options]
   * @param {boolean} [options.trimToImage=true] - 按图片/裁剪边界导出，画布空白边距不进入结果
   * @param {number} [options.multiplier] - 显式倍率（传入正值时跳过自动补偿）
   * @returns {string|null}
   */
  exportToDataURL(format, quality, options = {}) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return null;

    const fmt = format || 'png';
    const q = quality ?? 1;

    const trimToImage = options.trimToImage !== false;
    let bounds = null;
    if (trimToImage) {
      bounds = this._getImageExportBounds();
    }

    const dataURLOptions = {
      format: fmt,
      quality: q,
      // 输出分辨率与设备像素比解耦：不同 DPR 的屏幕导出同一结果
      enableRetinaScaling: false
    };

    // 显式倍率优先；未指定时自动按原图显示缩放补偿（见 _getExportMultiplier）
    const explicitMultiplier = Number(options.multiplier);
    dataURLOptions.multiplier = (Number.isFinite(explicitMultiplier) && explicitMultiplier > 0)
      ? explicitMultiplier
      : this._getExportMultiplier();

    if (bounds) {
      Object.assign(dataURLOptions, bounds);
    }

    // 浏览器画布边长硬上限（Chrome ~16384px）：超出会静默产出空白导出文件。
    // 巨图补偿倍率过线时按上限截断，宁可降分辨率也不输出空白文件。
    const exportEdge = Math.max(
      bounds ? bounds.width : canvas.width,
      bounds ? bounds.height : canvas.height
    );
    if (dataURLOptions.multiplier * exportEdge > MAX_EXPORT_EDGE_PX) {
      dataURLOptions.multiplier = MAX_EXPORT_EDGE_PX / exportEdge;
    }

    return this._toDataURL(dataURLOptions, {
      // 视口缩放/平移只影响屏幕显示，不应改变导出内容与尺寸
      resetViewport: true,
      // 裁剪导出时保留图片透明像素；JPEG 无透明通道，保留背景色避免黑底
      transparentBackground: !!bounds && fmt !== 'jpeg'
    });
  }

  /**
   * 计算导出补偿倍率：把「画布显示坐标」还原成「图片原始像素坐标」。
   *
   * 图片按 fit 缩放显示（scaleX = scaleY ≤ 1），fabric.toDataURL 的 multiplier
   * 作用于整个画布，乘以 1/scale 后：导出像素数 = 显示边界 × (1/scale) =
   * 图片坐标系中的像素数。裁剪（clipPath）场景同样成立：裁剪边界显示尺寸 ÷
   * scale = 裁剪区域的原始像素数。
   *
   * fabric 的 multiplier 是单一标量，非等比手动变形（scaleX ≠ scaleY）与
   * 旋转场景按等比近似（以宽度方向为准）。
   * @returns {number}
   */
  _getExportMultiplier() {
    const img = this.canvasManager.originalImage;
    if (!img) return 1;

    const scale = Math.abs(Number(img.scaleX));
    if (!Number.isFinite(scale) || scale <= 0) return 1;

    return 1 / scale;
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

  _getFormatFromFilePath(filePath) {
    const ext = String(filePath || '').split('.').pop()?.toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'webp') return 'webp';
    return 'png';
  }

  _toDataURL(dataURLOptions, options = {}) {
    const canvas = this.canvasManager.canvas;
    const viewportTransform = canvas.viewportTransform?.slice();
    const backgroundColor = canvas.backgroundColor;

    try {
      this.canvasManager.refreshDynamicMosaics?.({ render: true });
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
   * 浏览器下载（降级方案）—— 经 DownloadPort，不再直接造 <a> 标签
   */
  _browserDownload(dataURL, filename) {
    downloadViaBrowser(dataURL, filename);
  }

  /**
   * 通过 eventBus 发送 Toast 事件，由 UI 层渲染。
   * @param {string} message
   * @param {'success'|'error'} type
   */
  _notifyToast(message, type = 'success') {
    eventBus.emit('toast:show', { message, type });
  }

  activate() {
    super.activate();
  }

  deactivate() {
    super.deactivate();
  }
}

export default ExportModule;
