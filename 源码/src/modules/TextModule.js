import BaseModule from './BaseModule.js';
import eventBus from '../core/EventBus.js';

/**
 * 加字模块 — 在图片上添加文字标注
 * 使用 fabric.IText 支持双击编辑
 */
class TextModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, {
      fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
      fontSize: 24,
      fill: '#d83b31',
      stroke: null,
      strokeWidth: 0,
      fontWeight: 'normal',
      fontStyle: 'normal',
      underline: false,
      textAlign: 'left',
      ...defaultOptions,
    });

    this._boundMouseDown = this._onMouseDown.bind(this);
  }

  activate(options = {}) {
    super.activate(options);  // 禁用所有对象交互
    const canvas = this.canvasManager.canvas;

    // 恢复文字对象的交互性（允许点击已有文字进行编辑）
    canvas.getObjects().forEach(obj => {
      if (obj.type === 'i-text' || obj.type === 'text' || obj.type === 'textbox') {
        obj.set({ selectable: true, evented: true });
      }
    });

    canvas.defaultCursor = 'text';
    canvas.on('mouse:down', this._boundMouseDown);
    eventBus.emit('module:activated', 'text');
  }

  deactivate() {
    const canvas = this.canvasManager.canvas;
    canvas.off('mouse:down', this._boundMouseDown);

    // 提交所有正在编辑的文字
    canvas.getObjects().forEach(obj => {
      if (obj.isEditing) {
        obj.exitEditing();
      }
    });

    super.deactivate();  // 恢复所有对象交互
  }

  /**
   * 点击位置添加文字
   */
  addTextOnClick(x, y) {
    this.addText('双击编辑', x, y);
  }

  /**
   * 在指定位置添加文字
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @returns {fabric.IText}
   */
  addText(text, x, y) {
    const canvas = this.canvasManager.canvas;
    const opts = this.options;

    const textObj = new fabric.IText(text, {
      left: x,
      top: y,
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      fill: opts.fill,
      stroke: opts.stroke,
      strokeWidth: opts.strokeWidth,
      fontWeight: opts.fontWeight,
      fontStyle: opts.fontStyle,
      underline: opts.underline,
      textAlign: opts.textAlign,
      editable: true,
      id: 'text_' + Date.now(),
    });

    canvas.add(textObj);
    canvas.setActiveObject(textObj);
    canvas.renderAll();

    // 进入编辑模式
    setTimeout(() => {
      textObj.enterEditing();
      textObj.selectAll();
    }, 50);

    this.history.saveState();
    return textObj;
  }

  // ── 样式设置 ──

  setFontFamily(family) {
    this.options.fontFamily = family;
    this._updateActiveTextStyle('fontFamily', family);
  }

  setFontSize(size) {
    this.options.fontSize = parseInt(size);
    this._updateActiveTextStyle('fontSize', parseInt(size));
  }

  setFontWeight(weight) {
    this.options.fontWeight = weight;
    this._updateActiveTextStyle('fontWeight', weight);
  }

  setFontStyle(style) {
    this.options.fontStyle = style;
    this._updateActiveTextStyle('fontStyle', style);
  }

  setTextColor(color) {
    this.options.fill = color;
    this._updateActiveTextStyle('fill', color);
  }

  setStroke(color, width) {
    this.options.stroke = color;
    this.options.strokeWidth = width;
    this._updateActiveTextStyle('stroke', color);
    this._updateActiveTextStyle('strokeWidth', width);
  }

  setUnderline(underline) {
    this.options.underline = underline;
    this._updateActiveTextStyle('underline', underline);
  }

  setBackgroundColor(color) {
    this._updateActiveTextStyle('backgroundColor', color);
  }

  /**
   * 应用文字预设样式
   * @param {string} presetName - 'red' | 'white' | 'yellow'
   */
  applyPreset(presetName) {
    const presets = {
      red: {
        fill: '#d83b31',
        fontWeight: 'bold',
        stroke: '#FFFFFF',
        strokeWidth: 2,
      },
      white: {
        fill: '#FFFFFF',
        fontWeight: 'normal',
        stroke: null,
        strokeWidth: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
      },
      yellow: {
        fill: '#FFD700',
        fontWeight: 'bold',
        stroke: '#000000',
        strokeWidth: 2,
      },
    };

    const preset = presets[presetName];
    if (!preset) return;

    Object.entries(preset).forEach(([key, value]) => {
      this.options[key] = value;
      this._updateActiveTextStyle(key, value);
    });
  }

  // ── 内部 ──

  _updateActiveTextStyle(prop, value) {
    const active = this.canvasManager.getActiveObject();
    if (active && (active.type === 'i-text' || active.type === 'text' || active.type === 'textbox')) {
      active.set(prop, value);
      this.canvasManager.canvas.renderAll();
    }
  }

  _onMouseDown(e) {
    const canvas = this.canvasManager.canvas;
    const pointer = canvas.getPointer(e.e);

    // 检查是否点到了已有的文字
    const target = e.target;
    if (target && (target.type === 'i-text' || target.type === 'text')) {
      // 允许选择和编辑已有文字
      return;
    }

    // 添加新文字
    this.addTextOnClick(pointer.x, pointer.y);
  }

  // ── 选项栏 ──

  getOptionsBarHTML() {
    const opts = this.options;
    return `
      <div class="options-group">
        <label class="options-label">字体</label>
        <select class="options-select" id="text-font-family">
          <option value="Microsoft YaHei, PingFang SC, sans-serif">微软雅黑</option>
          <option value="SimSun, STSong, serif">宋体</option>
          <option value="SimHei, STHeiti, sans-serif">黑体</option>
          <option value="KaiTi, STKaiti, serif">楷体</option>
          <option value="Arial, sans-serif">Arial</option>
        </select>
      </div>
      <div class="options-group">
        <label class="options-label">字号</label>
        <select class="options-select" id="text-font-size">
          ${[12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72].map(s =>
            `<option value="${s}" ${s === opts.fontSize ? 'selected' : ''}>${s}</option>`
          ).join('')}
        </select>
      </div>
      <div class="options-group">
        <label class="options-label">颜色</label>
        <input type="color" class="options-color" id="text-color" value="${opts.fill}" />
      </div>
      <div class="options-group">
        <button class="options-btn" id="text-bold" title="粗体" style="font-weight:bold">B</button>
        <button class="options-btn" id="text-italic" title="斜体" style="font-style:italic">I</button>
        <button class="options-btn" id="text-underline" title="下划线" style="text-decoration:underline">U</button>
      </div>
      <div class="options-group">
        <label class="options-label">预设</label>
        <button class="options-btn options-btn-sm" data-preset="red" style="color:#d83b31">标注红</button>
        <button class="options-btn options-btn-sm" data-preset="white">说明白</button>
        <button class="options-btn options-btn-sm" data-preset="yellow" style="color:#FFD700">标题黄</button>
      </div>
    `;
  }

  // ── 属性面板 ──

  getPropertyPanelHTML() {
    const active = this.canvasManager.getActiveObject();
    if (!active || (active.type !== 'i-text' && active.type !== 'text' && active.type !== 'textbox')) {
      return '<div class="property-empty">选中文字物件以编辑属性</div>';
    }

    return `
      <div class="property-item">
        <label>字号</label>
        <input type="number" class="property-input" data-prop="fontSize" value="${active.fontSize}" min="8" max="200" />
      </div>
      <div class="property-item">
        <label>颜色</label>
        <input type="color" class="property-color" data-prop="fill" value="${active.fill}" />
      </div>
      <div class="property-item">
        <label>描边</label>
        <input type="color" class="property-color" data-prop="stroke" value="${active.stroke || '#000000'}" />
      </div>
      <div class="property-item">
        <label>不透明度</label>
        <input type="range" class="property-range" data-prop="opacity" min="0" max="100" value="${Math.round(active.opacity * 100)}" />
        <span class="property-value">${Math.round(active.opacity * 100)}%</span>
      </div>
    `;
  }

  onPropertyChange(key, value) {
    const active = this.canvasManager.getActiveObject();
    if (!active) return;

    switch (key) {
      case 'fontSize':
        active.set('fontSize', parseInt(value));
        break;
      case 'fill':
        active.set('fill', value);
        break;
      case 'stroke':
        active.set('stroke', value);
        break;
      case 'opacity':
        // value 已被 _handleInput 转换为 0-1 区间，直接使用
        active.set('opacity', value);
        break;
    }

    this.canvasManager.canvas.renderAll();
  }
}

export default TextModule;
