import BaseModule from './BaseModule.js';
import eventBus from '../EventBus.js';
import { requestRender as _requestRender } from '../utils/helpers.js';
import { FILTER_PRESETS, applyFilterPreset, isPresetActive } from '../utils/filters.js';

/**
 * 移动/框选模块 - 保持 Fabric 默认选择行为，并提供常用变换预设。
 */
class SelectModule extends BaseModule {
  activate(options = {}) {
    this.active = true;
    this.options = { ...this.options, ...options };

    const canvas = this.canvasManager.canvas;
    if (!canvas) return;

    canvas.selection = true;
    canvas.defaultCursor = 'default';

    // 恢复所有对象的交互性，确保属性面板可以编辑（而非只读）
    this._restoreObjectsInteractivity();
  }

  deactivate() {
    this.active = false;
  }

  getOptionsBarHTML() {
    const targets = this._getTransformTargets();
    const disabled = targets.length === 0 ? ' disabled title="先选中一个图层"' : '';
    const angle = this._getCommonAngle(targets);
    const flipX = targets.length > 0 && targets.every(obj => !!obj.flipX);
    const flipY = targets.length > 0 && targets.every(obj => !!obj.flipY);

    // 滤镜预设仅对单一图片图层生效
    const imageTarget = this._getSingleImageTarget();
    const filterDisabled = imageTarget ? '' : ' disabled title="选中一个图片图层以应用滤镜"';
    const filterButtons = FILTER_PRESETS.map(preset => {
      const active = imageTarget && isPresetActive(imageTarget, preset.preset);
      return `
        <button class="options-btn options-btn-sm filter-preset-btn ${active ? 'active' : ''}" data-preset="${preset.preset}"${filterDisabled}>${preset.label}</button>
      `;
    }).join('');

    return `
      <div class="options-group">
        <button class="options-btn options-btn-sm ${angle === 0 ? 'active' : ''}" data-preset="select-rotate-0"${disabled}>旋转0°</button>
        <button class="options-btn options-btn-sm ${angle === 90 ? 'active' : ''}" data-preset="select-rotate-90"${disabled}>旋转90</button>
        <button class="options-btn options-btn-sm ${angle === 180 ? 'active' : ''}" data-preset="select-rotate-180"${disabled}>旋转180</button>
        <button class="options-btn options-btn-sm ${angle === 270 ? 'active' : ''}" data-preset="select-rotate-270"${disabled}>旋转270</button>
      </div>
      <div class="options-group">
        <button class="options-btn options-btn-sm ${flipX ? 'active' : ''}" data-preset="select-flip-x"${disabled}>左右翻转</button>
        <button class="options-btn options-btn-sm ${flipY ? 'active' : ''}" data-preset="select-flip-y"${disabled}>前后翻转</button>
      </div>
      <div class="options-group">
        ${filterButtons}
      </div>
    `;
  }

  applyPreset(presetName) {
    // 滤镜预设：仅作用于单一图片图层
    if (presetName && presetName.startsWith('filter-')) {
      const imageTarget = this._getSingleImageTarget();
      if (!imageTarget) return;
      this.history.saveState();
      applyFilterPreset(imageTarget, presetName);
      imageTarget.dirty = true;
      imageTarget.setCoords();
      this._requestRender();
      eventBus.emit('canvas:objectModified', imageTarget);
      return;
    }

    const targets = this._getTransformTargets();
    if (targets.length === 0) return;

    const rotateMap = {
      'select-rotate-0': 0,
      'select-rotate-90': 90,
      'select-rotate-180': 180,
      'select-rotate-270': 270,
    };

    if (Object.prototype.hasOwnProperty.call(rotateMap, presetName)) {
      this._rotateTargets(targets, rotateMap[presetName]);
      return;
    }

    if (presetName === 'select-flip-x') {
      this._flipTargets(targets, 'flipX');
      return;
    }

    if (presetName === 'select-flip-y') {
      this._flipTargets(targets, 'flipY');
    }
  }

  _rotateTargets(targets, angle) {
    const nextAngle = this._normalizeAngle(angle);
    const changed = targets.some(obj => this._normalizeAngle(obj.angle || 0) !== nextAngle);
    if (!changed) return;

    this.history.saveState();
    targets.forEach(obj => this._setObjectTransform(obj, { angle: nextAngle }));
    this._refreshActiveSelection(targets);
    this._refreshDynamicMosaics();
    this._requestRender();
  }

  _flipTargets(targets, prop) {
    this.history.saveState();
    targets.forEach(obj => this._setObjectTransform(obj, { [prop]: !obj[prop] }));
    this._refreshActiveSelection(targets);
    this._refreshDynamicMosaics();
    this._requestRender();
  }

  _setObjectTransform(obj, props) {
    const center = typeof obj.getCenterPoint === 'function' ? obj.getCenterPoint() : null;
    obj.set(props);

    if (center && typeof obj.setPositionByOrigin === 'function') {
      obj.setPositionByOrigin(center, 'center', 'center');
    }

    obj.dirty = true;
    obj.setCoords();
  }

  _refreshActiveSelection(targets) {
    const canvas = this.canvasManager.canvas;
    const active = canvas?.getActiveObject();
    if (!canvas || active?.type !== 'activeSelection' || targets.length < 2) return;
    if (typeof fabric === 'undefined' || !fabric.ActiveSelection) return;

    canvas.discardActiveObject();
    const selection = new fabric.ActiveSelection(targets, { canvas });
    canvas.setActiveObject(selection);
  }

  _refreshDynamicMosaics() {
    this.canvasManager.refreshDynamicMosaics?.({ render: false });
  }

  _getTransformTargets() {
    const canvas = this.canvasManager.canvas;
    const active = canvas?.getActiveObject();
    if (!active) return [];

    // 背景图不可变换（旋转/翻转），排除之
    const originalImage = this.canvasManager.originalImage;

    if (active.type === 'activeSelection' && typeof active.getObjects === 'function') {
      return active.getObjects().filter(obj => !obj.excludeFromHistory && obj !== originalImage);
    }

    if (active.excludeFromHistory || active === originalImage) return [];
    return [active];
  }

  /**
   * 获取当前选中的单一图片图层（用于滤镜预设）
   * 多选或非图片类型返回 null。
   * 注意：此方法独立于 _getTransformTargets，背景图虽不可变换但可应用滤镜。
   * @returns {fabric.Image|null}
   */
  _getSingleImageTarget() {
    const canvas = this.canvasManager.canvas;
    const active = canvas?.getActiveObject();
    if (!active || active.type === 'activeSelection') return null;
    return active.type === 'image' ? active : null;
  }

  _getCommonAngle(targets) {
    if (targets.length === 0) return null;

    const first = this._normalizeAngle(targets[0].angle || 0);
    return targets.every(obj => this._normalizeAngle(obj.angle || 0) === first) ? first : null;
  }

  _normalizeAngle(angle) {
    const number = parseFloat(angle) || 0;
    return ((Math.round(number) % 360) + 360) % 360;
  }

  _requestRender() {
    _requestRender(this.canvasManager.canvas);
  }
}

export default SelectModule;
