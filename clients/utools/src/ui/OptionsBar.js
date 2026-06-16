import eventBus from '../../../../core/src/EventBus.js';

/**
 * Top options bar UI component.
 * Renders presets for the active tool.
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
    // Update options when the active tool changes.
    eventBus.on('tool:changed', (toolName) => {
      this._currentTool = toolName;
      this._updateControls();
    });

    [
      'canvas:selectionCreated',
      'canvas:selectionUpdated',
      'canvas:selectionCleared',
      'canvas:objectModified',
      'canvas:restored',
      'image:loaded',
    ].forEach(eventName => {
      eventBus.on(eventName, () => {
        if (this._currentTool) this._updateControls();
      });
    });

    // Only handle one-click presets here; detailed controls live in the property panel.
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
   * Destroy the options bar.
   */
  destroy() {
    // EventBus subscriptions are currently app-lifetime listeners.
  }
}

export default OptionsBar;
