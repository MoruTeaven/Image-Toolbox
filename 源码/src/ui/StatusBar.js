import eventBus from '../core/EventBus.js';

/**
 * 状态栏 UI 组件
 * 显示图片尺寸、图层数量、引擎版本，提供导出/剪贴板快捷按钮
 */
class StatusBar {
  constructor(containerEl, canvasManager, layerManager) {
    this._el = containerEl;
    this._cm = canvasManager;
    this._lm = layerManager;

    this._bindEvents();
    this._render();
  }

  _render() {
    this._el.innerHTML = `
      <div class="statusbar__left">
        <span class="statusbar__item" id="status-size">-- × --</span>
        <span class="statusbar__separator"></span>
        <span class="statusbar__item" id="status-layers">图层: 0</span>
        <span class="statusbar__separator"></span>
        <span class="statusbar__item">Fabric.js 5.x</span>
      </div>
      <div class="statusbar__right">
        <button class="statusbar__btn statusbar__btn--primary" id="status-save-file">保存到电脑</button>
        <button class="statusbar__btn" id="status-clipboard">复制到剪贴板</button>
      </div>
    `;
  }

  _bindEvents() {
    // 图片加载 → 更新尺寸
    eventBus.on('image:loaded', (img) => {
      this._updateSize(img);
    });

    // 画布变化 → 更新尺寸
    eventBus.on('canvas:objectModified', () => {
      if (this._cm.originalImage) {
        this._updateSize(this._cm.originalImage);
      }
    });

    // 图层变化 → 更新图层数
    eventBus.on('layers:updated', (layers) => {
      const countEl = this._el.querySelector('#status-layers');
      if (countEl) {
        countEl.textContent = `图层: ${layers ? layers.length : this._lm.getCount()}`;
      }
    });

    // 导出按钮
    this._el.addEventListener('click', (e) => {
      if (e.target.id === 'status-save-file') {
        eventBus.emit('export:requested', 'file');
      } else if (e.target.id === 'status-clipboard') {
        eventBus.emit('export:requested', 'clipboard');
      }
    });
  }

  _updateSize(img) {
    const sizeEl = this._el.querySelector('#status-size');
    if (sizeEl && img) {
      const w = Math.round(img.width * img.scaleX);
      const h = Math.round(img.height * img.scaleY);
      sizeEl.textContent = `${w} × ${h} px`;
    }
  }
}

export default StatusBar;
