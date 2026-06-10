import eventBus from './EventBus.js';

/**
 * 图层管理器 — 管理 Fabric.js 物件的 z-order、显隐、锁定
 * 每个 Fabric Object 即为一个"图层"
 */
class LayerManager {
  constructor(canvasManager) {
    this._cm = canvasManager;
    this._layers = [];           // 图层元数据 [{ id, name, visible, locked, fabricObj }]
    this._idCounter = 0;
  }

  /**
   * 同步图层列表（从画布物件重建）
   */
  syncLayers() {
    const canvas = this._cm.canvas;
    if (!canvas) return;

    const objects = canvas.getObjects();
    const oldLayers = this._layers;   // 保留旧列表用于查找已有元数据
    const newLayers = [];

    // 先处理非背景图层：从后往前（画布中后面的是上层 → 放在面板顶部）
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      // 背景图层单独处理
      if (obj === this._cm.originalImage) continue;

      // 跳过标记为不显示在图层面板的对象（如裁剪遮罩/裁剪框）
      if (obj.excludeFromLayer) continue;

      // 在旧列表中查找已有元数据（按对象引用匹配）
      let meta = oldLayers.find(l => l.fabricObj === obj) || null;
      if (!meta) {
        meta = this._createMeta(obj, false, newLayers);
      }
      meta.zIndex = objects.length - 1 - i;
      newLayers.push(meta);
    }

    // 背景图层始终在列表末尾（面板最底部）
    if (this._cm.originalImage) {
      let bgMeta = oldLayers.find(l => l.fabricObj === this._cm.originalImage) || null;
      if (!bgMeta) {
        bgMeta = this._createMeta(this._cm.originalImage, true, newLayers);
      }
      bgMeta.zIndex = 0;
      newLayers.push(bgMeta);
    }

    this._layers = newLayers;
    eventBus.emit('layers:updated', this._layers);
  }

  /**
   * 获取图层列表
   * @returns {Array}
   */
  getLayers() {
    return this._layers;
  }

  /**
   * 根据 ID 查找图层元数据
   * @param {number} layerId
   * @returns {object|null}
   */
  getLayerById(layerId) {
    return this._layers.find(l => l.id === layerId) || null;
  }

  /**
   * 根据 fabricObj 查找图层元数据
   * @param {fabric.Object} obj
   * @returns {object|null}
   */
  _findMeta(obj) {
    return this._layers.find(l => l.fabricObj === obj) || null;
  }

  /**
   * 根据 Fabric 对象获取图层元数据
   * @param {fabric.Object} obj
   * @returns {object|null}
   */
  getLayerByObject(obj) {
    return this._findMeta(obj);
  }

  _createMeta(obj, isBackground = false, newLayers = null) {
    const id = ++this._idCounter;

    // 按对象功能命名（不是按 Fabric type 字面翻译）
    const funcLabelMap = {
      'image': '马赛克',       // 非背景图片 = 马赛克覆盖层
      'i-text': '文字',
      'textbox': '文字',
      'text': '文字',
      'rect': '矩形',
      'circle': '圆形',
      'path': '涂鸦',
      'group': '组合',
    };
    const funcLabel = funcLabelMap[obj.type] || '图层';

    // 同类图层序号：已在旧列表 + 本批次新创建的 = 当前总计
    // 用 newLayers（本次同步正在构建的列表）计已存在的同类，更准确
    const countSource = newLayers || this._layers;
    const sameTypeCount = countSource.filter(l => l.name.startsWith(funcLabel)).length;
    const name = `${funcLabel}-${sameTypeCount + 1}`;

    return {
      id,
      name: isBackground ? '背景' : name,
      visible: obj.visible !== false,
      locked: isBackground ? true : (!obj.selectable && !obj.evented),
      fabricObj: obj,
      zIndex: 0,
      isBackground,
    };
  }

  /**
   * 切换图层可见性
   * @param {number} layerId
   */
  toggleVisibility(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta) return;

    this.setVisibility(layerId, !meta.visible);
  }

  /**
   * 设置图层可见性
   * @param {number} layerId
   * @param {boolean} visible
   */
  setVisibility(layerId, visible) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta) return;

    meta.visible = !!visible;
    meta.fabricObj.set({ visible: meta.visible });
    this._cm.canvas.renderAll();
    eventBus.emit('layers:updated', this._layers);
    eventBus.emit('layer:visibilityChanged', meta);
  }

  /**
   * 切换图层锁定
   * @param {number} layerId
   */
  toggleLock(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    this.setLock(layerId, !meta.locked);
  }

  /**
   * 设置图层锁定状态
   * @param {number} layerId
   * @param {boolean} locked
   */
  setLock(layerId, locked) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    meta.locked = !!locked;
    meta.fabricObj.set({
      selectable: !meta.locked,
      evented: !meta.locked,
    });
    if (meta.locked && this._cm.canvas.getActiveObject() === meta.fabricObj) {
      this._cm.canvas.discardActiveObject();
    }
    this._cm.canvas.renderAll();
    eventBus.emit('layers:updated', this._layers);
    eventBus.emit('layer:lockChanged', meta);
  }

  /**
   * 选中图层
   * @param {number} layerId
   */
  selectLayer(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.locked) return;

    this._cm.canvas.setActiveObject(meta.fabricObj);
    this._cm.canvas.renderAll();
    eventBus.emit('layer:selected', meta);
  }

  /**
   * 删除图层
   * @param {number} layerId
   */
  deleteLayer(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.locked || meta.isBackground) return;

    this._cm.canvas.remove(meta.fabricObj);
    this._layers = this._layers.filter(l => l.id !== layerId);
    this._cm.canvas.renderAll();
    eventBus.emit('layers:updated', this._layers);
  }

  /**
   * 图层上移
   * @param {number} layerId
   */
  moveUp(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    this._cm.canvas.bringForward(meta.fabricObj);
    this._cm.canvas.renderAll();
    this.syncLayers();
  }

  /**
   * 图层下移
   * @param {number} layerId
   */
  moveDown(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    this._cm.canvas.sendBackwards(meta.fabricObj);
    this._cm.canvas.renderAll();
    this.syncLayers();
  }

  /**
   * 置顶
   * @param {number} layerId
   */
  bringToFront(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    this._cm.canvas.bringToFront(meta.fabricObj);
    this._cm.canvas.renderAll();
    this.syncLayers();
  }

  /**
   * 置底（在原图之上）
   * @param {number} layerId
   */
  sendToBack(layerId) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground) return;

    const objects = this._cm.canvas.getObjects();
    const imgIndex = objects.indexOf(this._cm.originalImage);
    this._cm.canvas.moveTo(meta.fabricObj, imgIndex + 1);
    this._cm.canvas.renderAll();
    this.syncLayers();
  }

  /**
   * 按图层面板位置重排图层（0 = 顶部，背景图层固定在底部）
   * @param {number} layerId
   * @param {number} targetPanelIndex
   * @returns {boolean} 是否发生了重排
   */
  reorderLayer(layerId, targetPanelIndex) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta || meta.isBackground || !this._cm.canvas) return false;

    const overlayLayers = this._layers.filter(l => !l.isBackground);
    const fromIndex = overlayLayers.findIndex(l => l.id === layerId);
    if (fromIndex === -1 || overlayLayers.length < 2) return false;

    let insertIndex = Math.max(0, Math.min(targetPanelIndex, overlayLayers.length));
    if (fromIndex < insertIndex) insertIndex -= 1;
    if (insertIndex === fromIndex) return false;

    const [movedLayer] = overlayLayers.splice(fromIndex, 1);
    overlayLayers.splice(insertIndex, 0, movedLayer);

    eventBus.emit('layer:reorderWillChange', {
      layer: movedLayer,
      fromIndex,
      toIndex: insertIndex,
    });

    this._applyPanelOrder(overlayLayers);
    this._cm.canvas.renderAll();
    this.syncLayers();

    eventBus.emit('layer:reordered', {
      layer: movedLayer,
      fromIndex,
      toIndex: insertIndex,
    });

    return true;
  }

  _applyPanelOrder(overlayLayers) {
    const canvas = this._cm.canvas;
    const objects = canvas.getObjects();
    const backgroundIndex = objects.indexOf(this._cm.originalImage);
    const startIndex = backgroundIndex >= 0 ? backgroundIndex + 1 : 0;
    const bottomToTopLayers = overlayLayers.slice().reverse();

    bottomToTopLayers.forEach((layer, index) => {
      canvas.moveTo(layer.fabricObj, startIndex + index);
    });
  }

  /**
   * 图层重命名
   * @param {number} layerId
   * @param {string} newName
   */
  renameLayer(layerId, newName) {
    const meta = this._layers.find(l => l.id === layerId);
    if (!meta) return;
    meta.name = newName;
    eventBus.emit('layers:updated', this._layers);
  }

  /**
   * 获取图层数量
   * @returns {number}
   */
  getCount() {
    return this._layers.length;
  }
}

export default LayerManager;
