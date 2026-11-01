import eventBus from './EventBus.js';
import { CANVAS_DEFAULTS } from './utils/constants.js';
import { getDomPort } from './ports/DomPort.js';
import { installIntensityFilters } from './utils/filters.js';

/**
 * 画布管理器 — 封装 Fabric.js 画布的创建、配置和基础操作
 */
class CanvasManager {
  constructor(canvasElId) {
    this._canvasElId = canvasElId;
    this.canvas = null;
    this.originalImage = null;  // 原始 fabric.Image
    this.zoomLevel = 1;
    this._historySaveTimer = null;
    this._isCropMode = false;
    this._resizeObserver = null;
    this._boundResize = null;
    this._canvasListeners = [];
  }

  // ── 生命周期 ──

  /**
   * 初始化画布
   * @param {object} [options] - Fabric.Canvas 配置
   */
  init(options = {}) {
    const el = getDomPort()?.getElementById?.(this._canvasElId);
    if (!el) {
      throw new Error(`[CanvasManager] 找不到画布元素 #${this._canvasElId}`);
    }

    const config = {
      width: CANVAS_DEFAULTS.WIDTH,
      height: CANVAS_DEFAULTS.HEIGHT,
      backgroundColor: CANVAS_DEFAULTS.BACKGROUND_COLOR,
      preserveObjectStacking: CANVAS_DEFAULTS.PRESERVE_OBJECT_STACKING,
      selection: CANVAS_DEFAULTS.SELECTION,
      stopContextMenu: CANVAS_DEFAULTS.STOP_CONTEXT_MENU,
      fireRightClick: CANVAS_DEFAULTS.FIRE_RIGHT_CLICK,
      ...options,
    };
    this.canvas = new fabric.Canvas(this._canvasElId, config);
    this._bindEvents();
    this._updateCanvasSize();
    eventBus.emit('canvas:initialized', this.canvas);
  }

  /**
   * 销毁画布，释放内存
   */
  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._boundResize) {
      getDomPort()?.offWindow?.('resize', this._boundResize);
      this._boundResize = null;
    }
    if (this._historySaveTimer) {
      clearTimeout(this._historySaveTimer);
      this._historySaveTimer = null;
    }
    if (this.canvas) {
      // 先逐个解绑画布监听再 dispose()。
      // 这些回调都通过闭包引用 this，仅在 dispose() 时清空内部监听表的话，
      // 销毁后残留的回调仍会继续 emit 到全局 EventBus（旧画布被写入历史等）。
      this._canvasListeners.forEach(({ event, handler }) => {
        this.canvas.off(event, handler);
      });
      this._canvasListeners = [];

      this.canvas.dispose();
      this.canvas = null;
    } else {
      this._canvasListeners = [];
    }
    this.originalImage = null;
  }

  // ── 图片操作 ──

  /**
   * 加载图片到画布
   * @param {string|File} source - URL / DataURL / File 对象
   * @returns {Promise<fabric.Image>}
   */
    loadImage(source) {
    return new Promise((resolve, reject) => {
      if (!this.canvas) {
        reject(new Error('画布未初始化'));
        return;
      }

      // 超时保护：防止 fabric.Image.fromURL 永远不回调
      const timeout = setTimeout(() => {
        reject(new Error('图片加载超时（15s），可能是格式不支持或文件过大'));
      }, 15000);

      /**
       * fabric.Image.fromURL 回调签名: function(fabricImage, isError)
       * crossOrigin 是第 4 个参数，不是 imgOptions 的一部分
       */
      const onLoad = (fabricImg, isError) => {
        clearTimeout(timeout);

        if (isError || !fabricImg) {
          const err = new Error('图片加载失败：格式不支持或文件已损坏');
          console.error('[CanvasManager]', err.message);
          eventBus.emit('image:loadError', err);
          reject(err);
          return;
        }

        console.log('[CanvasManager] 图片加载成功: %d×%d (type=%s)',
          fabricImg.width, fabricImg.height, fabricImg.type);

        this.originalImage = fabricImg;
        this._applyBackgroundImageProps(fabricImg);
        this.canvas.clear();
        this.canvas.add(fabricImg);
        this.canvas.renderAll();
        this._updateCanvasSize();
        eventBus.emit('image:loaded', fabricImg);
        resolve(fabricImg);
      };

      if (source instanceof File) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataURL = e.target.result;
          // fromURL(url, callback, imgOptions, crossOrigin)
          fabric.Image.fromURL(dataURL, onLoad, undefined, 'anonymous');
        };
        reader.onerror = (err) => {
          clearTimeout(timeout);
          console.error('[CanvasManager] FileReader 读取失败:', err);
          eventBus.emit('image:loadError', err);
          reject(err);
        };
        reader.readAsDataURL(source);
      } else if (typeof source === 'string') {
        // 数据URL 不需要 crossOrigin
        const needCrossOrigin = !source.startsWith('data:');
        fabric.Image.fromURL(
          source,
          onLoad,
          undefined,                               // imgOptions
          needCrossOrigin ? 'anonymous' : undefined // crossOrigin
        );
      } else {
        reject(new Error('不支持的图片源类型'));
      }
    });
  }

  /**
   * 替换当前图片（不清除覆盖层）
   * @param {string} source
   */
  replaceImage(source) {
    return new Promise((resolve, reject) => {
      fabric.Image.fromURL(source, (fabricImg, isError) => {
        if (isError || !fabricImg) {
          reject(new Error('替换图片失败'));
          return;
        }
        if (this.originalImage) {
          const index = this.canvas.getObjects().indexOf(this.originalImage);
          this.canvas.remove(this.originalImage);
          this.originalImage = fabricImg;
          this._applyBackgroundImageProps(fabricImg);
          this.canvas.insertAt(fabricImg, index >= 0 ? index : 0);
        } else {
          this.originalImage = fabricImg;
          this._applyBackgroundImageProps(fabricImg);
          this.canvas.insertAt(fabricImg, 0);
        }
        this.canvas.renderAll();
        resolve(fabricImg);
      }, undefined, 'anonymous');
    });
  }

  /**
   * 给作为背景的 fabric.Image 设置通用属性：
   * - 标记为 _originalImage（序列化/恢复时识别）
   * - 允许选中/接收事件（用于图层面板和调色工具定位背景图层）
   * - 显示变换控制点，允许像普通图层一样拖拽移动、缩放、旋转
   * @param {fabric.Image} fabricImg
   */
  _applyBackgroundImageProps(fabricImg) {
    fabricImg._originalImage = true;
    fabricImg.set({
      selectable: true,
      evented: true,
      hasControls: true,
      hasBorders: true,
      lockMovementX: false,
      lockMovementY: false,
      lockRotation: false,
      lockScalingX: false,
      lockScalingY: false,
    });
    fabricImg.setCoords();
  }

  /**
   * 获取画布当前图片 DataURL
   * @param {object} [options] - 导出选项
   * @returns {string}
   */
  getImageData(options = {}) {
    const opts = {
      format: 'png',
      multiplier: 1,
      ...options,
    };
    this.refreshDynamicMosaics?.({ render: true });
    return this.canvas.toDataURL(opts);
  }

  /**
   * 图片自适应画布大小
   * @param {number} [padding=40] - 边距
   */
  fitToCanvas(padding = 40) {
    if (!this.originalImage) return;

    const img = this.originalImage;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const availableW = cw - padding * 2;
    const availableH = ch - padding * 2;

    const scale = Math.min(availableW / img.width, availableH / img.height, 1);
    img.set({
      scaleX: scale,
      scaleY: scale,
      left: (cw - img.width * scale) / 2,
      top: (ch - img.height * scale) / 2,
    });
    img.setCoords();
    this.canvas.renderAll();
  }

  // ── 画布控制 ──

  /**
   * 设置缩放
   * @param {number} level - 缩放级别(0.1~5)
   * @param {{x:number,y:number}} [point] - 缩放中心点
   */
  setZoom(level, point) {
    this.zoomLevel = Math.max(0.1, Math.min(5, level));
    const zoomPoint = point || new fabric.Point(
      this.canvas.width / 2,
      this.canvas.height / 2
    );
    this.canvas.zoomToPoint(zoomPoint, this.zoomLevel);
    eventBus.emit('canvas:zoomChanged', this.zoomLevel);
  }

  zoomIn(step = 0.1, point) {
    this.setZoom(this.zoomLevel + step, point);
  }

  zoomOut(step = 0.1, point) {
    this.setZoom(this.zoomLevel - step, point);
  }

  resetZoom() {
    this.setZoom(1);
  }

  // ── 物件管理 ──

  addObject(obj) {
    if (!this.canvas) return;
    this.canvas.add(obj);
    this.canvas.setActiveObject(obj);
    this.canvas.renderAll();
    eventBus.emit('canvas:objectAdded', obj);
  }

  removeObject(obj) {
    if (!this.canvas) return;
    this.canvas.remove(obj);
    this.canvas.discardActiveObject();
    this.canvas.renderAll();
    eventBus.emit('canvas:objectRemoved', obj);
  }

  removeActiveObject() {
    const active = this.canvas.getActiveObject();
    if (active) {
      this.removeObject(active);
    }
  }

  getActiveObject() {
    return this.canvas ? this.canvas.getActiveObject() : null;
  }

  /**
   * 清除所有覆盖层（保留原图）
   */
  clearOverlays() {
    if (!this.canvas) return;
    const objects = this.canvas.getObjects().filter(obj => obj !== this.originalImage);
    objects.forEach(obj => this.canvas.remove(obj));
    this.canvas.renderAll();
    eventBus.emit('canvas:overlaysCleared');
  }

  /**
   * 获取画布上的所有物件（不含原图）
   * @returns {fabric.Object[]}
   */
  getOverlays() {
    if (!this.canvas) return [];
    return this.canvas.getObjects().filter(obj => obj !== this.originalImage);
  }

  // ── 序列化 ──

  toJSON() {
    if (!this.canvas) return null;

    // 临时移出 excludeFromHistory 的辅助对象（画笔光标预览、马赛克选区框等），
    // 避免它们被序列化进历史快照；序列化完成后立即按原下标放回，保持对象顺序不变。
    const canvas = this.canvas;
    const removed = [];
    const objects = canvas._objects;
    for (let i = objects.length - 1; i >= 0; i--) {
      if (objects[i].excludeFromHistory) {
        removed.push({ index: i, obj: objects.splice(i, 1)[0] });
      }
    }

    let json = null;
    try {
      // toJSON(props) 的 props 是**浅赋值**（fabric 的 populateWithProperties 里
      // `e[prop] = this[prop]`），把活对象属性的名字列进去只会让快照持有引用：
      // 历史栈会与画布共享同一个 clipPath 实例，后续任何修改都会污染已入栈的快照。
      // 因此这里**不要**列 'clipPath'（画布级同理）——Fabric 自己会序列化它们。
      json = canvas.toJSON([
        'filters',
        'id',
        'selectable',
        'evented',
        'hasControls',
        'hasBorders',
        'lockMovementX',
        'lockMovementY',
        'lockRotation',
        'lockScalingX',
        'lockScalingY',
        'absolutePositioned',
        'inverted',
        'objectCaching',
        'strokeLineCap',
        'strokeLineJoin',
        '_strokePosition',
        '_layerName',
        '_layerNameAuto',
        '_layerBaseName',
        '_layerKind',
        '_layerShapeType',
        '_layerColorPresetName',
        '_layerWidthPresetName',
        '_layerPresetName',
        '_layerLocked',
        '_mosaicDynamic',
        '_mosaicMode',
        '_mosaicSize',
        '_mosaicBlurRadius',
        '_mosaicWidth',
        '_mosaicHeight',
        '_mosaicMaskType',
        '_mosaicBrushPoints',
        '_mosaicBrushSize',
        '_mosaicLassoPoints',
        '_originalImage'
      ]);
      // 注意：**不要**在这里手写 json._canvasClipPath。Fabric 5.3.0 的
      // _toObjectMethod 原生就会把画布级 clipPath 写进 json.clipPath：
      //   var i = this.clipPath, r = { version: fabric.version, objects: ... };
      //   return i && !i.excludeFromExport && (r.clipPath = this._toObject(this.clipPath, t, e)), ...
      // loadFromJSON 也会自行读取该字段并 delete 后恢复它（`n.clipPath = t[0]`）。
      // 再手写一份只是多一个互相打架的来源：撤销裁切时 Fabric 刚恢复的 clipPath
      // 会被这份冗余数据覆盖成旧值或 null。
    } finally {
      // 按原下标升序插回，保证对象顺序与序列化前完全一致
      removed.sort((a, b) => a.index - b.index);
      for (const { index, obj } of removed) {
        objects.splice(Math.min(index, objects.length), 0, obj);
      }
    }
    return json;
  }

  fromJSON(json) {
    return new Promise((resolve, reject) => {
      if (!this.canvas) {
        reject(new Error('画布未初始化'));
        return;
      }

      // 快照里的滤镜由 fabric 按 type 取构造器重建：棕褐/灰度是自定义强度滤镜，
      // 必须在 loadFromJSON 之前装好，否则历史/工程里的 Sepia / Grayscale
      // 会被反序列化成没有强度属性的原生滤镜
      installIntensityFilters();

      // Fabric 原生已把 json.clipPath 序列化进快照，loadFromJSON 会自行恢复并
      // delete 掉它。这里只处理一种情况：两个来源都没有裁剪信息（原生 json.clipPath
      // 与旧快照遗留的 _canvasClipPath）时，才需要把画布上已有的裁剪清掉——
      // 否则那一步会把 Fabric 刚恢复的 clipPath 抹成 null，撤销裁切后状态错乱。
      const legacyCanvasClipPathData = json._canvasClipPath;
      const hasNativeClipPath = Object.prototype.hasOwnProperty.call(json, 'clipPath');
      const snapshot = { ...json };
      delete snapshot._canvasClipPath;

      this.canvas.loadFromJSON(snapshot, () => {
        const finishRestore = () => {
          // 恢复 originalImage 引用
          const objs = this.canvas.getObjects();
          this.originalImage = objs.find(o => o.type === 'image' && o._originalImage) || objs[0];
          if (this.originalImage?.type === 'image') {
            this._applyBackgroundImageProps(this.originalImage);
          }
          this.canvas.renderAll();
          eventBus.emit('canvas:restored');
          resolve();
        };

        if (legacyCanvasClipPathData) {
          // 兼容路径：只对旧快照（曾用手写 _canvasClipPath 的版本）生效。
          fabric.util.enlivenObjects([legacyCanvasClipPathData], (objects) => {
            this.canvas.clipPath = objects[0] || null;
            if (this.canvas.clipPath) {
              this.canvas.clipPath.absolutePositioned = true;
            }
            finishRestore();
          });
        } else if (!hasNativeClipPath && !this.canvas.clipPath) {
          finishRestore();
        } else if (!hasNativeClipPath) {
          // 快照无裁剪信息而画布上有 → 这才是「撤销裁切」该清空的场景。
          this.canvas.clipPath = null;
          finishRestore();
        } else {
          // 原生 json.clipPath 存在：Fabric 已在 loadFromJSON 回调中恢复它，
          // 这里什么都不要做（写 null 会把它抹掉）。
          finishRestore();
        }
      });
    });
  }

  // ── 辅助 ──

  /**
   * 判断点是否在画布内
   * @param {{x:number,y:number}} point
   * @returns {boolean}
   */
  isPointInCanvas(point) {
    return point.x >= 0 && point.x <= this.canvas.width
        && point.y >= 0 && point.y <= this.canvas.height;
  }

  /**
   * 刷新动态马赛克（由 MosaicModule 注入）
   * 此方法在 MosaicModule 激活时设置回调，避免直接依赖模块
   * @param {function():void} callback
   */
  setRefreshDynamicMosaics(callback) {
    this._refreshDynamicMosaics = callback;
  }

  /**
   * 调用动态马赛克刷新回调
   * @param {object} options
   */
  refreshDynamicMosaics(options) {
    if (typeof this._refreshDynamicMosaics === 'function') {
      this._refreshDynamicMosaics(options);
    }
  }

  // ── 内部方法 ──

  _updateCanvasSize() {
    const container = this.canvas.wrapperEl?.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const newWidth = rect.width;
    const newHeight = rect.height;

    // 容器不可见时跳过（避免读到 0×0 导致图片缩没）
    if (newWidth <= 0 || newHeight <= 0) return;

    if (this.canvas.width !== newWidth || this.canvas.height !== newHeight) {
      // 调整画布尺寸时保留编辑内容的相对布局，避免覆盖层与原图错位
      if (this.originalImage) {
        this._resizePreservingLayout(newWidth, newHeight);
      } else {
        this.canvas.setWidth(newWidth);
        this.canvas.setHeight(newHeight);
        this.canvas.calcOffset();
      }

      eventBus.emit('canvas:resized', { width: newWidth, height: newHeight });
    }
  }

  /**
   * 调整画布尺寸时保留编辑内容的相对布局
   * 计算原图在新画布尺寸下的 fit 变换，将变换差值同步应用到所有覆盖层和裁剪路径，
   * 使覆盖层（文字/图形/画笔/马赛克等）与原图的相对位置保持不变
   */
  _resizePreservingLayout(newWidth, newHeight) {
    const img = this.originalImage;
    const padding = 40;

    // 记录原图当前的变换（可能是 fit 状态，也可能是用户手动调整后的状态）
    const oldLeft = img.left;
    const oldTop = img.top;
    const oldScaleX = img.scaleX;
    const oldScaleY = img.scaleY;

    // 计算新画布下的 fit 变换
    const availableW = newWidth - padding * 2;
    const availableH = newHeight - padding * 2;
    const newScale = Math.min(availableW / img.width, availableH / img.height, 1);
    const newLeft = (newWidth - img.width * newScale) / 2;
    const newTop = (newHeight - img.height * newScale) / 2;

    // 计算缩放比例（避免除零）
    const ratioX = oldScaleX ? newScale / oldScaleX : 1;
    const ratioY = oldScaleY ? newScale / oldScaleY : 1;

    // 更新画布尺寸
    this.canvas.setWidth(newWidth);
    this.canvas.setHeight(newHeight);
    this.canvas.calcOffset();

    // 将差值应用到所有覆盖层（非原图、非临时对象）
    const overlays = this.canvas.getObjects().filter(obj =>
      obj !== img &&
      !obj.excludeFromHistory &&
      !obj.excludeFromLayer
    );
    overlays.forEach(obj => {
      const relX = obj.left - oldLeft;
      const relY = obj.top - oldTop;
      obj.set({
        left: newLeft + relX * ratioX,
        top: newTop + relY * ratioY,
        scaleX: obj.scaleX * ratioX,
        scaleY: obj.scaleY * ratioY,
      });
      obj.setCoords();
    });

    // 同步调整画布级裁剪路径，保留裁剪效果与原图的相对位置
    this._transformClipPath(this.canvas.clipPath, oldLeft, oldTop, newLeft, newTop, ratioX, ratioY);

    // 应用新的 fit 变换到原图
    img.set({
      scaleX: newScale,
      scaleY: newScale,
      left: newLeft,
      top: newTop,
    });
    img.setCoords();

    this.canvas.renderAll();

    // 刷新动态马赛克（基于新的原图位置重新计算）
    this.refreshDynamicMosaics({ render: true });
  }

  /**
   * 递归调整 clipPath 的位置和缩放，使其跟随原图变换
   */
  _transformClipPath(clipPath, oldLeft, oldTop, newLeft, newTop, ratioX, ratioY) {
    if (!clipPath) return;
    const relX = (clipPath.left || 0) - oldLeft;
    const relY = (clipPath.top || 0) - oldTop;
    clipPath.set({
      left: newLeft + relX * ratioX,
      top: newTop + relY * ratioY,
      scaleX: (clipPath.scaleX == null ? 1 : clipPath.scaleX) * ratioX,
      scaleY: (clipPath.scaleY == null ? 1 : clipPath.scaleY) * ratioY,
    });
    clipPath.setCoords();
    if (clipPath.clipPath) {
      this._transformClipPath(clipPath.clipPath, oldLeft, oldTop, newLeft, newTop, ratioX, ratioY);
    }
  }

  /**
   * 注册画布监听，并记录解绑信息供 destroy() 使用。
   * @param {string} event - Fabric 事件名
   * @param {Function} handler
   */
  _onCanvas(event, handler) {
    this.canvas.on(event, handler);
    this._canvasListeners.push({ event, handler });
  }

  _bindEvents() {
    if (!this.canvas) return;

    this._canvasListeners = [];

    // 选择变化
    this._onCanvas('selection:created', (e) => {
      eventBus.emit('canvas:selectionCreated', e.selected);
    });
    this._onCanvas('selection:updated', (e) => {
      eventBus.emit('canvas:selectionUpdated', e.selected);
    });
    this._onCanvas('selection:cleared', () => {
      eventBus.emit('canvas:selectionCleared');
    });

    // 物件修改
    this._onCanvas('object:modified', (e) => {
      eventBus.emit('canvas:objectModified', e.target);
    });
    this._onCanvas('text:changed', (e) => {
      eventBus.emit('canvas:objectMetadataChanged', e.target);
    });
    this._onCanvas('text:editing:exited', (e) => {
      eventBus.emit('canvas:objectModified', e.target);
    });

    // 物件添加/删除
    this._onCanvas('object:added', (e) => {
      eventBus.emit('canvas:objectAdded', e.target);
    });

    // 鼠标事件
    this._onCanvas('mouse:down', (e) => {
      eventBus.emit('canvas:mouseDown', e);
    });
    this._onCanvas('mouse:move', (e) => {
      eventBus.emit('canvas:mouseMove', e);
    });
    this._onCanvas('mouse:up', (e) => {
      eventBus.emit('canvas:mouseUp', e);
    });

    // 渲染完成
    this._onCanvas('after:render', () => {
      eventBus.emit('canvas:rendered');
    });

    // 窗口大小变化
    this._boundResize = () => this._updateCanvasSize();
    getDomPort()?.onWindow?.('resize', this._boundResize);

    // 使用 ResizeObserver 监听容器变化
    const container = this.canvas.wrapperEl?.parentElement;
    if (container) {
      this._resizeObserver = getDomPort()?.createResizeObserver?.(() => {
        this._updateCanvasSize();
      }) ?? null;
      this._resizeObserver?.observe?.(container);
    }
  }
}

export default CanvasManager;
