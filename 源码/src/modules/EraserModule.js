import BaseModule from './BaseModule.js';
import eventBus from '../core/EventBus.js';

/**
 * 橡皮擦模块 - 默认擦除当前图层，并把擦除结果固化为位图。
 */
class EraserModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      width: 20,
      ...defaultOptions,
    });

    this._targetObject = null;
    this._strokeTarget = null;
    this._savedBeforeStroke = false;
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundPathCreated = this._onPathCreated.bind(this);
    this._boundLayerSelected = this._onLayerSelected.bind(this);
  }

  activate(options = {}) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    const initialTarget = this._getErasableObject(canvas.getActiveObject());
    super.activate(options);

    this._targetObject = initialTarget;
    canvas.discardActiveObject();
    canvas.isDrawingMode = true;
    canvas.defaultCursor = 'crosshair';
    canvas.freeDrawingCursor = 'crosshair';
    this._ensureBrush();
    this._applyBrushOptions();
    canvas.on('mouse:down', this._boundMouseDown);
    canvas.on('path:created', this._boundPathCreated);
    eventBus.on('layer:selected', this._boundLayerSelected);

    eventBus.emit('module:activated', 'eraser');
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;
    if (canvas) {
      canvas.off('mouse:down', this._boundMouseDown);
      canvas.off('path:created', this._boundPathCreated);
      canvas.isDrawingMode = false;
      canvas.freeDrawingCursor = 'crosshair';
      this._targetObject = null;
      this._strokeTarget = null;
      this._savedBeforeStroke = false;
    }
    eventBus.off('layer:selected', this._boundLayerSelected);

    super.deactivate();
  }

  setWidth(width) {
    const parsed = parseInt(width, 10);
    this.options.width = this._clamp(Number.isFinite(parsed) ? parsed : this.options.width, 1, 120);
    this._applyBrushOptions();
  }

  applyPreset(presetName) {
    const presets = {
      'eraser-thin': 8,
      'eraser-medium': 20,
      'eraser-thick': 40,
      'eraser-heavy': 64,
    };

    const width = presets[presetName];
    if (!width) return;

    this.setWidth(width);
  }

  getOptionsBarHTML() {
    const width = this.options.width;

    return `
      <div class="options-group">
        <button class="options-btn options-btn-sm ${width === 8 ? 'active' : ''}" data-preset="eraser-thin">细</button>
        <button class="options-btn options-btn-sm ${width === 20 ? 'active' : ''}" data-preset="eraser-medium">中</button>
        <button class="options-btn options-btn-sm ${width === 40 ? 'active' : ''}" data-preset="eraser-thick">粗</button>
        <button class="options-btn options-btn-sm ${width === 64 ? 'active' : ''}" data-preset="eraser-heavy">特粗</button>
      </div>
    `;
  }

  getPropertyPanelHTML() {
    return `
      <div class="property-section-title">橡皮擦工具</div>
      <div class="property-item property-item--wide">
        <label>大小</label>
        <input type="range" class="property-range" data-module-prop="width" min="1" max="120" value="${this.options.width}" />
        <span class="property-value">${this.options.width}px</span>
      </div>
      <div class="property-empty">默认擦除进入工具前选中的当前图层；未选中图层时，会擦除鼠标下方最上层可编辑图层。</div>
    `;
  }

  onToolPropertyChange(key, value) {
    if (key !== 'width') return false;

    this.setWidth(value);
    return true;
  }

  _onMouseDown(e) {
    const nativeEvent = e?.e;
    if (nativeEvent && typeof nativeEvent.button === 'number' && nativeEvent.button !== 0) return;

    const target = this._getStrokeTarget(e);
    this._strokeTarget = target;
    if (!target) return;

    this.history.saveState();
    this._savedBeforeStroke = true;
  }

  _onPathCreated(e) {
    const path = e.path;
    if (!path) return;

    const canvas = this.canvasManager.canvas;
    const target = this._strokeTarget;

    // 移除临时绘制路径，不保留为独立图层
    path.set({ excludeFromLayer: true, excludeFromExport: true });
    canvas.remove(path);

    if (!target || !this._isErasableObject(target)) {
      this._resetStrokeState();
      canvas.renderAll();
      return;
    }

    // 栅格化合并：将擦除效果直接烧入目标图层像素
    this._rasterizeErasedLayer(target, path);
    canvas.discardActiveObject();
    canvas.renderAll();
    this._resetStrokeState();
  }

  _onLayerSelected(meta) {
    if (!this.active) return;

    this._targetObject = this._getErasableObject(meta?.fabricObj || null);
    const canvas = this.canvasManager.canvas;
    if (canvas) canvas.discardActiveObject();
  }

  /**
   * 将擦除效果栅格化合并到目标图层
   * @param {fabric.Object} target - 目标图层对象
   * @param {fabric.Path} erasePath - 擦除路径
   */
  _rasterizeErasedLayer(target, erasePath) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    try {
      const bounds = target.getBoundingRect(true, true);
      const cropLeft = Math.floor(bounds.left);
      const cropTop = Math.floor(bounds.top);
      const cropRight = Math.ceil(bounds.left + bounds.width);
      const cropBottom = Math.ceil(bounds.top + bounds.height);
      const cropWidth = Math.max(1, cropRight - cropLeft);
      const cropHeight = Math.max(1, cropBottom - cropTop);

      // 先在完整画布坐标系中合成，避免手动转换路径坐标导致擦偏。
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = Math.max(1, Math.ceil(canvas.width));
      tempCanvas.height = Math.max(1, Math.ceil(canvas.height));
      const tempFabricCanvas = new fabric.StaticCanvas(tempCanvas, {
        backgroundColor: null,
        renderOnAddRemove: false,
      });

      target.clone((clonedTarget) => {
        this._prepareRasterObject(clonedTarget);

        const eraser = this._createRasterErasePath(erasePath);
        tempFabricCanvas.add(clonedTarget);
        tempFabricCanvas.add(eraser);
        tempFabricCanvas.renderAll();

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropWidth;
        cropCanvas.height = cropHeight;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(tempCanvas, -cropLeft, -cropTop);

        const newImg = new fabric.Image(cropCanvas, {
          left: cropLeft,
          top: cropTop,
          width: cropWidth,
          height: cropHeight,
          scaleX: 1,
          scaleY: 1,
          angle: 0,
          originX: 'left',
          originY: 'top',
          opacity: 1,
          id: target.id,
          selectable: false,
          evented: false,
        });

        if (target.clipPath) {
          newImg.set('clipPath', target.clipPath);
        }

        newImg.setCoords();

        const targetIndex = canvas.getObjects().indexOf(target);
        canvas.remove(target);
        if (targetIndex >= 0) {
          canvas.insertAt(newImg, targetIndex);
        } else {
          canvas.add(newImg);
        }

        if (this._targetObject === target || this._strokeTarget === target) {
          this._targetObject = newImg;
        }

        tempFabricCanvas.dispose();
        canvas.renderAll();
      });
    } catch (err) {
      console.error('[EraserModule] 栅格化擦除失败:', err);
    }
  }

  _prepareRasterObject(obj) {
    obj.set({
      selectable: false,
      evented: false,
      objectCaching: false,
    });
    obj.setCoords();
  }

  _createRasterErasePath(sourcePath) {
    const eraser = new fabric.Path(this._clonePathData(sourcePath.path || []), {
      left: sourcePath.left || 0,
      top: sourcePath.top || 0,
      scaleX: sourcePath.scaleX == null ? 1 : sourcePath.scaleX,
      scaleY: sourcePath.scaleY == null ? 1 : sourcePath.scaleY,
      angle: sourcePath.angle || 0,
      skewX: sourcePath.skewX || 0,
      skewY: sourcePath.skewY || 0,
      flipX: !!sourcePath.flipX,
      flipY: !!sourcePath.flipY,
      originX: sourcePath.originX || 'left',
      originY: sourcePath.originY || 'top',
      fill: null,
      stroke: '#000000',
      strokeWidth: sourcePath.strokeWidth || this.options.width,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      globalCompositeOperation: 'destination-out',
      objectCaching: false,
      selectable: false,
      evented: false,
    });

    if (sourcePath.pathOffset) {
      eraser.pathOffset = new fabric.Point(sourcePath.pathOffset.x, sourcePath.pathOffset.y);
    }
    eraser.setCoords();
    return eraser;
  }

  _clonePathData(pathData) {
    return pathData.map(command => command.slice());
  }

  _getStrokeTarget(e) {
    if (this._isErasableObject(this._targetObject)) return this._targetObject;

    const canvas = this.canvasManager.canvas;
    const active = this._getErasableObject(canvas?.getActiveObject?.());
    if (active) {
      this._targetObject = active;
      return active;
    }

    const pointer = e ? canvas.getPointer(e.e) : null;
    const hit = pointer ? this._findTopmostObjectAt(pointer) : null;
    this._targetObject = hit;
    return hit;
  }

  _getErasableObject(obj) {
    if (!obj) return null;

    if (obj.type === 'activeSelection' && typeof obj.getObjects === 'function') {
      return this._pickTopmostObject(obj.getObjects());
    }

    return this._isErasableObject(obj) ? obj : null;
  }

  _isErasableObject(obj) {
    const canvas = this.canvasManager.canvas;
    if (!obj || !canvas?.getObjects().includes(obj)) return false;

    // 排除背景原图
    if (obj === this.canvasManager.originalImage) return false;

    // 排除工具临时对象
    if (obj.excludeFromHistory || obj.excludeFromLayer) return false;

    // 排除旧版/误残留的橡皮擦路径
    if (typeof obj.id === 'string' && obj.id.startsWith('eraser_')) return false;
    if (obj.globalCompositeOperation === 'destination-out') return false;

    return true;
  }

  _findTopmostObjectAt(pointer) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return null;

    const objects = canvas.getObjects();
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!this._isErasableObject(obj) || obj.visible === false) continue;
      if (obj.containsPoint?.(pointer)) return obj;
    }

    return null;
  }

  _pickTopmostObject(objects) {
    const canvasObjects = this.canvasManager.canvas?.getObjects() || [];
    let result = null;
    let resultIndex = -1;

    objects.forEach(obj => {
      if (!this._isErasableObject(obj)) return;
      const index = canvasObjects.indexOf(obj);
      if (index > resultIndex) {
        result = obj;
        resultIndex = index;
      }
    });

    return result;
  }

  _resetStrokeState() {
    this._strokeTarget = null;
    this._savedBeforeStroke = false;
  }

  _ensureBrush() {
    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    if (!canvas.freeDrawingBrush || !(canvas.freeDrawingBrush instanceof fabric.PencilBrush)) {
      canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
    }
  }

  _applyBrushOptions() {
    const canvas = this.canvasManager.canvas;
    if (!canvas?.freeDrawingBrush) return;

    canvas.freeDrawingBrush.color = '#ffffff';
    canvas.freeDrawingBrush.width = this.options.width;
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

export default EraserModule;
