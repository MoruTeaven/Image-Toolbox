import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { clamp, escapeAttr, normalizeColor } from '../utils/helpers.js';
import { pickColorFromScreen } from '../utils/colorPicker.js';
import { getDomPort } from '../ports/DomPort.js';

/**
 * 画笔模块 - 使用 Fabric 自由绘制生成可编辑的 path 图层。
 *
 * 光标指示的实现说明（重要）：
 * 早期版本把光标做成 Fabric 画布对象（Group + 三个 Circle），结果反复出问题：
 *   - 缩放后光标对象坐标正确、visible=true，但 Fabric 在 isDrawingMode 下
 *     不再把它画出来（真机逐像素扫描：缩放后整张画布 0 个红色像素）；
 *   - 撤销/重做、换图重建对象后引用失效；
 *   - 外圈 + 主圈 + 中心点看起来是「两个圈」。
 * 现在改为独立的 DOM 覆盖层：用原生 mousemove 的 clientX/clientY 直接定位
 * （position:fixed），与画布缩放变换、对象缓存、历史序列化彻底解耦，且只有
 * 一个圈。缩放不会移动鼠标，所以光标天然保持在鼠标正下方。
 */
class BrushModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      color: '#d83b31',
      width: 6,
      ...defaultOptions,
    });

    this._cursorEl = null;
    this._lastClientPoint = null;
    this._eventBusUnsubscribers = null;
    this._savedBeforeStroke = false;
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseEnter = this._onMouseEnter.bind(this);
    this._boundMouseLeave = this._hideCursorPreview.bind(this);
    this._boundPathCreated = this._onPathCreated.bind(this);
    this._boundZoomChanged = this._onZoomChanged.bind(this);
  }

  activate(options = {}) {
    super.activate(options);

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    canvas.discardActiveObject();
    canvas.isDrawingMode = true;
    canvas.defaultCursor = 'none';
    canvas.hoverCursor = 'none';
    canvas.freeDrawingCursor = 'none';
    this._ensureBrush();
    this._applyBrushOptions();
    // 重复 activate 时先清理旧监听，避免同一回调绑定多次。
    this._unbindEvents();
    this._bindEvents(canvas);
    // 缩放时只需同步光圈直径；位置由 clientX/clientY 决定，缩放不动鼠标=不漂。
    this._eventBusUnsubscribers = [
      eventBus.on('canvas:zoomChanged', this._boundZoomChanged),
    ];
    // DOM 覆盖层光标：画布重建、缩放都不影响它；切回工具时按最后位置恢复。
    this._ensureCursorEl();
    if (this._lastClientPoint) {
      this._showCursorAtClient(this._lastClientPoint.clientX, this._lastClientPoint.clientY);
    }

    eventBus.emit('module:activated', 'brush');
  }

  /**
   * 绑定光标跟随所需的画布事件与原生 DOM 事件。
   * 光标位置直接取原生事件的 clientX/clientY，不经过 Fabric 的 getPointer。
   * @param {fabric.Canvas} canvas
   */
  _bindEvents(canvas) {
    canvas.on('mouse:down', this._boundMouseDown);
    canvas.on('path:created', this._boundPathCreated);
    const el = canvas.upperCanvasEl;
    if (el) {
      el.addEventListener('mousemove', this._boundMouseMove);
      el.addEventListener('mouseenter', this._boundMouseEnter);
      el.addEventListener('mouseleave', this._boundMouseLeave);
      this._boundUpperCanvasEl = el;
    }
  }

  /**
   * 解绑事件。用记录的元素引用，画布重建后也能从旧元素精确解绑。
   */
  _unbindEvents() {
    const canvas = this.canvasManager.canvas;
    if (canvas) {
      canvas.off('mouse:down', this._boundMouseDown);
      canvas.off('path:created', this._boundPathCreated);
    }
    const el = this._boundUpperCanvasEl || canvas?.upperCanvasEl;
    if (el) {
      el.removeEventListener('mousemove', this._boundMouseMove);
      el.removeEventListener('mouseenter', this._boundMouseEnter);
      el.removeEventListener('mouseleave', this._boundMouseLeave);
    }
    this._boundUpperCanvasEl = null;
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;
    this._unbindEvents();
    this._removeCursorEl();
    if (this._eventBusUnsubscribers) {
      this._eventBusUnsubscribers.forEach((unsub) => unsub && unsub());
      this._eventBusUnsubscribers = null;
    }
    if (canvas) {
      canvas.isDrawingMode = false;
      canvas.freeDrawingCursor = 'crosshair';
      canvas.hoverCursor = 'move';
      this._savedBeforeStroke = false;
    }
    super.deactivate();
  }

  _onZoomChanged() {
    // 缩放只改变笔迹的屏幕视觉宽度，光圈直径随之同步；位置不动。
    this._applyCursorStyle();
  }

  setColor(color) {
    this.options.color = normalizeColor(color, this.options.color);
    this._applyBrushOptions();
    this._applyCursorStyle();
  }

  setWidth(width) {
    const parsed = parseInt(width, 10);
    this.options.width = this._clamp(Number.isFinite(parsed) ? parsed : this.options.width, 1, 80);
    this._applyBrushOptions();
    this._applyCursorStyle();
  }

  applyPreset(presetName) {
    if (presetName === 'brush-pick-color') {
      this._pickColorFromScreen();
      return;
    }

    const presets = {
      'brush-red': { color: '#d83b31' },
      'brush-blue': { color: '#1677ff' },
      'brush-yellow': { color: '#ffd700' },
      'brush-green': { color: '#2ead4a' },
      'brush-white': { color: '#ffffff' },
      'brush-black': { color: '#111111' },
      'brush-thin': { width: 3 },
      'brush-medium': { width: 6 },
      'brush-thick': { width: 12 },
      'brush-heavy': { width: 24 },
    };

    const preset = presets[presetName];
    if (!preset) return;

    if (preset.color) this.setColor(preset.color);
    if (preset.width) this.setWidth(preset.width);
  }

  /**
   * 屏幕取色应用到画笔颜色。取色界面是异步的，完成后广播属性变更
   * 让选项栏刷新色块 active 态（applyPreset 同步返回时取色还没结束）。
   */
  _pickColorFromScreen() {
    pickColorFromScreen(normalizeColor(this.options.color)).then((color) => {
      if (!color) return;
      this.setColor(color);
      eventBus.emit('tool:propertiesChanged');
    });
  }

  getOptionsBarHTML() {
    const color = normalizeColor(this.options.color);
    const width = this.options.width;

    return `
      <div class="options-group">
        ${this._getColorPresetButton('brush-red', '红', '#d83b31', color)}
        ${this._getColorPresetButton('brush-blue', '蓝', '#1677ff', color)}
        ${this._getColorPresetButton('brush-yellow', '黄', '#ffd700', color)}
        ${this._getColorPresetButton('brush-green', '绿', '#2ead4a', color)}
        ${this._getColorPresetButton('brush-white', '白', '#ffffff', color)}
        ${this._getColorPresetButton('brush-black', '黑', '#111111', color)}
        <button class="options-btn options-btn-sm" data-preset="brush-pick-color" title="从屏幕任意位置取色">吸管</button>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-sm ${width === 3 ? 'active' : ''}" data-preset="brush-thin">细</button>
        <button class="options-btn options-btn-sm ${width === 6 ? 'active' : ''}" data-preset="brush-medium">中</button>
        <button class="options-btn options-btn-sm ${width === 12 ? 'active' : ''}" data-preset="brush-thick">粗</button>
        <button class="options-btn options-btn-sm ${width === 24 ? 'active' : ''}" data-preset="brush-heavy">特粗</button>
      </div>
    `;
  }

  getPropertyPanelHTML() {
    return `
      <div class="property-section-title">画笔工具</div>
      <div class="property-item">
        <label>颜色</label>
        <input type="color" class="property-color" data-module-prop="color" value="${escapeAttr(normalizeColor(this.options.color))}" />
      </div>
      <div class="property-item property-item--wide">
        <label>粗细</label>
        <input type="range" class="property-range" data-module-prop="width" min="1" max="80" value="${this.options.width}" />
        <span class="property-value">${this.options.width}px</span>
      </div>
      <div class="property-empty">按住鼠标拖拽即可绘制，生成的画笔会作为独立图层。</div>
    `;
  }

  onToolPropertyChange(key, value) {
    switch (key) {
      case 'color':
        this.setColor(value);
        return true;
      case 'width':
        this.setWidth(value);
        return true;
      default:
        return false;
    }
  }

  _onMouseDown(e) {
    const nativeEvent = e?.e;
    if (nativeEvent && typeof nativeEvent.button === 'number' && nativeEvent.button !== 0) return;

    this.history.saveState('画笔');
    this._savedBeforeStroke = true;
  }

  _onMouseMove(e) {
    const nativeEvent = e?.e || e;
    if (!nativeEvent) return;
    if (typeof nativeEvent.clientX !== 'number' || typeof nativeEvent.clientY !== 'number') return;
    this._showCursorAtClient(nativeEvent.clientX, nativeEvent.clientY);
  }

  _onMouseEnter(e) {
    // 鼠标进入画布时立即显示，无需等待移动。
    this._onMouseMove(e);
  }

  _onPathCreated(e) {
    const path = e.path;
    if (!path) return;

    path.set({
      id: 'brush_' + Date.now(),
      fill: null,
      stroke: this.options.color,
      strokeWidth: this.options.width,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
      _layerKind: 'brush',
      _layerColorPresetName: this._getColorPresetName(this.options.color),
      _layerWidthPresetName: this._getWidthPresetName(this.options.width),
    });
    path.setCoords();
    this.canvasManager.canvas.discardActiveObject();
    this.canvasManager.canvas.renderAll();
    eventBus.emit('canvas:objectMetadataChanged', path);
    this._savedBeforeStroke = false;
  }

  // ── DOM 覆盖层光标 ────────────────────────────────────────────

  /**
   * 创建光标 DOM 元素（单个圆圈）。经 DomPort 访问 DOM，符合 core 非 UI 层边界。
   * 用 position:fixed + clientX/clientY 定位：不受画布缩放/平移/对象重建影响。
   */
  _ensureCursorEl() {
    if (this._cursorEl) return this._cursorEl;
    const dom = getDomPort();
    const el = dom?.createElement?.('div');
    if (!el) return null;

    this._setStyle(el, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '6px',
      height: '6px',
      'border-radius': '50%',
      border: '2px solid',
      'background-color': 'transparent',
      'pointer-events': 'none',
      'z-index': '10000',
      transform: 'translate(-50%, -50%)',
      display: 'none'
    });
    if (el.dataset) { el.dataset.brushCursor = '1'; }
    const body = dom?.getBody?.() || null;
    if (body?.appendChild) { body.appendChild(el); } else { return null; }
    this._cursorEl = el;
    this._applyCursorStyle();
    return el;
  }

  /**
   * 把光标移动到鼠标屏幕坐标并显示，同时记录该坐标。
   * @param {number} clientX
   * @param {number} clientY
   */
  _showCursorAtClient(clientX, clientY) {
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return;
    const el = this._ensureCursorEl();
    if (!el) return;
    this._lastClientPoint = { clientX, clientY };
    this._setStyle(el, {
      left: `${clientX}px`,
      top: `${clientY}px`,
      display: 'block'
    });
  }

  /**
   * 应用画笔颜色/粗细/缩放对应的光圈样式。
   * 画布上的笔迹宽度是场景单位，屏幕直径 = 宽度 × 当前缩放。
   */
  _applyCursorStyle() {
    const el = this._cursorEl;
    if (!el) return;
    const color = normalizeColor(this.options.color, '#d83b31');
    const zoom = Number(this.canvasManager?.zoomLevel) || 1;
    const diameter = Math.max(this.options.width * zoom, 6);
    this._setStyle(el, {
      width: `${diameter}px`,
      height: `${diameter}px`,
      'border-color': color,
      'background-color': this._colorToRgba(color, 0.16)
    });
  }

  _setStyle(el, props) {
    if (!el?.style) return;
    for (const [key, value] of Object.entries(props)) {
      if (typeof el.style.setProperty === 'function') {
        el.style.setProperty(key, String(value));
      } else {
        el.style[key] = value;
      }
    }
  }

  _hideCursorPreview() {
    if (!this._cursorEl) return;
    this._setStyle(this._cursorEl, { display: 'none' });
  }

  _removeCursorEl() {
    const el = this._cursorEl;
    if (!el) return;
    el.parentNode?.removeChild?.(el);
    this._cursorEl = null;
  }

  _colorToRgba(color, alpha) {
    const value = normalizeColor(color, '#000000');
    const hex = value.startsWith('#') ? value.slice(1) : '';
    if (!/^[0-9a-f]{6}$/i.test(hex)) {
      // 非 hex 输入（如 rgba()）时退化为半透明黑，避免解析出 NaN
      return `rgba(0, 0, 0, ${alpha})`;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

    canvas.freeDrawingBrush.color = this.options.color;
    canvas.freeDrawingBrush.width = this.options.width;
  }

  _getColorPresetButton(preset, label, color, currentColor) {
    const normalized = normalizeColor(color);
    const active = currentColor === normalized ? ' active' : '';
    return `
      <button class="options-btn options-btn-sm brush-color-btn${active}" data-preset="${preset}" style="--brush-color:${normalized}">
        <span class="brush-color-dot"></span>${label}
      </button>
    `;
  }

  _normalizeColor(color, fallback = '#000000') {
    return normalizeColor(color, fallback);
  }

  _getColorPresetName(color) {
    const colorMap = {
      '#d83b31': '红',
      '#1677ff': '蓝',
      '#ffd700': '黄',
      '#2ead4a': '绿',
      '#ffffff': '白',
      '#111111': '黑',
    };

    return colorMap[normalizeColor(color, '')] || '';
  }

  _getWidthPresetName(width) {
    const widthMap = {
      3: '细',
      6: '中',
      12: '粗',
      24: '特粗',
    };

    return widthMap[Math.round(Number(width))] || '';
  }

  _clamp(value, min, max) {
    return clamp(value, min, max);
  }

  _escapeAttr(value) {
    return escapeAttr(value);
  }
}

export default BrushModule;
