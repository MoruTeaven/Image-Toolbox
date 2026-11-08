import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { listAiCapabilities, getAiCapability, AI_PROVIDER_IDS, listVisiblePromptPresets, getAiPromptPreset } from '../ai/AI_PROVIDERS.js';
import { runCapability } from '../ai/LocalOnnxProvider.js';
import { requestInstruction } from '../ai/OpenAiCompatProvider.js';
import { getAiConfig, getAiConfigStatus, setAiConfigField, AI_CONFIG_LIMITS, listProviders, getActiveSelection, setActiveSelection } from '../ai/AI_CONFIG.js';
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
 * AI 修图模块 — 左侧工具栏「AI」工具
 *
 * 面板由 AI_PROVIDERS 注册表派生：能力清单、描述、执行路由全部来自表，
 * 新增 AI 能力只改注册表与对应 Provider，不改本模块结构。
 * AI 指令编辑直接作用于当前选中的图层（一步历史快照，可撤销），不再有
 * 「新建图层/编辑当前图层」两种应用方式；「生成一张全新的图」属于生图
 * 能力，由 AI_PROVIDERS 阶段开关决定是否上线。
 */
class AIModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions = {}, host = null) {
    super(canvasManager, historyManager, defaultOptions, host);
    // 此模块接管属性面板（与调色模块一致）：即使有选中对象也显示 AI 控件
    this.overridePropertyPanel = true;
    this._running = false;
    // 就地修改后的对比查看态：{ target, before, after, viewing } | null。
    // before/after 是 { filters, angle, flipX, flipY, opacity } 快照。
    // 确认条三按钮：应用（正式保留）/ 查看原图↔查看更改 / 撤销（回退）。
    // 用户不做选择而进行了其它画布操作 → 视为默认同意（EditorShell 收起
    // 提示条时 emit 'toast:action:dismiss'，这里把画面恢复到「更改后」）。
    this._aiReview = null;
    this._bindReviewEvents();
  }

  /**
   * 对比查看的事件接线（模块生命周期 = 插件生命周期，处理函数对
   * _aiReview 为空时直接返回，因此常驻订阅是安全的）。
   */
  _bindReviewEvents() {
    eventBus.on('ai:review:showBefore', () => this._showReviewSnapshot('before'));
    eventBus.on('ai:review:showAfter', () => this._showReviewSnapshot('after'));
    eventBus.on('ai:review:apply', () => this._endReview());
    eventBus.on('toast:action:dismiss', () => {
      // 自动同意 / 用户点了按钮后：若画面停在「查看原图」，先恢复到
      // 更改后——默认同意的对象是修改后的结果，不能让画布停在旧画面。
      if (this._aiReview && this._aiReview.viewing === 'before') {
        this._applyLayerSnapshot(this._aiReview.after);
      }
      this._endReview();
    });
  }

  /**
   * 捕获图层的可回放快照。
   *
   * 关键点：同时记下 element 引用（base）。fabric 应用滤镜时会把结果写回
   * 自己的 element（破坏性），因此回放不能只换 filters —— 必须先把 element
   * 恢复成同一份「基像素」再重新应用滤镜，否则反复切换会层层叠加滤镜，
   * 画面越切越亮/越糊。
   *
   * @param {fabric.Image} image
   * @returns {object}
   */
  _captureLayerSnapshot(image) {
    const filters = (image.get ? image.get('filters') : image.filters) || [];
    return {
      base: image.getElement ? image.getElement() : image._element,
      // 只浅拷贝数组、保留 filter 实例：fabric 的滤镜实例带 toObject()，
      // 用 object.clone 会克隆成普通对象，回放后 canvas.toJSON() 序列化
      // 滤镜会失败（历史记录因此整条丢失）。滤镜实例只作为配置载体被读取，
      // 数组浅拷贝即可隔离「谁持有这份列表」。
      filters: filters.slice(),
      angle: image.angle || 0,
      flipX: !!image.flipX,
      flipY: !!image.flipY,
      opacity: typeof image.opacity === 'number' ? image.opacity : 1
    };
  }

  /**
   * 把快照写回图层（用于查看原图 / 查看更改的来回切换）。
   * 幂等：每次都从快照记下的基像素重新应用滤镜，不做增量叠加。
   * @param {object} snapshot _captureLayerSnapshot 的产物
   */
  _applyLayerSnapshot(snapshot) {
    const target = this._aiReview?.target;
    if (!target || !snapshot) {
      return;
    }
    if (snapshot.base) {
      if (typeof target.setElement === 'function') {
        target.setElement(snapshot.base);
      } else {
        target._element = snapshot.base;
      }
    }
    target.filters = snapshot.filters.slice();
    target.set({
      angle: snapshot.angle,
      flipX: snapshot.flipX,
      flipY: snapshot.flipY,
      opacity: snapshot.opacity
    });
    // 与指令应用同一口径：失效渲染缓存，保证回放立刻可见
    target.dirty = true;
    target.applyFilters?.();
    this.canvasManager.canvas?.requestRenderAll?.();
  }

  /**
   * 查看原图 / 查看更改：按 viewing 目标切换画面并同步确认条按钮文案。
   * @param {'before'|'after'} which
   */
  _showReviewSnapshot(which) {
    if (!this._aiReview) {
      return;
    }
    this._aiReview.viewing = which;
    // 快照对象由 viewing 键取出：before / after 两份状态各自回放
    this._applyLayerSnapshot(this._aiReview[which]);

    const isBefore = which === 'before';
    eventBus.emit('toast:action:update', {
      message: isBefore
        ? '正在查看原图（修改前），点「查看更改」回到 AI 效果'
        : '正在查看 AI 修改后的效果',
      actions: [
        { label: isBefore ? '查看更改' : '查看原图', event: isBefore ? 'ai:review:showAfter' : 'ai:review:showBefore', keepOpen: true },
        { label: '应用', event: 'ai:review:apply', primary: true },
        { label: '撤销', event: 'history:undo' }
      ]
    });
  }

  /**
   * 结束对比查看（应用 / 撤销 / 其它操作默认同意后都会走到这里）。
   */
  _endReview() {
    this._aiReview = null;
    this._refreshPanel();
  }

  /**
   * 是否运行在网页版。
   *
   * 网页版不开放自定义服务商：浏览器直连第三方接口受 CORS 限制（多数
   * OpenAI 兼容服务商不返回 CORS 头，请求会被浏览器直接拦掉），且让用户
   * 在公开网页里粘贴 API Key 有钓鱼/仿冒风险。云端 AI 仅在桌面客户端可用。
   * @returns {boolean}
   */
  _isWebPlatform() {
    const id = String(this._host?.platform?.id || '').toLowerCase();
    return id === 'web';
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
    // 网页版不开放自定义服务商（CORS + Key 安全），面板只给说明。
    if (this._isWebPlatform()) {
      return `
        <div class="property-section-title">AI 修图</div>
        <div class="ai-note ai-note--warn">网页版不支持配置第三方 AI 服务商。</div>
        <div class="ai-note ai-note--muted">浏览器直连第三方接口受跨域限制，且不建议在网页里填写 API Key。请使用 uTools / ZTools 桌面客户端的 AI 编辑功能。</div>
      `;
    }

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
    const chips = listVisiblePromptPresets().map((preset) => `
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
    // 状态判定统一走 getAiConfigStatus()：它区分「没有服务商」「没有模型」
    // 「缺服务地址」「地址不是 https」四种情况。历史上这里只有一个布尔值，
    // 四种情况共用一句「尚未配置服务商」，于是模型下拉里明明有可选项、
    // 面板却坚持说没配置，用户无法知道真正缺的是服务地址。
    const status = getAiConfigStatus();
    const config = getAiConfig();
    const draft = config.draft || '';

    const statusLine = status.ready
      ? `<div class="ai-note ai-note--muted">服务商：${this._escapeHtml(config.model || '')}（仅发送压缩预览图，原图不上传）</div>`
      : `
        <div class="ai-note ai-note--warn ai-note--action">
          <span>${this._escapeHtml(status.message)}</span>
          <button type="button" class="ai-note__btn"
                  data-module-action="${capability.id}:openAiConfig">打开 AI 配置</button>
        </div>
      `;

    // 提示词预设只出现在顶部预设栏（getOptionsBarHTML）。属性面板
    // 不再重复渲染同一批 chips —— 同一批快捷入口放两处，点哪一处都要
    // 重新决策，且会挤占文本输入区的垂直空间。
    // 选中状态行：未选中图层时提示要先选（就地编辑必须有明确的源图层）。
    const targetLine = target
      ? `<div class="ai-note">当前图层：${this._escapeHtml(this._getObjectDisplayName(target))}</div>`
      : '<div class="property-empty">选中图片图层后使用（背景图也可以）</div>';

    // 执行按钮
    const runLabel = this._running ? 'AI 处理中…' : '让 AI 编辑当前图层';

    // 模型选择器：按提供商分组列出全部已配置模型，选中即切换执行目标。
    // 只在「已配置过提供商」时出现；一个模型都没有时由 statusLine 提示去配置。
    const providers = listProviders().filter((provider) => provider.models.length > 0);
    const selection = getActiveSelection();
    const modelSelect = providers.length
      ? `
      <div class="property-item property-item--wide">
        <label>模型</label>
        <select class="property-select" data-module-prop="${capability.id}:model">
          ${providers.map((provider) => `
            <optgroup label="${this._escapeHtml(provider.label || '未命名服务商')}">
              ${provider.models.map((model) => `
                <option value="${provider.id}|${this._escapeHtml(model)}"
                  ${provider.id === selection.providerId && model === selection.model ? 'selected' : ''}>${this._escapeHtml(model)}</option>
              `).join('')}
            </optgroup>
          `).join('')}
        </select>
      </div>
      `
      : '';

    // 执行按钮：一次点击 → 一次结果（就地改当前图层）
    const actionButtons = `
        <button type="button" class="property-btn property-btn--primary"
                data-module-action="${capability.id}:run"${this._running ? ' disabled' : ''}>${runLabel}</button>`;

    return `
      ${modelSelect}
      ${statusLine}
      <div class="property-item property-item--wide">
        <label>提示词</label>
        <textarea class="ai-prompt-box" rows="4"
                  data-module-prop="${capability.id}:draft"
                  placeholder="例如：整体偏冷一点，提高对比度并压暗高光，主体更突出">${this._escapeHtml(draft)}</textarea>
      </div>
      ${targetLine}
      <div class="property-item property-item--wide property-item--actions">
        ${actionButtons}
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
    // 模型切换：值形如 "providerId|modelName"，保存为当前执行目标。
    // 需要刷新面板，让状态行显示新选中的模型。
    if (key === 'model') {
      const [providerId, modelName] = String(value || '').split('|');
      if (providerId && modelName) {
        setActiveSelection(providerId, modelName);
        this._refreshPanel();
      }
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

    // 提示行里的「打开 AI 配置」：直接跳到账户中心的 AI 配置页，
    // 省得用户自己回想「头像 → AI 配置」在哪一层。
    if (verb === 'openAiConfig') {
      eventBus.emit('account:open', { section: 'ai' });
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
    // 与属性面板同源：缺什么就说缺什么，而不是笼统让人「去配置」
    const status = getAiConfigStatus();
    if (!status.ready) {
      eventBus.emit('toast:show', { message: status.message, type: 'error' });
      return;
    }

    // 源图层解析：AI 指令编辑直接作用于显式选中的图片图层。
    const resolved = this._resolveSourceLayer();
    if (!resolved.source) {
      eventBus.emit('toast:show', { message: resolved.note, type: 'error' });
      return;
    }
    const source = resolved.source;
    if (resolved.note) {
      eventBus.emit('toast:show', { message: resolved.note, type: 'info' });
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

      // 「编辑当前图层」直接在源图层上改（不复制、不留第二个图层）。
      // 修改前先抓一张「原图快照」，配合确认条的「查看原图 / 查看更改」
      // 做前后对比；用户不选择而继续其它操作时视为同意修改后的结果。
      let appliedTo = source;
      let beforeSnapshot = null;
      if (background) {
        // 抠图本身就产新图层（3.1 上线）
        appliedTo = await this._runCutoutToLayer(source, background.mode);
      } else {
        // 必须在应用指令之前抓：before = 修改前的调色与变换状态
        beforeSnapshot = this._captureLayerSnapshot(source);
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
      // 带操作名入历史：面板里显示「AI 修图」而不是默认的「编辑」
      this.history?.saveState?.('AI 修图');

      const producedLayer = appliedTo !== source;
      const rejectedNote = instruction.rejected.length
        ? `（${instruction.rejected.length} 条超出可用能力已忽略）`
        : '';
      const summary = `${describeActions(instruction.actions)}${rejectedNote}`;

      if (producedLayer) {
        eventBus.emit('toast:show', { message: `${summary}，已生成为新图层`, type: 'success' });
      } else {
        // 就地修改：进入「应用 / 查看原图 / 撤销」对比确认，不做选择而
        // 进行其它操作视为同意修改后的结果。
        const afterSnapshot = this._captureLayerSnapshot(source);
        // 两份快照必须共用同一基像素：应用滤镜后 fabric 会把结果烘焙进
        // element，若 after 记下的是烘焙后的元素，来回切换就会层层叠加滤镜。
        afterSnapshot.base = beforeSnapshot.base;
        this._aiReview = {
          target: source,
          before: beforeSnapshot,
          after: afterSnapshot,
          viewing: 'after'
        };
        eventBus.emit('toast:action', {
          message: `已修改「${this._getObjectDisplayName(source)}」：${summary}`,
          actions: [
            { label: '查看原图', event: 'ai:review:showBefore', keepOpen: true },
            { label: '应用', event: 'ai:review:apply', primary: true },
            { label: '撤销', event: 'history:undo' }
          ]
        });
      }
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
   * 解析本次 AI 编辑的源图层：必须是显式选中的图片图层——就地编辑改的是
   * 哪一层必须无歧义，不能替用户猜。
   * @returns {{source: fabric.Image|null, note: string}} note 为空表示无需提示
   */
  _resolveSourceLayer() {
    const selected = this._getTargetImage();
    if (selected) {
      return { source: selected, note: '' };
    }
    return { source: null, note: '请先选中要编辑的图片图层' };
  }

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
