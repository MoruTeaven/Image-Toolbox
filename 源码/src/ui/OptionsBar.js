import eventBus from '../core/EventBus.js';

const THEME_STORAGE_KEY = 'image-toolbox-theme';
const THEME_VERSION_KEY = 'image-toolbox-theme-version';
const THEME_VERSION = 'neutral-teal-light-default-v1';

/**
 * 顶部预设栏 UI 组件
 * 根据当前工具动态渲染快捷预设，右侧放置主题切换按钮
 */
class OptionsBar {
  constructor(containerEl, toolManager) {
    this._el = containerEl;
    this._tm = toolManager;
    this._currentTool = null;

    this._render();
    this._bindEvents();
  }

  _render() {
    this._el.innerHTML = `
      <div class="optionsbar__label hidden" id="optionsbar-label">工具预设</div>
      <div class="optionsbar__controls" id="optionsbar-controls"></div>
      <div class="optionsbar__right">
        <div class="theme-toggle" id="theme-toggle" data-theme="light" title="切换主题">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
          </svg>
          <div class="theme-toggle__knob"></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
          </svg>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    // 工具切换 → 更新选项
    eventBus.on('tool:changed', (toolName) => {
      this._currentTool = toolName;
      this._updateControls();
    });

    // 事件委托：处理控件交互
    this._el.addEventListener('input', (e) => {
      this._handleControlEvent(e);
    });
    this._el.addEventListener('change', (e) => {
      this._handleControlEvent(e);
    });
    this._el.addEventListener('click', (e) => {
      this._handleControlEvent(e);
    });

    // 主题切换
    const themeToggle = this._el.querySelector('#theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        themeToggle.setAttribute('data-theme', next);
        localStorage.setItem(THEME_STORAGE_KEY, next);
        localStorage.setItem(THEME_VERSION_KEY, THEME_VERSION);
      });

      // 初始化主题状态
      const savedVersion = localStorage.getItem(THEME_VERSION_KEY);
      let savedTheme = localStorage.getItem(THEME_STORAGE_KEY);

      if (savedVersion !== THEME_VERSION) {
        savedTheme = 'light';
        localStorage.setItem(THEME_STORAGE_KEY, savedTheme);
        localStorage.setItem(THEME_VERSION_KEY, THEME_VERSION);
      } else if (savedTheme !== 'light' && savedTheme !== 'dark') {
        savedTheme = 'light';
      }

      document.documentElement.setAttribute('data-theme', savedTheme);
      themeToggle.setAttribute('data-theme', savedTheme);
    }
  }

  _updateControls() {
    const controlsEl = this._el.querySelector('#optionsbar-controls');
    const labelEl = this._el.querySelector('#optionsbar-label');
    if (!controlsEl) return;

    const module = this._tm.getCurrentModule();
    if (module && typeof module.getOptionsBarHTML === 'function') {
      controlsEl.innerHTML = module.getOptionsBarHTML();
      labelEl?.classList.toggle('hidden', !controlsEl.innerHTML.trim());
    } else {
      controlsEl.innerHTML = '';
      labelEl?.classList.add('hidden');
    }
  }

  _handleControlEvent(e) {
    const target = e.target;
    const module = this._tm.getCurrentModule();
    if (!module) return;

    // 绘制模式切换（框选/画笔）
    if (target.dataset.drawMode) {
      const mode = target.dataset.drawMode;
      if (module.setDrawMode) module.setDrawMode(mode);
      this._updateControls();
      return;
    }

    // 打码效果切换（仅 change 事件，避免 click 触发 _updateControls 导致下拉框被销毁）
    if (target.id === 'mosaic-mode' && e.type === 'change') {
      const mode = target.value;
      if (module.setMode) module.setMode(mode);
      this._updateControls();
      eventBus.emit('mosaic:modeChanged', mode);
      return;
    }

    // 马赛克块大小滑块
    if (target.id === 'mosaic-size') {
      const value = parseInt(target.value);
      const valueSpan = document.getElementById('mosaic-size-value');
      if (valueSpan) valueSpan.textContent = value + 'px';
      if (module.setMosaicSize) module.setMosaicSize(value);
    }

    // 模糊半径滑块
    if (target.id === 'blur-radius') {
      const value = parseInt(target.value);
      const valueSpan = document.getElementById('blur-radius-value');
      if (valueSpan) valueSpan.textContent = value + 'px';
      if (module.setBlurRadius) module.setBlurRadius(value);
    }

    // 画笔大小滑块
    if (target.id === 'brush-size') {
      const value = parseInt(target.value);
      const valueSpan = document.getElementById('brush-size-value');
      if (valueSpan) valueSpan.textContent = value + 'px';
      if (module.setBrushSize) module.setBrushSize(value);
    }

    // 文字颜色
    if (target.id === 'text-color') {
      if (module.setTextColor) module.setTextColor(target.value);
    }

    // 字体（仅 change 事件，避免 click 触发 _updateControls 导致下拉框被销毁）
    if (target.id === 'text-font-family' && e.type === 'change') {
      if (module.setFontFamily) module.setFontFamily(target.value);
    }

    // 字号（仅 change 事件）
    if (target.id === 'text-font-size' && e.type === 'change') {
      if (module.setFontSize) module.setFontSize(parseInt(target.value));
    }

    // 文字样式按钮
    if (target.id === 'text-bold') {
      target.classList.toggle('active');
      const bold = target.classList.contains('active');
      if (module.setFontWeight) module.setFontWeight(bold ? 'bold' : 'normal');
    }
    if (target.id === 'text-italic') {
      target.classList.toggle('active');
      const italic = target.classList.contains('active');
      if (module.setFontStyle) module.setFontStyle(italic ? 'italic' : 'normal');
    }
    if (target.id === 'text-underline') {
      target.classList.toggle('active');
      const underline = target.classList.contains('active');
      if (module.setUnderline) module.setUnderline(underline);
    }

    // 文字预设样式
    if (target.dataset.preset) {
      if (module.applyPreset) module.applyPreset(target.dataset.preset);
    }

    // 裁剪比例按钮
    if (target.dataset.ratio) {
      const ratioStr = target.dataset.ratio;
      // 高亮当前按钮
      const btnGroup = target.parentElement;
      if (btnGroup) {
        btnGroup.querySelectorAll('.options-btn').forEach(b => b.classList.remove('active'));
      }
      target.classList.add('active');

      let ratio = null;
      if (ratioStr !== 'free') {
        const [w, h] = ratioStr.split(':').map(Number);
        ratio = { w, h };
      }
      if (module.setAspectRatio) module.setAspectRatio(ratio);
    }

    // 裁剪应用/取消
    if (target.id === 'crop-apply') {
      if (module.applyCrop) module.applyCrop();
    }
    if (target.id === 'crop-cancel') {
      if (module.cancelCrop) module.cancelCrop();
    }
  }

  /**
   * 销毁选项栏
   */
  destroy() {
    // 清理事件监听（通过 eventBus）
  }
}

export default OptionsBar;
