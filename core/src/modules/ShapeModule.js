import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';

/**
 * 图形绘制模块 - 支持矩形、椭圆、星星、心形、梯形、直线、箭头等多种图形
 */
class ShapeModule extends BaseModule {
  static SHAPE_OPTIONS = [
    { type: 'rect', preset: 'shape-type-rect', label: '矩形', icon: '▭' },
    { type: 'circle', preset: 'shape-type-circle', label: '圆形', icon: '●' },
    { type: 'star', preset: 'shape-type-star', label: '星星', icon: '★' },
    { type: 'heart', preset: 'shape-type-heart', label: '心形', icon: '♥' },
    { type: 'trapezoid', preset: 'shape-type-trapezoid', label: '梯形', icon: '⊟' },
    { type: 'line', preset: 'shape-type-line', label: '直线', icon: '━' },
    { type: 'arrow', preset: 'shape-type-arrow', label: '箭头', icon: '➜' },
  ];

  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      shapeType: 'rect',
      fill: 'rgba(255, 0, 0, 0.3)',
      stroke: '#ff0000',
      strokeWidth: 2,
      ...defaultOptions,
    });

    this._isDrawing = false;
    this._startPoint = null;
    this._currentShape = null;
    this._previewShape = null;
    this._savedBeforeShape = false;

    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
    this._boundMouseOut = this._onMouseOut.bind(this);
  }

  activate(options = {}) {
    super.activate(options);

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    canvas.discardActiveObject();
    canvas.defaultCursor = 'crosshair';
    canvas.upperCanvasEl?.addEventListener('mousedown', this._boundMouseDown);
    canvas.upperCanvasEl?.addEventListener('mousemove', this._boundMouseMove);
    canvas.upperCanvasEl?.addEventListener('mouseup', this._boundMouseUp);
    canvas.upperCanvasEl?.addEventListener('mouseout', this._boundMouseOut);

    eventBus.emit('module:activated', 'shape');
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;
    if (canvas) {
      canvas.upperCanvasEl?.removeEventListener('mousedown', this._boundMouseDown);
      canvas.upperCanvasEl?.removeEventListener('mousemove', this._boundMouseMove);
      canvas.upperCanvasEl?.removeEventListener('mouseup', this._boundMouseUp);
      canvas.upperCanvasEl?.removeEventListener('mouseout', this._boundMouseOut);
      this._removePreviewShape();
      this._isDrawing = false;
      this._startPoint = null;
      this._currentShape = null;
      this._savedBeforeShape = false;
    }

    super.deactivate();
  }

  setShapeType(type) {
    if (['rect', 'circle', 'star', 'heart', 'trapezoid', 'line', 'arrow'].includes(type)) {
      this.options.shapeType = type;
    }
  }

  setFill(fill) {
    this.options.fill = this._normalizeColor(fill, this.options.fill, true);
  }

  setStroke(stroke) {
    this.options.stroke = this._normalizeColor(stroke, this.options.stroke, false);
  }

  setStrokeWidth(width) {
    const parsed = parseInt(width, 10);
    this.options.strokeWidth = this._clamp(Number.isFinite(parsed) ? parsed : this.options.strokeWidth, 1, 20);
  }

  applyPreset(presetName) {
    const presets = {
      'shape-fill-red': { fill: 'rgba(216, 59, 49, 0.3)' },
      'shape-fill-blue': { fill: 'rgba(22, 119, 255, 0.3)' },
      'shape-fill-green': { fill: 'rgba(46, 173, 74, 0.3)' },
      'shape-fill-yellow': { fill: 'rgba(255, 215, 0, 0.3)' },
      'shape-fill-none': { fill: 'transparent' },
      'shape-stroke-red': { stroke: '#d83b31' },
      'shape-stroke-blue': { stroke: '#1677ff' },
      'shape-stroke-green': { stroke: '#2ead4a' },
      'shape-stroke-black': { stroke: '#111111' },
      'shape-type-rect': { shapeType: 'rect' },
      'shape-type-circle': { shapeType: 'circle' },
      'shape-type-star': { shapeType: 'star' },
      'shape-type-heart': { shapeType: 'heart' },
      'shape-type-trapezoid': { shapeType: 'trapezoid' },
      'shape-type-line': { shapeType: 'line' },
      'shape-type-arrow': { shapeType: 'arrow' },
      'shape-width-thin': { strokeWidth: 1 },
      'shape-width-medium': { strokeWidth: 2 },
      'shape-width-thick': { strokeWidth: 4 },
      'shape-width-heavy': { strokeWidth: 6 },
    };

    const preset = presets[presetName];
    if (!preset) return;

    if (preset.fill !== undefined) this.setFill(preset.fill);
    if (preset.stroke !== undefined) this.setStroke(preset.stroke);
    if (preset.strokeWidth !== undefined) this.setStrokeWidth(preset.strokeWidth);
    if (preset.shapeType !== undefined) this.setShapeType(preset.shapeType);
  }

  getOptionsBarHTML() {
    const shapeType = this.options.shapeType;
    const currentShape = ShapeModule.SHAPE_OPTIONS.find(item => item.type === shapeType) || ShapeModule.SHAPE_OPTIONS[0];
    const fill = this._normalizeColor(this.options.fill);
    const stroke = this._normalizeColor(this.options.stroke);
    const strokeWidth = this.options.strokeWidth;

    return `
      <div class="options-group">
        <button class="options-btn options-btn-sm shape-picker-trigger" data-shape-picker-toggle="true" type="button" title="选择图形">
          <span class="shape-picker-trigger__icon">${currentShape.icon}</span>
          <span>${currentShape.label}</span>
          <span class="shape-picker-trigger__arrow">▾</span>
        </button>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-sm fill-color-btn" data-preset="shape-fill-red" style="--fill-color:rgba(216, 59, 49, 0.3)" title="红色填充">&#9632;</button>
        <button class="options-btn options-btn-sm fill-color-btn" data-preset="shape-fill-blue" style="--fill-color:rgba(22, 119, 255, 0.3)" title="蓝色填充">&#9632;</button>
        <button class="options-btn options-btn-sm fill-color-btn" data-preset="shape-fill-green" style="--fill-color:rgba(46, 173, 74, 0.3)" title="绿色填充">&#9632;</button>
        <button class="options-btn options-btn-sm fill-color-btn" data-preset="shape-fill-yellow" style="--fill-color:rgba(255, 215, 0, 0.3)" title="黄色填充">&#9632;</button>
        <button class="options-btn options-btn-sm ${this.options.fill === 'transparent' ? 'active' : ''}" data-preset="shape-fill-none" title="无填充">⊘</button>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-sm" data-preset="shape-stroke-red" style="border-color:#d83b31" title="红色边框">■</button>
        <button class="options-btn options-btn-sm" data-preset="shape-stroke-blue" style="border-color:#1677ff" title="蓝色边框">■</button>
        <button class="options-btn options-btn-sm" data-preset="shape-stroke-green" style="border-color:#2ead4a" title="绿色边框">■</button>
        <button class="options-btn options-btn-sm" data-preset="shape-stroke-black" style="border-color:#111111" title="黑色边框">■</button>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-sm ${strokeWidth === 1 ? 'active' : ''}" data-preset="shape-width-thin">细</button>
        <button class="options-btn options-btn-sm ${strokeWidth === 2 ? 'active' : ''}" data-preset="shape-width-medium">中</button>
        <button class="options-btn options-btn-sm ${strokeWidth === 4 ? 'active' : ''}" data-preset="shape-width-thick">粗</button>
        <button class="options-btn options-btn-sm ${strokeWidth === 6 ? 'active' : ''}" data-preset="shape-width-heavy">特粗</button>
      </div>
    `;
  }

  getShapePickerHTML() {
    const shapeType = this.options.shapeType;
    const items = ShapeModule.SHAPE_OPTIONS.map(item => `
      <button class="shape-picker__item ${shapeType === item.type ? 'active' : ''}" data-preset="${item.preset}" type="button" title="${item.label}">
        <span class="shape-picker__icon">${item.icon}</span>
        <span class="shape-picker__label">${item.label}</span>
      </button>
    `).join('');

    return `
      <div class="shape-picker" role="dialog" aria-label="选择图形">
        <div class="shape-picker__header">图形工具组</div>
        <div class="shape-picker__grid">${items}</div>
      </div>
    `;
  }

  getPropertyPanelHTML() {
    return `
      <div class="property-section-title">图形工具</div>
      <div class="property-item">
        <label>填充色</label>
        <input type="color" class="property-color" data-module-prop="fill" value="${this._extractHexColor(this.options.fill)}" />
      </div>
      <div class="property-item">
        <label>边框色</label>
        <input type="color" class="property-color" data-module-prop="stroke" value="${this._extractHexColor(this.options.stroke)}" />
      </div>
      <div class="property-item property-item--wide">
        <label>边框宽度</label>
        <input type="range" class="property-range" data-module-prop="strokeWidth" min="1" max="20" value="${this.options.strokeWidth}" />
        <span class="property-value">${this.options.strokeWidth}px</span>
      </div>
      <div class="property-empty">拖拽鼠标绘制图形，支持矩形、圆形、星星、心形等。</div>
    `;
  }

  onToolPropertyChange(key, value) {
    switch (key) {
      case 'fill':
        this.setFill(value);
        return true;
      case 'stroke':
        this.setStroke(value);
        return true;
      case 'strokeWidth':
        this.setStrokeWidth(value);
        return true;
      default:
        return false;
    }
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    const pointer = canvas.getPointer(e);
    this._isDrawing = true;
    this._startPoint = { x: pointer.x, y: pointer.y };
    this.history.saveState();
    this._savedBeforeShape = true;
  }

  _onMouseMove(e) {
    if (!this._isDrawing || !this._startPoint) return;

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    const pointer = canvas.getPointer(e);
    const endPoint = { x: pointer.x, y: pointer.y };

    // 移除旧的预览形状
    this._removePreviewShape();

    // 创建新的预览形状
    const shape = this._createShape(this._startPoint, endPoint);
    if (shape) {
      this._previewShape = shape;
      canvas.add(shape);
      canvas.renderAll();
    }
  }

  _onMouseUp(e) {
    if (!this._isDrawing || !this._startPoint) return;

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    const pointer = canvas.getPointer(e);
    const endPoint = { x: pointer.x, y: pointer.y };

    // 移除预览形状
    this._removePreviewShape();

    // 创建最终形状
    const shape = this._createShape(this._startPoint, endPoint);
    if (shape) {
      // 检查形状是否足够大
      const width = Math.abs(endPoint.x - this._startPoint.x);
      const height = Math.abs(endPoint.y - this._startPoint.y);
      if (width > 5 && height > 5) {
        shape.set({
          id: 'shape_' + Date.now(),
          selectable: false,
          evented: false,
          _layerKind: 'shape',
          _layerShapeType: this.options.shapeType,
        });
        canvas.add(shape);
        canvas.renderAll();
        eventBus.emit('canvas:objectMetadataChanged', shape);
      }
    }

    this._isDrawing = false;
    this._startPoint = null;
    this._currentShape = null;
    this._savedBeforeShape = false;
  }

  _onMouseOut(e) {
    if (this._isDrawing) {
      this._removePreviewShape();
      this.canvasManager.canvas?.renderAll();
    }
  }

  _createShape(startPoint, endPoint) {
    const type = this.options.shapeType;
    const left = Math.min(startPoint.x, endPoint.x);
    const top = Math.min(startPoint.y, endPoint.y);
    const width = Math.abs(endPoint.x - startPoint.x);
    const height = Math.abs(endPoint.y - startPoint.y);

    const commonProps = {
      fill: this.options.fill,
      stroke: this.options.stroke,
      strokeWidth: this.options.strokeWidth,
      selectable: false,
      evented: false,
    };

    switch (type) {
      case 'rect':
        return new fabric.Rect({
          left,
          top,
          width,
          height,
          ...commonProps,
        });

      case 'circle': {
        const radius = Math.min(width, height) / 2;
        return new fabric.Circle({
          left: left + width / 2,
          top: top + height / 2,
          radius,
          originX: 'center',
          originY: 'center',
          ...commonProps,
        });
      }

      case 'star':
        return this._createStar(left + width / 2, top + height / 2, Math.min(width, height) / 2, commonProps);

      case 'heart':
        return this._createHeart(left + width / 2, top + height / 2, Math.min(width, height) / 2, commonProps);

      case 'trapezoid':
        return this._createTrapezoid(left, top, width, height, commonProps);

      case 'line':
        return this._createLine(startPoint, endPoint, commonProps);

      case 'arrow':
        return this._createArrow(startPoint, endPoint, commonProps);

      default:
        return null;
    }
  }

  _createStar(cx, cy, radius, props) {
    const points = [];
    const spikes = 5;
    const outerRadius = radius;
    const innerRadius = radius * 0.4;

    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i * Math.PI) / spikes - Math.PI / 2;
      const r = i % 2 === 0 ? outerRadius : innerRadius;
      points.push([r * Math.cos(angle), r * Math.sin(angle)]);
    }

    const path = new fabric.Polygon(points, {
      ...props,
      left: cx,
      top: cy,
      originX: 'center',
      originY: 'center',
    });

    return path;
  }

  _createHeart(cx, cy, radius, props) {
    // 使用更精确的心形路径数据
    const size = radius;
    const pathData = `M ${cx},${cy + size * 0.35}
      C ${cx - size * 0.5},${cy - size * 0.3}, ${cx - size},${cy - size * 0.3}, ${cx - size * 0.7},${cy + size * 0.1}
      C ${cx - size},${cy + size * 0.4}, ${cx - size * 0.3},${cy + size}, ${cx},${cy + size * 1.15}
      C ${cx + size * 0.3},${cy + size}, ${cx + size},${cy + size * 0.4}, ${cx + size * 0.7},${cy + size * 0.1}
      C ${cx + size},${cy - size * 0.3}, ${cx + size * 0.5},${cy - size * 0.3}, ${cx},${cy + size * 0.35} Z`;

    const heart = new fabric.Path(pathData, {
      ...props,
      left: cx,
      top: cy,
      originX: 'center',
      originY: 'center',
    });

    return heart;
  }

  _createTrapezoid(left, top, width, height, props) {
    // 更明显的梯形：上窄下宽
    const points = [
      [left + width * 0.2, top],           // 左上
      [left + width * 0.8, top],           // 右上
      [left + width, top + height],        // 右下
      [left, top + height],                // 左下
    ];

    return new fabric.Polygon(points, {
      ...props,
      left: left + width / 2,
      top: top + height / 2,
      originX: 'center',
      originY: 'center',
    });
  }

  _createLine(startPoint, endPoint, props) {
    return new fabric.Line([startPoint.x, startPoint.y, endPoint.x, endPoint.y], {
      ...props,
      stroke: props.stroke,
      strokeWidth: props.strokeWidth,
      fill: null,
    });
  }

  _createArrow(startPoint, endPoint, props) {
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 10) return null;

    const angle = Math.atan2(dy, dx);
    const headlen = Math.min(distance * 0.25, 25);

    // 主线条
    const line = new fabric.Line(
      [startPoint.x, startPoint.y, endPoint.x, endPoint.y],
      {
        stroke: props.stroke,
        strokeWidth: props.strokeWidth,
        fill: null,
      }
    );

    // 箭头头部（填充三角形）
    const arrowHeadPoints = [
      [endPoint.x, endPoint.y],
      [
        endPoint.x - headlen * Math.cos(angle - Math.PI / 6),
        endPoint.y - headlen * Math.sin(angle - Math.PI / 6),
      ],
      [
        endPoint.x - headlen * Math.cos(angle + Math.PI / 6),
        endPoint.y - headlen * Math.sin(angle + Math.PI / 6),
      ],
    ];

    const arrowHead = new fabric.Polygon(arrowHeadPoints, {
      fill: props.stroke,
      stroke: 'transparent',
      strokeWidth: 0,
    });

    const group = new fabric.Group([line, arrowHead], {
      selectable: false,
      evented: false,
    });

    return group;
  }

  _removePreviewShape() {
    if (!this._previewShape) return;

    const canvas = this.canvasManager.canvas;
    if (canvas) {
      canvas.remove(this._previewShape);
    }
    this._previewShape = null;
  }

  _normalizeColor(color, fallback = '#000000', allowTransparent = false) {
    if (allowTransparent && color === 'transparent') return 'transparent';

    if (typeof color !== 'string') return fallback;

    const value = color.trim().toLowerCase();

    // 处理 rgba 格式
    if (value.startsWith('rgba')) return value;

    // 处理 hex 格式
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return '#' + value.slice(1).split('').map(ch => ch + ch).join('');
    }

    return fallback;
  }

  _extractHexColor(color) {
    if (typeof color !== 'string') return '#000000';

    // 如果已经是 hex 格式，直接返回
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;

    // 从 rgba 中提取
    const rgbaMatch = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (rgbaMatch) {
      const r = parseInt(rgbaMatch[1], 10).toString(16).padStart(2, '0');
      const g = parseInt(rgbaMatch[2], 10).toString(16).padStart(2, '0');
      const b = parseInt(rgbaMatch[3], 10).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }

    return '#000000';
  }

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  _escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"]/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  }
}

export default ShapeModule;
