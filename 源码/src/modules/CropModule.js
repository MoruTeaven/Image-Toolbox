import BaseModule from './BaseModule.js';
import eventBus from '../core/EventBus.js';

/**
 * 剪切模块 — 图片裁剪
 * 使用 canvas.clipPath 实现非破坏性裁剪
 */
class CropModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      aspectRatio: null,  // null = 自由比例，或 {w, h} 如 {w:1, h:1}
      ...defaultOptions,
    });

    this._cropRect = null;
    this._maskRect = null;
    this._detachedCanvasClipPath = null;
    this._clipPathDetached = false;
    this._objectClipPathBackups = null;
    this._applyingCrop = false;
    this._isAdjusting = false;
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
  }

  activate(options = {}) {
    super.activate(options);  // 自动禁用所有对象交互

    const canvas = this.canvasManager.canvas;
    canvas.defaultCursor = 'crosshair';
    this._applyingCrop = false;
    this._detachCanvasClipPath();

    // 创建遮罩和裁剪框（这两个对象在 super.activate() 之后创建，
    // 因此不受 BaseModule 的禁用影响，各自显式设置了 selectable/evented）
    this._createMask();
    this._createCropRect();

    canvas.on('mouse:down', this._boundMouseDown);
    canvas.on('mouse:move', this._boundMouseMove);
    canvas.on('mouse:up', this._boundMouseUp);

    eventBus.emit('module:activated', 'crop');
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;

    canvas.off('mouse:down', this._boundMouseDown);
    canvas.off('mouse:move', this._boundMouseMove);
    canvas.off('mouse:up', this._boundMouseUp);

    this._removeCropOverlay();
    if (this._applyingCrop) {
      this._discardDetachedCanvasClipPath(false);
    } else {
      this._restoreDetachedCanvasClipPath(false);
    }
    this._applyingCrop = false;
    canvas.renderAll();

    super.deactivate();  // 恢复所有对象交互
  }

  setAspectRatio(ratio) {
    this.options.aspectRatio = ratio;
    if (!this._cropRect) return;

    this._cropRect.set({ lockUniScaling: !!ratio });
    if (ratio) {
      this._applyAspectRatioToCropRect('width');
    } else {
      this._cropRect.setCoords();
      this._updateMask();
    }
    eventBus.emit('crop:updated', this._getCropBounds());
  }

  applyPreset(presetName) {
    const ratioMap = {
      'crop-ratio-free': null,
      'crop-ratio-1-1': { w: 1, h: 1 },
      'crop-ratio-3-2': { w: 3, h: 2 },
      'crop-ratio-2-3': { w: 2, h: 3 },
      'crop-ratio-3-4': { w: 3, h: 4 },
      'crop-ratio-4-3': { w: 4, h: 3 },
      'crop-ratio-16-9': { w: 16, h: 9 },
      'crop-ratio-9-16': { w: 9, h: 16 },
    };

    if (!Object.prototype.hasOwnProperty.call(ratioMap, presetName)) return;
    this.setAspectRatio(ratioMap[presetName]);
  }

  /**
   * 执行裁剪
   */
  applyCrop() {
    if (!this._cropRect) return;
    const canvas = this.canvasManager.canvas;
    const clipRect = this._createClipPathFromSource(this._cropRect);
    if (this._detachedCanvasClipPath) {
      clipRect.clipPath = this._createClipPathFromSource(this._detachedCanvasClipPath);
    }

    this._saveStateBeforeCrop(canvas);
    this._clearTemporaryObjectClipPaths(false);

    canvas.clipPath = clipRect;
    this._detachedCanvasClipPath = null;
    this._clipPathDetached = false;
    this._applyingCrop = true;
    this._removeCropOverlay();
    canvas.renderAll();

    eventBus.emit('crop:applied');
    // 自动退出裁剪模式
    eventBus.emit('tool:requestChange', 'select');
  }

  /**
   * 取消裁剪
   */
  cancelCrop() {
    this._removeCropOverlay();
    this._restoreDetachedCanvasClipPath(false);
    this.canvasManager.canvas.renderAll();
    eventBus.emit('tool:requestChange', 'select');
  }

  // ── 内部方法 ──

  /**
   * 获取当前可视区域（canvas 坐标）
   * 解决放大/平移后裁剪框错位的问题
   */
  _getVisibleBounds() {
    const canvas = this.canvasManager.canvas;
    const vpt = canvas.viewportTransform;
    const zoom = vpt[0];           // 缩放比
    const panX = vpt[4];           // 水平平移
    const panY = vpt[5];           // 垂直平移

    // 屏幕坐标 (0,0) → canvas 坐标
    const left = -panX / zoom;
    const top = -panY / zoom;
    return {
      left,
      top,
      width: canvas.width / zoom,
      height: canvas.height / zoom,
    };
  }

  /**
   * 获取可视区域中心点（canvas 坐标）
   */
  _getVisibleCenter() {
    const vb = this._getVisibleBounds();
    return {
      x: vb.left + vb.width / 2,
      y: vb.top + vb.height / 2,
    };
  }

  _createMask() {
    const vb = this._getVisibleBounds();
    this._maskRect = new fabric.Rect({
      left: vb.left,
      top: vb.top,
      width: vb.width,
      height: vb.height,
      fill: 'rgba(0, 0, 0, 0.5)',
      selectable: false,
      evented: false,
      excludeFromExport: true,
      excludeFromLayer: true,
      absolutePositioned: true,
    });
    this.canvasManager.canvas.add(this._maskRect);
  }

  _createCropRect() {
    const canvas = this.canvasManager.canvas;
    const ratio = this.options.aspectRatio;
    const vb = this._getVisibleBounds();
    const center = this._getVisibleCenter();

    let w = vb.width * 0.7;
    let h = vb.height * 0.7;

    if (ratio) {
      // 按比例计算
      const ratioVal = ratio.w / ratio.h;
      if (w / h > ratioVal) {
        w = h * ratioVal;
      } else {
        h = w / ratioVal;
      }
    }

    this._cropRect = new fabric.Rect({
      left: center.x - w / 2,
      top: center.y - h / 2,
      width: w,
      height: h,
      fill: 'transparent',
      stroke: '#FFFFFF',
      strokeWidth: 1.5,
      strokeDashArray: [4, 4],
      selectable: true,
      evented: true,
      hasControls: true,
      hasBorders: true,
      cornerColor: '#FFFFFF',
      cornerSize: 8,
      cornerStyle: 'circle',
      transparentCorners: false,
      lockUniScaling: !!ratio,
      lockScalingFlip: true,
      excludeFromExport: true,
      excludeFromLayer: true,
      excludeFromProperty: true,
      excludeFromHistory: true,
      absolutePositioned: true,
    });

    // 更新遮罩挖空效果
    this._cropRect.on('moving', () => this._updateMask());
    this._cropRect.on('scaling', () => this._updateMask());
    this._cropRect.on('rotating', () => this._updateMask());
    this._cropRect.on('resizing', () => this._updateMask());

    canvas.add(this._cropRect);
    canvas.setActiveObject(this._cropRect);
    this._updateMask();
  }

  _updateMask() {
    if (!this._maskRect || !this._cropRect) return;

    const canvas = this.canvasManager.canvas;
    const vb = this._getVisibleBounds();

    // 遮罩跟随可视区域
    this._maskRect.set({
      left: vb.left,
      top: vb.top,
      width: vb.width,
      height: vb.height,
    });

    canvas.renderAll();
  }

  _getCropBounds() {
    if (!this._cropRect) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }

    const cr = this._cropRect;
    return {
      left: cr.left || 0,
      top: cr.top || 0,
      width: Math.max(1, Math.abs((cr.width || 0) * (cr.scaleX || 1))),
      height: Math.max(1, Math.abs((cr.height || 0) * (cr.scaleY || 1))),
    };
  }

  _setCropBounds(bounds) {
    if (!this._cropRect) return;

    this._cropRect.set({
      left: bounds.left,
      top: bounds.top,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      scaleX: 1,
      scaleY: 1,
    });
    this._cropRect.setCoords();
  }

  _getAspectRatioValue() {
    const ratio = this.options.aspectRatio;
    if (!ratio || !ratio.w || !ratio.h) return null;
    return ratio.w / ratio.h;
  }

  _applyAspectRatioToCropRect(changedProp = 'width') {
    const ratioVal = this._getAspectRatioValue();
    if (!this._cropRect || !ratioVal) return;

    const current = this._getCropBounds();
    const center = {
      x: current.left + current.width / 2,
      y: current.top + current.height / 2,
    };

    let width = current.width;
    let height = current.height;
    if (changedProp === 'height') {
      width = height * ratioVal;
    } else {
      height = width / ratioVal;
    }

    const bounds = this._fitCropBoundsToVisible({ left: current.left, top: current.top, width, height }, center, ratioVal);
    this._setCropBounds(bounds);
    this._updateMask();
  }

  _fitCropBoundsToVisible(bounds, center, ratioVal = null) {
    const vb = this._getVisibleBounds();
    const maxWidth = Math.max(1, vb.width);
    const maxHeight = Math.max(1, vb.height);
    let width = Math.max(1, bounds.width);
    let height = Math.max(1, bounds.height);

    if (ratioVal) {
      if (width > maxWidth) {
        width = maxWidth;
        height = width / ratioVal;
      }
      if (height > maxHeight) {
        height = maxHeight;
        width = height * ratioVal;
      }
    } else {
      width = Math.min(width, maxWidth);
      height = Math.min(height, maxHeight);
    }

    const nextCenter = center || {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    let left = nextCenter.x - width / 2;
    let top = nextCenter.y - height / 2;

    left = this._clamp(left, vb.left, vb.left + maxWidth - width);
    top = this._clamp(top, vb.top, vb.top + maxHeight - height);

    return { left, top, width, height };
  }

  _clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
  }

  _createClipPathFromSource(source) {
    const clipRect = new fabric.Rect({
      left: source.left || 0,
      top: source.top || 0,
      width: Math.max(1, source.width || 0),
      height: Math.max(1, source.height || 0),
      scaleX: source.scaleX == null ? 1 : source.scaleX,
      scaleY: source.scaleY == null ? 1 : source.scaleY,
      angle: source.angle || 0,
      skewX: source.skewX || 0,
      skewY: source.skewY || 0,
      flipX: !!source.flipX,
      flipY: !!source.flipY,
      originX: source.originX || 'left',
      originY: source.originY || 'top',
      rx: source.rx || 0,
      ry: source.ry || 0,
      fill: '#000',
      stroke: null,
      strokeWidth: 0,
      absolutePositioned: true,
      objectCaching: false,
    });
    if (source.clipPath) {
      clipRect.clipPath = this._createClipPathFromSource(source.clipPath);
    }
    clipRect.setCoords();
    return clipRect;
  }

  _detachCanvasClipPath() {
    const canvas = this.canvasManager.canvas;
    if (!canvas?.clipPath) return;

    this._detachedCanvasClipPath = canvas.clipPath;
    this._clipPathDetached = true;
    canvas.clipPath = null;
    this._applyTemporaryObjectClipPaths(this._detachedCanvasClipPath, false);
    this._requestRender();
  }

  _applyTemporaryObjectClipPaths(clipPath, render = true) {
    const canvas = this.canvasManager.canvas;
    if (!canvas || !clipPath) return;

    this._clearTemporaryObjectClipPaths(false);
    this._objectClipPathBackups = canvas.getObjects()
      .filter(obj => obj !== this._cropRect && obj !== this._maskRect)
      .map(obj => ({ obj, clipPath: obj.clipPath || null }));

    this._objectClipPathBackups.forEach(({ obj }) => {
      obj.set('clipPath', this._createClipPathFromSource(clipPath));
      obj.dirty = true;
    });

    if (render) this._requestRender();
  }

  _clearTemporaryObjectClipPaths(render = true) {
    if (!this._objectClipPathBackups) return;

    this._objectClipPathBackups.forEach(({ obj, clipPath }) => {
      obj.set('clipPath', clipPath || null);
      obj.dirty = true;
    });
    this._objectClipPathBackups = null;

    if (render) this._requestRender();
  }

  _restoreDetachedCanvasClipPath(render = true) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    this._clearTemporaryObjectClipPaths(false);
    if (this._clipPathDetached) {
      canvas.clipPath = this._detachedCanvasClipPath;
    }
    this._detachedCanvasClipPath = null;
    this._clipPathDetached = false;

    if (render) this._requestRender();
  }

  _discardDetachedCanvasClipPath(render = true) {
    this._clearTemporaryObjectClipPaths(false);
    this._detachedCanvasClipPath = null;
    this._clipPathDetached = false;

    if (render) this._requestRender();
  }

  _saveStateBeforeCrop(canvas) {
    const currentClipPath = canvas.clipPath;
    this._clearTemporaryObjectClipPaths(false);

    if (this._clipPathDetached) {
      canvas.clipPath = this._detachedCanvasClipPath;
    }

    this.history.saveState();
    canvas.clipPath = currentClipPath;
  }

  _requestRender() {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return;
    if (typeof canvas.requestRenderAll === 'function') {
      canvas.requestRenderAll();
    } else {
      canvas.renderAll();
    }
  }

  _removeCropOverlay() {
    const canvas = this.canvasManager.canvas;
    if (this._maskRect) {
      canvas.remove(this._maskRect);
      this._maskRect = null;
    }
    if (this._cropRect) {
      canvas.remove(this._cropRect);
      this._cropRect = null;
    }
  }

  // ── 鼠标事件（重置裁剪框） ──

  _onMouseDown(e) {
    // 由 Fabric.js 处理裁剪框的拖拽/缩放
  }

  _onMouseMove(e) {
    // 由 Fabric.js 处理
  }

  _onMouseUp(e) {
    // 由 Fabric.js 处理
  }

  getOptionsBarHTML() {
    const ratio = this.options.aspectRatio;
    return `
      <div class="options-group">
        <button class="options-btn options-btn-sm ${!ratio ? 'active' : ''}" data-preset="crop-ratio-free">自由比例</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 1 && ratio.h === 1 ? 'active' : ''}" data-preset="crop-ratio-1-1">1:1</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 3 && ratio.h === 2 ? 'active' : ''}" data-preset="crop-ratio-3-2">3:2</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 2 && ratio.h === 3 ? 'active' : ''}" data-preset="crop-ratio-2-3">2:3</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 3 && ratio.h === 4 ? 'active' : ''}" data-preset="crop-ratio-3-4">3:4</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 4 && ratio.h === 3 ? 'active' : ''}" data-preset="crop-ratio-4-3">4:3</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 16 && ratio.h === 9 ? 'active' : ''}" data-preset="crop-ratio-16-9">16:9</button>
        <button class="options-btn options-btn-sm ${ratio && ratio.w === 9 && ratio.h === 16 ? 'active' : ''}" data-preset="crop-ratio-9-16">9:16</button>
      </div>
    `;
  }

  getPropertyPanelHTML() {
    if (!this._cropRect) {
      return '<div class="property-empty">启用剪切后可编辑裁剪区域</div>';
    }

    const bounds = this._getCropBounds();
    const ratio = this.options.aspectRatio;

    return `
      <div class="property-item">
        <label>X</label>
        <input type="number" class="property-input" data-prop="left" value="${this._formatNumber(bounds.left)}" />
      </div>
      <div class="property-item">
        <label>Y</label>
        <input type="number" class="property-input" data-prop="top" value="${this._formatNumber(bounds.top)}" />
      </div>
      <div class="property-item">
        <label>宽</label>
        <input type="number" class="property-input" data-prop="width" value="${this._formatNumber(bounds.width)}" min="1" />
      </div>
      <div class="property-item">
        <label>高</label>
        <input type="number" class="property-input" data-prop="height" value="${this._formatNumber(bounds.height)}" min="1" />
      </div>
      <div class="property-item property-item--wide">
        <label>比例</label>
        <select class="property-select property-select--short" data-module-prop="aspectRatio" data-refresh-property="true">
          <option value="free" ${!ratio ? 'selected' : ''}>自由</option>
          <option value="1:1" ${ratio && ratio.w === 1 && ratio.h === 1 ? 'selected' : ''}>1:1</option>
          <option value="3:2" ${ratio && ratio.w === 3 && ratio.h === 2 ? 'selected' : ''}>3:2</option>
          <option value="2:3" ${ratio && ratio.w === 2 && ratio.h === 3 ? 'selected' : ''}>2:3</option>
          <option value="3:4" ${ratio && ratio.w === 3 && ratio.h === 4 ? 'selected' : ''}>3:4</option>
          <option value="4:3" ${ratio && ratio.w === 4 && ratio.h === 3 ? 'selected' : ''}>4:3</option>
          <option value="16:9" ${ratio && ratio.w === 16 && ratio.h === 9 ? 'selected' : ''}>16:9</option>
          <option value="9:16" ${ratio && ratio.w === 9 && ratio.h === 16 ? 'selected' : ''}>9:16</option>
        </select>
      </div>
      <div class="property-actions">
        <button class="property-btn property-btn--primary" type="button" data-module-action="applyCrop">应用裁剪</button>
        <button class="property-btn" type="button" data-module-action="cancelCrop">取消</button>
      </div>
      <div class="property-empty">拖动裁剪框，或直接输入区域数值</div>
    `;
  }

  onToolPropertyChange(key, value) {
    if (key !== 'aspectRatio') return false;

    this.setAspectRatio(this._parseRatio(value));
    return true;
  }

  onToolPropertyAction(action) {
    if (action === 'applyCrop') {
      this.applyCrop();
      return;
    }
    if (action === 'cancelCrop') {
      this.cancelCrop();
    }
  }

  onPropertyChange(key, value, context = {}) {
    if (!this._cropRect || !['left', 'top', 'width', 'height'].includes(key)) return;

    if (this.options.aspectRatio && (key === 'width' || key === 'height')) {
      this._applyAspectRatioToCropRect(key);
      if (context.eventType === 'change') {
        eventBus.emit('crop:updated', this._getCropBounds());
      }
      return;
    }

    this._cropRect.setCoords();
    this._updateMask();
    if (context.eventType === 'change') {
      eventBus.emit('crop:updated', this._getCropBounds());
    }
  }

  _formatNumber(value) {
    const number = parseFloat(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(number * 100) / 100;
  }

  _parseRatio(value) {
    if (value === 'free') return null;
    const [w, h] = String(value).split(':').map(Number);
    return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
  }
}

export default CropModule;
