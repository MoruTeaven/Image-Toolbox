import eventBus from '../core/EventBus.js';

/**
 * 顶部预设栏 UI 组件
 * 根据当前工具动态渲染快捷预设
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
      <div class="optionsbar__controls" id="optionsbar-controls"></div>
    `;
  }

  _bindEvents() {
    // 工具切换 → 更新选项
    eventBus.on('tool:changed', (toolName) => {
      this._currentTool = toolName;
      this._updateControls();
    });

    // 预设栏只处理一键预设，不承载细调参数
    this._el.addEventListener('click', (e) => {
      this._handleControlEvent(e);
    });
  }

  _updateControls() {
    const controlsEl = this._el.querySelector('#optionsbar-controls');
    if (!controlsEl) return;

    const module = this._tm.getCurrentModule();
    if (module && typeof module.getOptionsBarHTML === 'function') {
      controlsEl.innerHTML = module.getOptionsBarHTML();
    } else {
      controlsEl.innerHTML = '';
    }
  }

  _handleControlEvent(e) {
    const target = e.target.closest('[data-preset]');
    if (!target) return;

    const module = this._tm.getCurrentModule();
    if (!module) return;

    if (module.applyPreset) module.applyPreset(target.dataset.preset);
    this._updateControls();
    eventBus.emit('tool:propertiesChanged');
  }

  /**
   * 销毁选项栏
   */
  destroy() {
    // 清理事件监听（通过 eventBus）
  }
}

export default OptionsBar;
