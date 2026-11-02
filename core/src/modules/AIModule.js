import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { listAiCapabilities, getAiCapability, AI_PROVIDER_IDS, AI_PROMPT_PRESETS, getAiPromptPreset } from '../ai/AI_PROVIDERS.js';
import { runCapability } from '../ai/LocalOnnxProvider.js';
import { requestInstruction } from '../ai/OpenAiCompatProvider.js';
import { getAiConfig, isAiConfigReady, setAiConfigField, AI_CONFIG_LIMITS } from '../ai/AI_CONFIG.js';
import { parseInstruction, describeActions, applyActionsToImage } from '../ai/AI_INSTRUCTION.js';
import { FILTER_PRESETS, setFilter, applyFilterPreset } from '../utils/filters.js';
import { requestRender } from '../utils/helpers.js';
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
 * 应用方式映射：面板取值 → 行为。
 *   new-layer  先把当前图层复制一份（独立像素与滤镜副本），指令只作用于副本，
 *              原始图层保持不动 —— 默认值，与「AI 结果一律新图层」的既有纪律一致；
 *   in-place   直接修改当前选中的图层，不改动其它图层。
 */
const APPLY_MODES = {
  newLayer: 'new-layer',
  inPlace: 'in-place'
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
   *
   * 只渲染表里 inPanel !== false 的能力：阶段内收敛入口时在表里改标志即可，
   * 能力本身（执行路由、模型资产、指令触发）不受影响。
   * @returns {string}
   */
  getPropertyPanelHTML() {
    const capabilities = listAiCapabilities().filter((capability) => capability.inPanel !== false);
    const sections = capabilities.map((capability) => this._getCapabilityHTML(capability)).join('');
    // 顶层不再笼统断言「图片不上传」：数据去向按能力在各自区块里说明，
    // 避免文案与行为不符。只剩一个能力时不再加总标题（会和能力标题重复）。
    const heading = capabilities.length > 1 ? '<div class="property-section-title">AI 修图</div>' : '';
    return `
      ${heading}
      ${sections}
    `;
  }

  /**
   * 顶部预设栏：一批预设提示词（AI_PROMPT_PRESETS 表派生）。
   * 点击经 OptionsBar 的 [data-preset] 委托路由到 applyPreset——
   * 只填入右侧栏提示词框、不自动发起请求：预设是"起手式"，
   * 用户通常还要改几个字；自动执行会让每次误触都变成一次计费请求。
   * 横向溢出由 .optionsbar 自身的 overflow-x 滚动承担，无需内部容器。
   * @returns {string}
   */
  getOptionsBarHTML() {
    const chips = AI_PROMPT_PRESETS.map((preset) => `
      <button type="button" class="ai-preset-chip" data-preset="${preset.id}"
              title="${this._escapeHtml(preset.prompt)}">${this._escapeHtml(preset.label)}</button>
    `).join('');
    return `
      <span class="ai-preset-label">提示词预设</span>
      ${chips}
    `;
  }

  /**
   * 顶部预设点击：把预设提示词填入右侧栏草稿并刷新面板。
   * 面板刷新由 OptionsBar 在本方法返回后统一触发（tool:propertiesChanged）。
   * @param {string} presetId AI_PROMPT_PRESETS 的 id
   */
  applyPreset(presetId) {
    const preset = getAiPromptPreset(presetId);
    if (!preset) {
      return;
    }
    setAiConfigField('draft', preset.prompt);
    eventBus.emit('toast:show', { message: `已填入「${preset.label}」，可在右侧栏修改后执行`, type: 'info' });
  }

  /**
   * 渲染单个能力区块（按表的 entry 形态派生：action 或 prompt）
   * @param {object} capability AI_CAPABILITIES 表项
   * @returns {string}
   */
  _getCapabilityHTML(capability) {
    if (capability.entry === 'prompt') {
      return this._getPromptCapabilityHTML(capability);
    }
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
      <div class="ai-note ai-note--muted">首次使用需加载本地模型（约 5 MB），之后自动复用。推理全程在本机完成，图片不会上传。</div>
    `;
  }

  /**
   * 提示词工程能力（OpenAI 兼容服务商）：右侧栏直接写提示词。
   * @param {object} capability AI_CAPABILITIES 表项
   * @returns {string}
   */
  _getPromptCapabilityHTML(capability) {
    const target = this._getTargetImage();
    const configured = isAiConfigReady();
    const config = getAiConfig();
    const draft = config.draft || '';

    const statusLine = !configured
      ? '<div class="ai-note ai-note--warn">尚未配置服务商：请到「头像 → AI 配置」填写服务地址、Key 与模型。</div>'
      : `<div class="ai-note ai-note--muted">服务商：${this._escapeHtml(config.model || '')}（仅发送压缩预览图，原图不上传）</div>`;

    // 提示词预设只出现在顶部预设栏（getOptionsBarHTML）。属性面板
    // 不再重复渲染同一批 chips —— 同一批快捷入口放两处，点哪一处都要
    // 重新决策，且会挤占文本输入区的垂直空间。
    // 应用方式放在最上方、按钮式单选、不加文字标签：两个选项本身已说明
    // 语义，标签纯属占位；放在提示词框上面是因为这是执行前必须先确定的
    // 口径（改原图还是产副本），放到下面容易被忽略而误改原图。
    const applyMode = this._getApplyMode(capability.id);
    const applyModeButtons = [
      { value: APPLY_MODES.newLayer, label: '新建图层' },
      { value: APPLY_MODES.inPlace, label: '编辑当前图层' }
    ].map((item) => (
      `<button type="button" class="ai-mode-btn ${item.value === applyMode ? 'ai-mode-btn--active' : ''}"
               data-module-action="${capability.id}:applyMode:${item.value}">${item.label}</button>`
    )).join('');

    return `
      <div class="property-item property-item--wide">
        <div class="ai-mode-row">${applyModeButtons}</div>
      </div>
      ${statusLine}
      <div class="property-item property-item--wide">
        <label>提示词</label>
        <textarea class="ai-prompt-box" rows="4"
                  data-module-prop="${capability.id}:draft"
                  placeholder="例如：整体偏冷一点，提高对比度并压暗高光，主体更突出">${this._escapeHtml(draft)}</textarea>
      </div>
      ${target ? `<div class="ai-note">当前图层：${this._escapeHtml(this._getObjectDisplayName(target))}</div>` : (applyMode === APPLY_MODES.inPlace
        ? '<div class="property-empty">选中图片图层后使用（背景图也可以）</div>'
        : '')}
      <div class="property-item property-item--wide property-item--actions">
        <button type="button" class="property-btn property-btn--primary"
                data-module-action="${capability.id}:run"${this._running ? ' disabled' : ''}>${this._running ? 'AI 处理中…' : '让 AI 编辑当前图层'}</button>
      </div>
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
    if (key === 'applyMode') {
      const valid = Object.values(APPLY_MODES);
      this.options[`${capabilityId}:applyMode`] = valid.includes(value) ? value : APPLY_MODES.newLayer;
      return true;
    }
    // 提示词草稿：随输随存（AI_CONFIG 决定分层存储）。刻意不刷新面板，
    // 否则用户正在输入的文本框会被重渲染打断。
    if (key === 'draft') {
      setAiConfigField('draft', value);
      return false;
    }
    if (key === 'presetHint') {
      this.options[`${capabilityId}:presetHint`] = String(value || '');
      return false;
    }
    return false;
  }

  /**
   * 面板动作（能力前缀:动作[:参数]）
   * @param {string} action
   */
  onToolPropertyAction(action) {
    if (typeof action !== 'string' || !action.includes(':')) {
      return;
    }
    const parts = action.split(':');
    const capabilityId = parts[0];
    const verb = parts[1];
    const capability = getAiCapability(capabilityId);
    if (!capability) {
      return;
    }

    // 应用方式单选（按钮组）：点击即切换并刷新面板，让选中态立刻生效
    if (verb === 'applyMode') {
      const value = parts[2];
      if (Object.values(APPLY_MODES).includes(value)) {
        this.options[`${capabilityId}:applyMode`] = value;
        this._refreshPanel();
      }
      return;
    }

    // 提示词填入口径已经收敛到顶部预设栏（OptionsBar 的 [data-preset]
    // → applyPreset），属性面板不再派发 fill 动作。
    if (verb !== 'run') {
      return;
    }
    if (this._running) {
      eventBus.emit('toast:show', { message: 'AI 任务进行中，请稍候', type: 'error' });
      return;
    }

    if (capability.provider === AI_PROVIDER_IDS.OPENAI_COMPAT) {
      this._executePromptCapability(capability);
      return;
    }
    this._executeCapability(capability);
  }

  /**
   * 提示词链路：取图层缩略图 + 提示词 → 服务商返回指令 JSON → 白名单执行。
   * 指令顺序固定为「先抠图（生成新图层）→ 再把其余指令应用到新图层」，
   * 保证滤镜作用在最终图层上且撤销一步到位。
   * @param {object} capability AI_CAPABILITIES 表项
   */
  async _executePromptCapability(capability) {
    if (!isAiConfigReady()) {
      eventBus.emit('toast:show', { message: '请先在「头像 → AI 配置」填写服务地址、Key 与模型', type: 'error' });
      return;
    }

    const source = this._getTargetImage();
    if (!source) {
      eventBus.emit('toast:show', { message: '请先选中要编辑的图片图层', type: 'error' });
      return;
    }

    const prompt = String(getAiConfig().draft || '').trim();
    if (!prompt) {
      eventBus.emit('toast:show', { message: '请先写一句提示词', type: 'error' });
      return;
    }

    const element = source.getElement ? source.getElement() : source._element;
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

    // 发给模型的只是供理解画面的缩略图，不是原图
    const preview = this._createPreviewDataUrl(element);
    if (!preview) {
      eventBus.emit('toast:show', { message: '当前环境不支持画布处理', type: 'error' });
      return;
    }

    this._running = true;
    this._refreshPanel();
    eventBus.emit('ai:taskStarted', { capability: capability.id, provider: capability.provider });
    eventBus.emit('toast:show', { message: 'AI 正在理解提示词…', type: 'info' });

    try {
      const { text } = await requestInstruction({ prompt, imageDataUrl: preview });
      const instruction = parseInstruction(text);

      if (instruction.actions.length === 0) {
        const reason = instruction.notes || '模型未给出可执行的编辑指令';
        eventBus.emit('toast:show', { message: `没有可应用的修改：${reason}`, type: 'error' });
        return;
      }

      const background = instruction.actions.find((item) => item.type === 'background');
      const rest = instruction.actions.filter((item) => item.type !== 'background');

      const applyMode = this._getApplyMode(capability.id);
      let appliedTo = source;
      if (background) {
        // 抠图本身就产新图层，不再额外复制
        appliedTo = await this._runCutoutToLayer(source, background.mode);
      } else if (applyMode === APPLY_MODES.newLayer) {
        // 复制副本只在指令确认可执行之后才创建：请求失败或全被拒绝时
        // 不会在画布上留下一个没有改动的幽灵副本。
        appliedTo = this._cloneAsNewLayer(source);
      }

      let count = rest.length;
      if (rest.length > 0) {
        count = applyActionsToImage(appliedTo, rest, {
          setFilter,
          applyFilterPreset,
          // 模型可能给中文名（label）也可能给内部 id（preset），两者都接受
          findPreset: (name) => FILTER_PRESETS.find((preset) => preset.label === name || preset.preset === name) || null,
          requestRender: () => requestRender(this.canvasManager.canvas)
        });
      }

      this.canvasManager.canvas?.requestRenderAll?.();
      this.history?.saveState?.();

      const rejectedNote = instruction.rejected.length
        ? `（${instruction.rejected.length} 条超出可用能力已忽略）`
        : '';
      const targetNote = appliedTo !== source
        ? '，已生成为新图层'
        : (applyMode === APPLY_MODES.inPlace && !background ? '，已修改当前图层' : '');
      eventBus.emit('toast:show', {
        message: `${describeActions(instruction.actions)}${rejectedNote}${targetNote}`,
        type: 'success'
      });
      eventBus.emit('ai:taskFinished', {
        capability: capability.id,
        provider: capability.provider,
        applied: count + (background ? 1 : 0),
        notes: instruction.notes
      });
    } catch (err) {
      this._reportFailure(capability, err);
    } finally {
      this._running = false;
      this._refreshPanel();
    }
  }

  /**
   * 统一失败提示：网络/解析/推理错误都转成一句用户可读的文案。
   * @param {object} capability
   * @param {Error} err
   */
  _reportFailure(capability, err) {
    const message = err?.message || '未知错误';
    console.error(`[AIModule] ${capability.label}失败:`, err);
    eventBus.emit('ai:taskFailed', { capability: capability.id, provider: capability.provider, reason: message });
    eventBus.emit('toast:show', { message: `${capability.label}失败：${message}`, type: 'error' });
  }

  /**
   * 重绘属性面板（不切换工具）：让按钮的禁用态与提示词框内容同步。
   */
  _refreshPanel() {
    eventBus.emit('tool:propertiesChanged');
  }

  /**
   * 生成发给模型的缩略图 dataURL（最长边 ≤777px，JPEG 0.77）。
   * @param {HTMLCanvasElement|HTMLImageElement} element
   * @returns {string|null}
   */
  _createPreviewDataUrl(element) {
    const sourceWidth = element.naturalWidth || element.width || 0;
    const sourceHeight = element.naturalHeight || element.height || 0;
    if (!sourceWidth || !sourceHeight) {
      return null;
    }

    const scale = Math.min(1, AI_CONFIG_LIMITS.previewMaxEdge / Math.max(sourceWidth, sourceHeight));
    const surface = createCanvas2D(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)));
    if (!surface) {
      return null;
    }
    surface.ctx.drawImage(element, 0, 0, surface.canvas.width, surface.canvas.height);
    try {
      return surface.canvas.toDataURL('image/jpeg', AI_CONFIG_LIMITS.previewQuality);
    } catch (e) {
      console.warn('[AIModule] 缩略图生成失败:', e);
      return null;
    }
  }

  /**
   * 执行一个本地 AI 能力：取选中图层 → 本地推理 → 新图层入画布并入历史。
   * @param {object} capability AI_CAPABILITIES 表项
   */
  async _executeCapability(capability) {
    const target = this._getTargetImage();
    if (!target) {
      eventBus.emit('toast:show', { message: '请先选中要处理的图片图层', type: 'error' });
      return;
    }
    const outputMode = this._getOutputMode(capability.id);

    this._running = true;
    eventBus.emit('ai:taskStarted', { capability: capability.id });
    eventBus.emit('toast:show', { message: `正在${capability.label}（本地推理中）…`, type: 'info' });

    try {
      const result = await this._runLocalCutout(target, outputMode);
      this._applyResultAsLayer(target, result.output, capability);
      eventBus.emit('ai:taskFinished', {
        capability: capability.id,
        timingMs: result.timingMs,
        executionProvider: result.executionProvider
      });
    } catch (err) {
      this._reportFailure(capability, err);
    } finally {
      this._running = false;
    }
  }

  /**
   * 本地抠图内核（一键抠图按钮与提示词链路的 background 指令共用）。
   * 只负责「源图层 → 推理 → 结果 ImageData」，入画布由调用方决定，
   * 以便提示词链路能把抠图结果继续叠上其它指令后再统一入历史。
   * @param {fabric.Image} source 源图层
   * @param {string} outputMode 'transparent' | 'white'
   * @returns {Promise<{ output: ImageData }>}
   */
  async _runLocalCutout(source, outputMode) {
    const element = source.getElement ? source.getElement() : source._element;
    const width = element ? (element.naturalWidth || element.width) : 0;
    const height = element ? (element.naturalHeight || element.height) : 0;
    if (!width || !height) {
      throw new Error('图层不含可处理的像素');
    }
    if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) {
      throw new Error(`图层尺寸过大（上限 ${MAX_INPUT_EDGE}px），请缩小后再试`);
    }

    const surface = createCanvas2D(width, height);
    if (!surface) {
      throw new Error('当前环境不支持画布处理');
    }

    surface.ctx.drawImage(element, 0, 0);
    const imageData = surface.ctx.getImageData(0, 0, width, height);
    const result = await runCapability(imageData, 'removeBackground', {
      backgroundColor: OUTPUT_BACKGROUND[outputMode] ?? null
    });
    return { output: result.output, timingMs: result.timingMs, executionProvider: result.executionProvider };
  }

  /**
   * 把源图层复制成独立的新图层（应用方式 = 新建图层）。
   *
   * 为什么复制像素而不是共享 element：fabric.Image 应用调色滤镜时会替换
   * 自己的 element，两个对象共享同一个 HTMLImageElement 会让滤镜互相污染。
   * 这里把源 element 画到独立画布上作为副本像素，并把滤镜配置深拷贝过来
   * 重新应用，副本的观感与源图层一致但完全独立。
   *
   * @param {fabric.Image} source 源图层
   * @returns {fabric.Image} 新图层（已加入画布，未入历史，由调用方统一 saveState）
   */
  _cloneAsNewLayer(source) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) {
      throw new Error('画布不可用，无法新建图层');
    }

    const element = source.getElement ? source.getElement() : source._element;
    const width = element ? (element.naturalWidth || element.width) : 0;
    const height = element ? (element.naturalHeight || element.height) : 0;
    if (!width || !height) {
      throw new Error('图层不含可处理的像素');
    }

    const surface = createCanvas2D(width, height);
    if (!surface) {
      throw new Error('当前环境不支持画布处理');
    }
    surface.ctx.drawImage(element, 0, 0);

    const layer = new fabric.Image(surface.canvas, {
      left: source.left,
      top: source.top,
      scaleX: source.scaleX,
      scaleY: source.scaleY,
      angle: source.angle || 0,
      flipX: !!source.flipX,
      flipY: !!source.flipY,
      originX: source.originX,
      originY: source.originY,
      opacity: source.opacity
    });

    // 滤镜配置随副本一起带走：副本像素取自原始 element，不重新应用滤镜
    // 会丢掉源图层已有效果（用户会看到扣了滤镜的副本）。
    const filters = source.get ? source.get('filters') : source.filters;
    if (Array.isArray(filters) && filters.length > 0) {
      layer.filters = filters.map((filter) => fabric.util.object.clone(filter));
      layer.applyFilters?.();
    }

    const sourceName = this._getObjectDisplayName(source);
    layer.set({ _layerName: `${sourceName} 副本`, _layerNameAuto: false });

    this.canvasManager.addObject(layer);
    return layer;
  }

  /**
   * 提示词链路的抠图：静默生成新图层并返回，供后续指令继续叠加。
   * @param {fabric.Image} source 源图层
   * @param {string} outputMode 'transparent' | 'white'
   * @returns {Promise<fabric.Image>} 新图层
   */
  async _runCutoutToLayer(source, outputMode) {
    const result = await this._runLocalCutout(source, outputMode);
    // 图层名固定用「抠图」：提示词能力的 label 是「AI 指令编辑」，
    // 直接拼会生成「AI AI 指令编辑」这种别扭的图层名
    const layer = this._applyResultAsLayer(source, result.output, { label: '抠图' }, { silent: true });
    if (!layer) {
      throw new Error('画布不可用，无法生成新图层');
    }
    return layer;
  }

  /**
   * 把推理输出写为新图层：继承源图层位置/缩放/角度，置于最上层。
   * @param {fabric.Image} source 源图层
   * @param {ImageData} output 抠图结果像素
   * @param {object} capability 能力定义
   * @param {object} [options]
   * @param {boolean} [options.silent] 不单独入历史与弹提示（提示词链路要
   *   把抠图与后续指令合成一次可撤销的操作，由调用方统一收尾）
   * @returns {fabric.Image|null} 新图层
   */
  _applyResultAsLayer(source, output, capability, options = {}) {
    const canvas = this.canvasManager.canvas;
    if (!canvas) {
      return null;
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
    if (!options.silent) {
      this.history?.saveState?.();
      eventBus.emit('toast:show', { message: `${capability.label}完成，已生成为新图层`, type: 'success' });
    }
    return layer;
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
   * 读取指令应用方式（默认新建图层）。
   * @param {string} capabilityId
   * @returns {string} APPLY_MODES 的取值
   */
  _getApplyMode(capabilityId) {
    const value = this.options[`${capabilityId}:applyMode`];
    return Object.values(APPLY_MODES).includes(value) ? value : APPLY_MODES.newLayer;
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
