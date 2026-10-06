/**
 * objectClone.js — Fabric 对象克隆工具
 *
 * 克隆统一采用「序列化 JSON → fabric.util.enlivenObjects 重建」的方式：
 * Fabric 对象的 filters、clipPath、马赛克 src 等属性无法安全浅拷贝，
 * 而 toJSON/enlivenObjects 往返与 ORA 工程导入还原使用同一套机制，行为一致。
 *
 * 注意：enlivenObjects 不还原对象顶层的自定义字段以外的运行时派生态
 * （如 _originalImage 标记由 LayerManager 自行维护），克隆后需按需补写。
 */

// 克隆时需要保留的属性白名单（与 CanvasManager.toJSON 的自定义属性集保持一致）
const CLONE_PROPS = [
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
  'strokeUniform',
  'paintFirst',
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
  'filters',
  'clipPath',
];

/**
 * 将 Fabric 对象序列化为可重建的纯数据 JSON
 * @param {object} obj fabric 对象
 * @returns {object} 序列化数据（含 type/filters/clipPath 与图层自定义字段）
 */
export function serializeFabricObject(obj) {
  return obj.toJSON(CLONE_PROPS);
}

/**
 * 由序列化数据重建 Fabric 对象（enlivenObjects 回调包装为 Promise）
 * @param {object} jsonObj serializeFabricObject 的产物
 * @returns {Promise<object|null>} 重建的对象；失败或超时返回 null
 */
export function deserializeFabricObject(jsonObj) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(obj && typeof obj.set === 'function' ? obj : null);
    };

    // 超时保护：Image 类对象的重建依赖图片解码，极端情况下回调可能不触发
    const timer = setTimeout(() => {
      console.warn('[objectClone] 对象克隆还原超时');
      done(null);
    }, 5000);

    try {
      fabric.util.enlivenObjects([jsonObj], (enlivened) => {
        done(enlivened && enlivened.length > 0 ? enlivened[0] : null);
      });
    } catch (e) {
      console.error('[objectClone] 对象克隆异常:', e);
      done(null);
    }
  });
}
