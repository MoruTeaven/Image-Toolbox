import { eventBus } from '../../../../core/src/index.js';
import { FILTER_RANGES, getFilterUiValue, setFilter, clearFilters } from '../../../../core/src/utils/filters.js';

/**
 * 调色面板 — 侧栏「调色」Tab
 * 选中图片图层时显示亮度/对比度/饱和度/色相/模糊滑块与重置按钮。
 * 非图片图层或未选中时显示提示文本。
 */
class ColorPanel {
  constructor(containerEl, canvasManager) {
    this._el = containerEl;
    this._cm = canvasManager;
    this._eventBusUnsubscribers = [];

    this._render();
    this._bindEvents();
  }

  _render() {
    this._el.innerHTML = `
      <div class="panel panel--color">
        <div class="panel__body" id="color-panel-body">
          <div class="property-empty">选中图片图层以调色</div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    this._eventBusUnsubscribers.push(
      eventBus.on('canvas:selectionCreated', () => this._update()),
      eventBus.on('canvas:selectionUpdated', () => this._update()),
      eventBus.on('canvas:selectionCleared', () => this._update()),
      eventBus.on('layer:selected', () => this._update()),
      eventBus.on('canvas:objectModified', () => this._update()),
      eventBus.on('canvas:restored', () => this._update()),
      eventBus.on('image:loaded', () => this._clearHint())
    );

    this._el.addEventListener('input', (e) => this._handleEvent(e));
    this._el.addEventListener('change', (e) => this._handleEvent(e));
    this._el.addEventListener('click', (e) => this._handleEvent(e));
  }

  _update() {
    const bodyEl = this._el.querySelector('#color-panel-body');
    if (!bodyEl) return;

    const active = this._getActiveObject();
    if (active && active.type === 'image') {
      bodyEl.innerHTML = this._getColorAdjustHTML(active);
    } else {
      bodyEl.innerHTML = '<div class="property-empty">选中图片图层以调色</div>';
    }
  }

  _clearHint() {
    const bodyEl = this._el.querySelector('#color-panel-body');
    if (bodyEl) {
      bodyEl.innerHTML = '<div class="property-empty">选中图片图层以调色</div>';
    }
  }

  _getColorAdjustHTML(active) {
    const items = [
      { type: 'brightness', label: '亮度' },
      { type: 'contrast',  label: '对比' },
      { type: 'saturation',label: '饱和' },
      { type: 'hue',       label: '色相' },
      { type: 'blur',      label: '模糊' },
    ];

    const sliders = items.map(({ type, label }) => {
      const range = FILTER_RANGES[type];
      const value = getFilterUiValue(active, type);
      return `
        <div class="property-item property-item--wide">
          <label>${label}</label>
          <input type="range" class="property-range" data-prop="filter:${type}"
                 min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" />
          <span class="property-value">${value}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="property-section-title">调色</div>
      ${sliders}
      <div class="property-item property-item--wide property-item--actions">
        <button type="button" class="property-btn" data-prop="filter:reset">重置调色</button>
      </div>
    `;
  }

  _handleEvent(e) {
    const target = e.target.closest('[data-prop]');
    if (!target || !this._el.contains(target)) return;

    const prop = target.dataset.prop;
    if (!prop || !prop.startsWith('filter:')) return;

    const active = this._getActiveObject();
    if (!active) return;

    const value = target.value;

    // 重置按钮
    if (prop === 'filter:reset') {
      if (e.type !== 'click') return;
      clearFilters(active);
      active.dirty = true;
      active.setCoords();
      this._requestRender();
      this._notifyObjectChanged(active);
      this._update();
      return;
    }

    // 滑块
    const type = prop.slice('filter:'.length);
    const uiValue = parseInt(value, 10);
    if (!Number.isFinite(uiValue)) return;

    setFilter(active, type, uiValue);
    active.dirty = true;
    active.setCoords();

    if (target.nextElementSibling && target.nextElementSibling.classList.contains('property-value')) {
      target.nextElementSibling.textContent = String(uiValue);
    }

    this._requestRender();

    if (e.type === 'change') {
      this._notifyObjectChanged(active);
    }
  }

  _getActiveObject() {
    return this._cm?.getActiveObject?.() || null;
  }

  _notifyObjectChanged(active) {
    eventBus.emit('canvas:objectModified', active);
  }

  _requestRender() {
    const canvas = this._cm?.canvas;
    if (!canvas) return;
    if (typeof canvas.requestRenderAll === 'function') {
      canvas.requestRenderAll();
    } else {
      canvas.renderAll();
    }
  }

  destroy() {
    this._eventBusUnsubscribers.forEach(unsub => unsub());
    this._eventBusUnsubscribers = [];
  }
}

export default ColorPanel;