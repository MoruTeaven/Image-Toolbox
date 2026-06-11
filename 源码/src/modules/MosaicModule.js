import BaseModule from './BaseModule.js';
import eventBus from '../core/EventBus.js';

const SELECTION_FILL = 'rgba(47,127,134,0.16)';
const SELECTION_STROKE = '#2f7f86';
const SELECTION_STROKE_SOFT = 'rgba(47,127,134,0.52)';

/**
 * 打码模块 — 框选 + 画笔两种交互方式，马赛克 + 模糊两种效果
 *
 * 框选模式 (rect)：拖拽矩形选区打码
 * 画笔模式 (brush)：自由涂抹打码，释放时对涂抹覆盖区域（包围盒+画笔半径）应用效果
 */
class MosaicModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      mode: 'mosaic',       // 效果类型: 'mosaic' | 'blur'
      drawMode: 'rect',     // 交互方式: 'rect' | 'brush'
      mosaicSize: 10,       // 马赛克块大小
      blurRadius: 8,        // 模糊半径
      brushSize: 20,        // 画笔直径
      ...defaultOptions,
    });

    this._isDrawing = false;
    this._startPoint = null;
    this._selectionRect = null;   // 框选模式的虚线矩形
    this._brushPoints = [];       // 画笔模式的轨迹点
    this._brushPreview = null;    // 画笔预览圆圈

    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
  }

  // ── 生命周期 ──

  activate(options = {}) {
    super.activate(options);

    const canvas = this.canvasManager.canvas;
    canvas.defaultCursor = this.options.drawMode === 'brush' ? 'none' : 'crosshair';

    canvas.on('mouse:down', this._boundMouseDown);
    canvas.on('mouse:move', this._boundMouseMove);
    canvas.on('mouse:up', this._boundMouseUp);

    eventBus.emit('module:activated', 'mosaic');
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;

    canvas.off('mouse:down', this._boundMouseDown);
    canvas.off('mouse:move', this._boundMouseMove);
    canvas.off('mouse:up', this._boundMouseUp);

    this._cleanupRect();
    this._cleanupBrush();
    canvas.renderAll();

    super.deactivate();
  }

  // ── 参数设置 ──

  setMode(mode) {
    this.options.mode = mode;
  }

  setDrawMode(mode) {
    this.options.drawMode = mode;
    const canvas = this.canvasManager.canvas;
    if (canvas) {
      canvas.defaultCursor = mode === 'brush' ? 'none' : 'crosshair';
    }
  }

  setMosaicSize(size) {
    this.options.mosaicSize = Math.max(2, Math.min(50, parseInt(size)));
  }

  setBlurRadius(radius) {
    this.options.blurRadius = Math.max(1, Math.min(30, parseInt(radius)));
  }

  setBrushSize(size) {
    this.options.brushSize = Math.max(4, Math.min(100, parseInt(size)));
  }

  // ── 鼠标事件分发 ──

  _onMouseDown(e) {
    if (this.options.drawMode === 'brush') {
      this._startBrush(e);
    } else {
      this._startRect(e);
    }
  }

  _onMouseMove(e) {
    if (!this._isDrawing) return;

    if (this.options.drawMode === 'brush') {
      this._continueBrush(e);
    } else {
      this._updateRect(e);
    }
  }

  _onMouseUp(e) {
    if (!this._isDrawing) return;

    if (this.options.drawMode === 'brush') {
      this._finishBrush(e);
    } else {
      this._finishRect(e);
    }
  }

  // ═══════════════════════════════════════
  // 框选模式 (rect) — 拖拽矩形选区
  // ═══════════════════════════════════════

  _startRect(e) {
    const pointer = this.canvasManager.canvas.getPointer(e.e);
    this._isDrawing = true;
    this._startPoint = pointer;

    this._selectionRect = new fabric.Rect({
      left: pointer.x,
      top: pointer.y,
      width: 0,
      height: 0,
      fill: SELECTION_FILL,
      stroke: SELECTION_STROKE,
      strokeWidth: 1.5,
      strokeDashArray: [4, 3],
      selectable: false,
      evented: false,
    });
    this.canvasManager.canvas.add(this._selectionRect);
  }

  _updateRect(e) {
    const pointer = this.canvasManager.canvas.getPointer(e.e);
    const left = Math.min(this._startPoint.x, pointer.x);
    const top = Math.min(this._startPoint.y, pointer.y);
    const width = Math.abs(pointer.x - this._startPoint.x);
    const height = Math.abs(pointer.y - this._startPoint.y);

    this._selectionRect.set({ left, top, width, height });
    this.canvasManager.canvas.renderAll();
  }

  _finishRect(e) {
    this._isDrawing = false;

    if (!this._selectionRect) return;

    const rect = this._selectionRect;
    const width = rect.width * rect.scaleX;
    const height = rect.height * rect.scaleY;

    const mosaicRect = {
      left: rect.left,
      top: rect.top,
      width: Math.round(width),
      height: Math.round(height),
    };

    // 先移除选区框，否则 getImageData 会把提示色读进去
    this._cleanupRect();

    if (mosaicRect.width < 5 || mosaicRect.height < 5) return;

    this.applyMosaic(mosaicRect);
  }

  _cleanupRect() {
    if (this._selectionRect) {
      this.canvasManager.canvas.remove(this._selectionRect);
      this._selectionRect = null;
    }
    this.canvasManager.canvas.renderAll();
  }

  // ═══════════════════════════════════════
  // 画笔模式 (brush) — 自由涂抹
  // ═══════════════════════════════════════

  _startBrush(e) {
    const pointer = this.canvasManager.canvas.getPointer(e.e);
    this._isDrawing = true;
    this._brushPoints = [{ x: pointer.x, y: pointer.y }];

    // 画笔预览圆圈
    const r = this.options.brushSize / 2;
    this._brushPreview = new fabric.Circle({
      left: pointer.x - r,
      top: pointer.y - r,
      radius: r,
      fill: SELECTION_FILL,
      stroke: SELECTION_STROKE_SOFT,
      strokeWidth: 1,
      strokeDashArray: [3, 3],
      selectable: false,
      evented: false,
    });
    this.canvasManager.canvas.add(this._brushPreview);
    this.canvasManager.canvas.renderAll();
  }

  _continueBrush(e) {
    const pointer = this.canvasManager.canvas.getPointer(e.e);

    // 采样优化：距离上个点超过一定距离才记录，避免点过密
    const last = this._brushPoints[this._brushPoints.length - 1];
    const dx = pointer.x - last.x;
    const dy = pointer.y - last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 2) {
      this._brushPoints.push({ x: pointer.x, y: pointer.y });
    }

    // 更新预览圆圈
    if (this._brushPreview) {
      const r = this.options.brushSize / 2;
      this._brushPreview.set({ left: pointer.x - r, top: pointer.y - r });
      this.canvasManager.canvas.renderAll();
    }
  }

  _finishBrush(e) {
    this._isDrawing = false;

    // 清理预览
    this._cleanupBrush();

    if (this._brushPoints.length === 0) return;

    const padding = this.options.brushSize / 2;

    // 计算包围盒
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this._brushPoints) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const points = this._brushPoints;
    this._brushPoints = [];

    const rect = {
      left: Math.round(minX - padding),
      top: Math.round(minY - padding),
      width: Math.round(maxX - minX + padding * 2),
      height: Math.round(maxY - minY + padding * 2),
    };

    if (rect.width < 1 || rect.height < 1) return;

    // 按画笔路径做蒙版打码
    this._applyBrushMaskedEffect(rect, points);
    this.history.saveState();
  }

  _cleanupBrush() {
    if (this._brushPreview) {
      this.canvasManager.canvas.remove(this._brushPreview);
      this._brushPreview = null;
    }
    this.canvasManager.canvas.renderAll();
  }

  /**
   * 画笔蒙版打码 — 只对画笔轨迹覆盖的像素应用效果
   */
  _applyBrushMaskedEffect(rect, points) {
    const canvas = this.canvasManager.canvas;
    const ctx = canvas.getContext();
    const brushR = this.options.brushSize / 2;

    // 获取区域原始像素
    const imgData = ctx.getImageData(rect.left, rect.top, rect.width, rect.height);
    const src = new Uint8ClampedArray(imgData.data);

    // 创建蒙版 canvas：画笔画过的区域为白色
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = rect.width;
    maskCanvas.height = rect.height;
    const maskCtx = maskCanvas.getContext('2d');

    // 在蒙版上画出画笔轨迹
    maskCtx.fillStyle = '#ffffff';
    for (const p of points) {
      maskCtx.beginPath();
      maskCtx.arc(p.x - rect.left, p.y - rect.top, brushR, 0, Math.PI * 2);
      maskCtx.fill();
    }

    const maskData = maskCtx.getImageData(0, 0, rect.width, rect.height);

    // 对需要打码的像素进行处理
    if (this.options.mode === 'mosaic') {
      this._mosaicPixels(src, rect.width, rect.height, maskData.data);
    } else {
      this._blurPixels(src, imgData, rect.width, rect.height, maskData.data);
    }

    // 只写入蒙版非透明区域的像素
    const dst = imgData.data;
    for (let i = 0; i < src.length; i += 4) {
      if (maskData.data[i + 3] > 0) {
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = src[i + 3];
      }
    }

    this._createImageOverlay(rect, imgData);
  }

  /**
   * 马赛克效果 — 对阵列像素进行块化处理
   * 只处理蒙版覆盖区域内的像素
   */
  _mosaicPixels(data, w, h, mask) {
    const size = this.options.mosaicSize;

    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        // 检查该块是否有蒙版区域
        let hasMask = false;
        for (let dy = 0; dy < size && y + dy < h && !hasMask; dy++) {
          for (let dx = 0; dx < size && x + dx < w && !hasMask; dx++) {
            const mi = ((y + dy) * w + (x + dx)) * 4;
            if (mask[mi + 3] > 0) hasMask = true;
          }
        }
        if (!hasMask) continue;

        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const idx = ((y + dy) * w + (x + dx)) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            count++;
          }
        }
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        a = Math.round(a / count);

        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const idx = ((y + dy) * w + (x + dx)) * 4;
            if (mask[idx + 3] > 0) {
              data[idx] = r;
              data[idx + 1] = g;
              data[idx + 2] = b;
              data[idx + 3] = a;
            }
          }
        }
      }
    }
  }

  /**
   * 模糊效果 — 使用 Canvas2D filter
   */
  _blurPixels(data, originalImgData, w, h, mask) {
    const radius = this.options.blurRadius || 8;

    // 源 canvas：放原始像素
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w;
    srcCanvas.height = h;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(new ImageData(data, w, h), 0, 0);

    // 目标 canvas：避免自绘制预乘 alpha 色偏
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = w;
    dstCanvas.height = h;
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.filter = `blur(${radius}px)`;
    dstCtx.drawImage(srcCanvas, 0, 0);
    dstCtx.filter = 'none';

    const blurred = dstCtx.getImageData(0, 0, w, h);

    // 只拷贝蒙版区域的模糊像素
    for (let i = 0; i < data.length; i += 4) {
      if (mask[i + 3] > 0) {
        data[i] = blurred.data[i];
        data[i + 1] = blurred.data[i + 1];
        data[i + 2] = blurred.data[i + 2];
        data[i + 3] = blurred.data[i + 3];
      }
    }
  }

  // ═══════════════════════════════════════
  // 核心打码方法
  // ═══════════════════════════════════════

  /**
   * 对指定矩形区域打码（框选模式使用）
   */
  applyMosaic(rect) {
    const mode = this.options.mode;

    if (mode === 'mosaic') {
      this._applyMosaicEffect(rect);
    } else {
      this._applyBlurEffect(rect);
    }

    this.history.saveState();
  }

  _applyMosaicEffect(rect) {
    const canvas = this.canvasManager.canvas;
    const ctx = canvas.getContext();
    const size = this.options.mosaicSize;

    const imgData = ctx.getImageData(rect.left, rect.top, rect.width, rect.height);
    const data = imgData.data;
    const w = imgData.width;
    const h = imgData.height;

    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const idx = ((y + dy) * w + (x + dx)) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            count++;
          }
        }
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        a = Math.round(a / count);

        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const idx = ((y + dy) * w + (x + dx)) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = a;
          }
        }
      }
    }

    this._createImageOverlay(rect, imgData);
  }

  _applyBlurEffect(rect) {
    const canvas = this.canvasManager.canvas;
    const ctx = canvas.getContext();
    const radius = this.options.blurRadius || 8;

    const imgData = ctx.getImageData(rect.left, rect.top, rect.width, rect.height);

    // 源 canvas：放原始像素
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = rect.width;
    srcCanvas.height = rect.height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(imgData, 0, 0);

    // 目标 canvas：用于模糊输出（避免自绘制预乘 alpha 色偏）
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = rect.width;
    dstCanvas.height = rect.height;
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.filter = `blur(${radius}px)`;
    dstCtx.drawImage(srcCanvas, 0, 0);
    dstCtx.filter = 'none';

    const blurredImgData = dstCtx.getImageData(0, 0, rect.width, rect.height);
    this._createImageOverlay(rect, blurredImgData);
  }

  /**
   * 创建覆盖层 Fabric Image — 直接用 canvas 元素避免 toDataURL 颜色空间转换
   */
  _createImageOverlay(rect, imgData) {
    const canvas = this.canvasManager.canvas;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imgData.width;
    tempCanvas.height = imgData.height;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.imageSmoothingEnabled = false;
    tempCtx.putImageData(imgData, 0, 0);

    // 直接用 canvas 元素构造 fabric.Image，跳过 toDataURL → fromURL 往返
    const img = new fabric.Image(tempCanvas, {
      left: rect.left,
      top: rect.top,
      selectable: false,
      evented: false,
      id: 'mosaic_' + Date.now(),
    });

    // 清理框选虚线
    if (this._selectionRect) {
      canvas.remove(this._selectionRect);
      this._selectionRect = null;
    }

    canvas.add(img);
    canvas.renderAll();
  }

  /**
   * 清除所有打码覆盖层
   */
  clearAllMosaics() {
    const canvas = this.canvasManager.canvas;
    const overlays = canvas.getObjects().filter(
      o => o.id && o.id.startsWith('mosaic_')
    );
    overlays.forEach(o => canvas.remove(o));
    canvas.renderAll();
    this.history.saveState();
  }

  applyPreset(presetName) {
    const presets = {
      'mosaic-light': { mode: 'mosaic', mosaicSize: 6 },
      'mosaic-standard': { mode: 'mosaic', mosaicSize: 12 },
      'blur-strong': { mode: 'blur', blurRadius: 18 },
    };

    const preset = presets[presetName];
    if (!preset) return;

    Object.assign(this.options, preset);
    if (preset.mode) this.setMode(preset.mode);
    if (preset.mosaicSize) this.setMosaicSize(preset.mosaicSize);
    if (preset.blurRadius) this.setBlurRadius(preset.blurRadius);
  }

  // ═══════════════════════════════════════
  // 预设栏 HTML
  // ═══════════════════════════════════════

  getOptionsBarHTML() {
    const isLight = this.options.mode === 'mosaic' && this.options.mosaicSize === 6;
    const isStandard = this.options.mode === 'mosaic' && this.options.mosaicSize === 12;
    const isStrongBlur = this.options.mode === 'blur' && this.options.blurRadius === 18;
    return `
      <div class="options-group">
        <button class="options-btn options-btn-sm ${isLight ? 'active' : ''}" data-preset="mosaic-light">轻度马赛克</button>
        <button class="options-btn options-btn-sm ${isStandard ? 'active' : ''}" data-preset="mosaic-standard">标准马赛克</button>
        <button class="options-btn options-btn-sm ${isStrongBlur ? 'active' : ''}" data-preset="blur-strong">强模糊</button>
      </div>
    `;
  }

  getPropertyPanelHTML() {
    const effectMode = this.options.mode;
    let html = `
      <div class="property-section-title">打码工具</div>
      <div class="property-item property-item--wide">
        <label>效果</label>
        <select class="property-select" data-module-prop="mode" data-refresh-property="true">
          <option value="mosaic" ${effectMode === 'mosaic' ? 'selected' : ''}>马赛克</option>
          <option value="blur" ${effectMode === 'blur' ? 'selected' : ''}>模糊</option>
        </select>
      </div>
    `;

    if (effectMode === 'mosaic') {
      html += `
        <div class="property-item property-item--wide">
          <label>块大小</label>
          <input type="range" class="property-range" data-module-prop="mosaicSize" min="2" max="40" value="${this.options.mosaicSize}" />
          <span class="property-value">${this.options.mosaicSize}px</span>
        </div>
      `;
    } else {
      html += `
        <div class="property-item property-item--wide">
          <label>模糊强度</label>
          <input type="range" class="property-range" data-module-prop="blurRadius" min="1" max="30" value="${this.options.blurRadius}" />
          <span class="property-value">${this.options.blurRadius}px</span>
        </div>
      `;
    }

    return html;
  }

  onToolPropertyChange(key, value) {
    switch (key) {
      case 'mode':
        this.setMode(value);
        return true;
      case 'mosaicSize':
        this.setMosaicSize(value);
        return true;
      case 'blurRadius':
        this.setBlurRadius(value);
        return true;
      case 'brushSize':
        this.setBrushSize(value);
        return true;
      default:
        return false;
    }
  }
}

export default MosaicModule;
