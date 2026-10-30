import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { listAiCapabilities, getAiCapability } from '../ai/AI_PROVIDERS.js';
import { runCapability } from '../ai/LocalOnnxProvider.js';
import { createCanvas2D } from '../ports/CanvasPort.js';

/**
 * 单边输入像素上限：u2netp 推理输入固定缩到 320×320，但输入图层
 * 在合成 alpha 前会以原始分辨率驻留内存（宽×高×4 字节）。超过该上限
 * 的图层直接拒绝执行，避免一次抠图占用数百 MB 内存。
 */
const MAX_INPUT_EDGE = 4096;

/** 输出背景色映射：面板取值 → rmbg-webgpu 的 backgroundColor 参数。 */
const OUTPUT_BACKGROUND = {
  transparent: null,
  white: [255, 255, 255, 255]
};

/**
 * AI 修图模块 — 左侧工具栏「AI」工具
 *
 * 面板由 AI_PROVIDERS 注册表派生：能力清单、描述、执行路由全部来自表，
 * 新增 AI 能力只改注册表与对应 Provider，不改本模块结构。
 * 结果一律生成为新图片图层（继承源图层变换），经 HistoryManager 快照
 * 纳入撤销链路；源图层保持不动，由用户决定去留。
 */
class AIModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}) {
    super(canvasManager, historyManager, defaultOptions);
    // 此模块接管属性面板（与调色模块一致）：即使有选中对象也显示 AI 控件
    this.overridePropertyPanel = true;
    this._running = false;
  }

  activate(options = {}) {
    this.active = true;
    this.options = { ...this.options, ...options };

    const canvas = this.canvasManager.canvas;
    if (!canvas) {
      return;
    }

    canvas.selection = true;
    canvas.defaultCursor = 'default';
    // 保持未锁定图层可选中：抠图作用于用户选中的图片图层
    this._enableEditableLayerInteractivity();
  }

  deactivate() {
    this.active = false;
  }

  /**
   * 属性面板（由 AI_PROVIDERS 注册表派生）
   * @returns {string}
   */
  getPropertyPanelHTML() {
    const capabilities = listAiCapabilities();
    const sections = capabilities.map((capability) => this._getCapabilityHTML(capability)).join('');
    return `
      <div class="property-section-title">AI 修图</div>
      <div class="ai-note">推理在本地完成，图片不会上传到服务器。</div>
      ${sections}
    `;
  }

  /**
   * 渲染单个能力区块
   * @param {object} capability AI_CAPABILITIES 表项
   * @returns {string}
   */
  _getCapabilityHTML(capability) {
    const target = this._getTargetImage();
    if (!target) {
      return `
        <div class="property-section-title">${capability.label}</div>
        <div class="ai-note ai-note--muted">${capability.description}</div>
        <div class="property-empty">选中图片图层后使用（背景图也可以）</div>
      `;
    }

    const outputMode = this._getOutputMode(capability.id);
    const outputOptions = [
      { value: 'transparent', label: '透明背景' },
      { value: 'white', label: '白色背景' }
    ].map((item) => (
      `<option value="${item.value}" ${item.value === outputMode ? 'selected' : ''}>${item.label}</option>`
    )).join('');

    return `
      <div class="property-section-title">${capability.label}</div>
      <div class="ai-note ai-note--muted">${capability.description}</div>
      <div class="ai-note">目标图层：${this._escapeHtml(this._getObjectDisplayName(target))}</div>
      <div class="property-item">
        <label>输出</label>
        <select class="property-select" data-module-prop="${capability.id}:outputMode">
          ${outputOptions}
        </select>
      </div>
      <div class="property-item property-item--wide property-item--actions">
        <button type="button" class="property-btn property-btn--primary"
                data-module-action="${capability.id}:run">开始${capability.label}</button>
      </div>
      <div class="ai-note ai-note--muted">首次使用需加载本地模型（约 5 MB），之后自动复用。</div>
    `;
  }

  /**
   * 面板控件变化（能力前缀:键）
   * @param {string} prop
   * @param {*} value
   * @returns {boolean} true 表示已处理
   */
  onToolPropertyChange(prop, value) {
    if (typeof prop !== 'string' || !prop.includes(':')) {
      return false;
    }
    const [capabilityId, key] = prop.split(':');
    if (!getAiCapability(capabilityId)) {
      return false;
    }
    if (key === 'outputMode') {
      this.options[`${capabilityId}:outputMode`] = OUTPUT_BACKGROUND[value] !== undefined ? value : 'transparent';
      return true;
    }
    return false;
  }

  /**
   * 面板动作（能力前缀:动作）
   * @param {string} action
   */
  onToolPropertyAction(action) {
    if (typeof action !== 'string' || !action.includes(':')) {
      return;
    }
    const [capabilityId, verb] = action.split(':');
    if (verb !== 'run') {
      return;
    }
    const capability = getAiCapability(capabilityId);
    if (!capability) {
      return;
    }
    if (this._running) {
      eventBus.emit('toast:show', { message: 'AI 任务进行中，请稍候', type: 'error' });
      return;
    }
    this._executeCapability(capability);
  }

  // ── 执行链 ──

  /**
   * 执行一个 AI 能力：取选中图层 → 本地推理 → 新图层入画布并入历史。
   * @param {object} capability AI_CAPABILITIES 表项
   */
  async _executeCapability(capability) {
    const target = this._getTargetImage();
    if (!target) {
      eventBus.emit('toast:show', { message: '请先选中要处理的图片图层', type: 'error' });
      return;
    }

    const element = target.getElement ? target.getElement() : target._element;
    const width = element ? (element.naturalWidth || element.width) : 0;
    const height = element ? (element.naturalHeight || element.height) : 0;
    if (!width || !height) {
      eventBus.emit('toast:show', { message: '图层不含可处理的像素', type: 'error' });
      return;
    }
    if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) {
      eventBus.emit('toast:show', { message: `图层尺寸过大（上限 ${MAX_INPUT_EDGE}px），请缩小后再试`, type: 'error' });
      return;
    }

    const surface = createCanvas2D(width, height);
    if (!surface) {
      eventBus.emit('toast:show', { message: '当前环境不支持画布处理', type: 'error' });
      return;
    }

    this._running = true;
    eventBus.emit('ai:taskStarted', { capability: capability.id });
    eventBus.emit('toast:show', { message: `正在${capability.label}（本地推理中）…`, type: 'info' });

    try {
      surface.ctx.drawImage(element, 0, 0);
      const imageData = surface.ctx.getImageData(0, 0, width, height);
      const outputMode = this._getOutputMode(capability.id);
      const result = await runCapability(imageData, capability.id, {
        backgroundColor: OUTPUT_BACKGROUND[outputMode] ?? null
      });
      this._applyResultAsLayer(target, result.output, capability);
      eventBus.emit('ai:taskFinished', {
        capability: capability.id,
        timingMs: result.timingMs,
        executionProvider: result.executionProvider
      });
    } catch (err) {
      console.error(`[AIModule] ${capability.label}失败:`, err);
      eventBus.emit('ai:taskFailed', { capability: capability.id, reason: err?.message || 'unknown' });
      eventBus.emit('toast:show', { message: `${capability.label}失败：${err?.message || '未知错误'}`, type: 'error' });
    } finally {
      this._running = false;
    }
  }

  /**
   * 把推理输出写为新图层：继承源图层位置/缩放/角度，置于最上层并入历史。
   * @param {fabric.Image} source 源图层
   * @param {ImageData} output 抠图结果像素
   * @param {object} capability 能力定义
   */
  _applyResultAsLayer(source, output, capability) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) {
      return;
    }

    const surface = createCanvas2D(output.width, output.height);
    if (!surface) {
      throw new Error('结果画布创建失败');
    }
    surface.ctx.putImageData(output, 0, 0);

    const layer = new fabric.Image(surface.canvas, {
      left: source.left,
      top: source.top,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
      angle: source.angle || 0,
      flipX: !!source.flipX,
      flipY: !!source.flipY,
      originX: source.originX,
      originY: source.originY
    });
    layer.set({ _layerName: `AI ${capability.label}`, _layerNameAuto: false });

    this.canvasManager.addObject(layer);
    this.history?.saveState?.();
    eventBus.emit('toast:show', { message: `${capability.label}完成，已生成为新图层`, type: 'success' });
  }

  // ── 工具方法 ──

  /**
   * 取抠图目标：当前选中的图片图层（排除辅助对象）。
   * @returns {fabric.Image|null}
   */
  _getTargetImage() {
    const canvas = this.canvasManager.canvas;
    if (!canvas) {
      return null;
    }
    const active = canvas.getActiveObject ? canvas.getActiveObject() : null;
    if (!active || active.excludeFromLayer || active.excludeFromHistory) {
      return null;
    }
    if (active.type !== 'image') {
      return null;
    }
    const element = active.getElement ? active.getElement() : active._element;
    return element ? active : null;
  }

  /**
   * 读取能力输出模式（默认透明背景）。
   * @param {string} capabilityId
   * @returns {string}
   */
  _getOutputMode(capabilityId) {
    return this.options[`${capabilityId}:outputMode`] || 'transparent';
  }

  /**
   * 图层展示名（优先用户命名）。
   * @param {object} obj
   * @returns {string}
   */
  _getObjectDisplayName(obj) {
    if (obj && typeof obj._layerName === 'string' && obj._layerName.trim()) {
      return obj._layerName.trim();
    }
    return obj.type === 'image' ? '图片图层' : (obj.type || '图层');
  }

  /**
   * HTML 转义（图层名可能含用户输入）。
   * @param {string} text
   * @returns {string}
   */
  _escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

export default AIModule;
