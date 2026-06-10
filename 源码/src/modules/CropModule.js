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
    this._isAdjusting = false;
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
  }

  activate(options = {}) {
    super.activate(options);  // 自动禁用所有对象交互

    const canvas = this.canvasManager.canvas;
    canvas.defaultCursor = 'crosshair';

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
    canvas.renderAll();

    super.deactivate();  // 恢复所有对象交互
  }

  setAspectRatio(ratio) {
    this.options.aspectRatio = ratio;
  }

  /**
   * 执行裁剪
   */
  applyCrop() {
    if (!this._cropRect) return;
    this.history.saveState();

    const canvas = this.canvasManager.canvas;
    const cr = this._cropRect;

    // 使用 clipPath 非破坏性裁剪
    const clipRect = new fabric.Rect({
      left: cr.left,
      top: cr.top,
      width: cr.width * cr.scaleX,
      height: cr.height * cr.scaleY,
      absolutePositioned: true,
    });

    canvas.clipPath = clipRect;
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
      excludeFromLayer: true,
      absolutePositioned: true,
    });

    // 更新遮罩挖空效果
    this._cropRect.on('moving', () => this._updateMask());
    this._cropRect.on('scaling', () => this._updateMask());
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
        <label class="options-label">比例</label>
        <div class="options-btn-group">
          <button class="options-btn ${!ratio ? 'active' : ''}" data-ratio="free">自由</button>
          <button class="options-btn ${ratio && ratio.w === 1 && ratio.h === 1 ? 'active' : ''}" data-ratio="1:1">1:1</button>
          <button class="options-btn ${ratio && ratio.w === 4 && ratio.h === 3 ? 'active' : ''}" data-ratio="4:3">4:3</button>
          <button class="options-btn ${ratio && ratio.w === 16 && ratio.h === 9 ? 'active' : ''}" data-ratio="16:9">16:9</button>
        </div>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-primary" id="crop-apply">应用</button>
        <button class="options-btn" id="crop-cancel">取消</button>
      </div>
    `;
  }
}

export default CropModule;
