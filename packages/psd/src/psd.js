/**
 * PSD (Photoshop) 格式导入/导出模块
 *
 * 使用 ag-psd (MIT) 读写 PSD 文件。
 *   导出：Fabric.js 画布对象 → PSD 图层（每层全画布尺寸 canvas）
 *   导入：PSD → Fabric.js 对象（每层按边界 canvas 定位）
 *
 * 混合模式映射：PSD blendMode 字符串 ↔ Canvas globalCompositeOperation。
 *   'normal' ↔ 'source-over'，其余多数同名（空格→连字符）。
 *   项目 UI 当前暴露 7 种（见 PropertyPanel），其余 PSD 模式导入时仍写入
 *   globalCompositeOperation，Fabric 运行时支持但属性面板不显示。
 */

// ponytail: 相对路径引用 core/src/，同 @moruteaven/img-toolbox_ora。
// subpath imports (#core/) 不允许 workspace 包上溯包目录之外。
import eventBus from '../../../core/src/EventBus.js';
import { SAVE_STATUS, normalizeSaveResult } from '../../../core/src/adapters/BaseHostAdapter.js';
import { createCanvas as createOffscreenCanvas } from '../../../core/src/ports/CanvasPort.js';
import { downloadFile as downloadViaBrowser } from '../../../core/src/ports/DownloadPort.js';
import { readPsd, writePsd } from 'ag-psd';

// ── 混合模式映射 ──

const PSD_TO_FABRIC_BLEND = {
  'normal': 'source-over',
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'lighten': 'lighten',
  'darken': 'darken',
  'color burn': 'color-burn',
  'color dodge': 'color-dodge',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};
const FABRIC_TO_PSD_BLEND = {};
for (const [psd, fab] of Object.entries(PSD_TO_FABRIC_BLEND)) {
  FABRIC_TO_PSD_BLEND[fab] = psd;
}

// ag-psd opacity 是 0-1（psdReader readUint8/0xff 归一化，与 Fabric opacity 同量程）
function _psdOpacityToFabric(op) {
  if (op === undefined) return 1;
  return Math.max(0, Math.min(1, op));
}
function _fabricOpacityToPsd(op) {
  return Math.max(0, Math.min(1, op ?? 1));
}

// ── 图层名 ──

function _getLayerName(obj, layerManager) {
  if (layerManager) {
    const meta = layerManager.getLayerByObject?.(obj);
    if (meta?.name) return meta.name;
  }
  if (obj._layerName) return obj._layerName;
  const typeMap = {
    'i-text': '文字', 'text': '文字', 'textbox': '文字',
    'rect': '矩形', 'circle': '圆形', 'path': '画笔',
    'image': '图层', 'group': '组合',
  };
  return typeMap[obj?.type] || '图层';
}

// ── 渲染对象到离屏 canvas（全画布尺寸）──

function _renderObjectToCanvas(obj, canvasWidth, canvasHeight) {
  try {
    obj.setCoords();
    const w = Math.max(1, Math.round(canvasWidth));
    const h = Math.max(1, Math.round(canvasHeight));
    const cv = createOffscreenCanvas(w, h);
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    obj.render(ctx);
    return cv;
  } catch (err) {
    console.warn('[PSD] 渲染对象失败:', obj?.type, err);
    return null;
  }
}

function _renderBackgroundToCanvas(canvasManager, w, h) {
  const img = canvasManager.originalImage;
  if (!img) return null;
  try {
    img.setCoords();
    const cv = createOffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    if (!cv) return null;
    img.render(cv.getContext('2d'));
    return cv;
  } catch (err) {
    console.warn('[PSD] 渲染背景图失败:', err);
    return null;
  }
}

// ── 扁平化嵌套图层（PSD 图层组 → 平铺）──

function _flattenLayers(children, out = []) {
  if (!children) return out;
  for (const child of children) {
    if (child.children && child.children.length > 0) {
      _flattenLayers(child.children, out);
    } else if (child.canvas || child.imageData) {
      out.push(child);
    }
  }
  return out;
}

// ── canvas → dataURL ──

function _canvasToDataURL(canvas) {
  return canvas.toDataURL('image/png');
}

function _loadImageFromDataURL(dataURL) {
  return new Promise((resolve) => {
    fabric.Image.fromURL(dataURL, (img, isError) => {
      if (isError || !img) { resolve(null); return; }
      resolve(img);
    }, undefined, undefined);
  });
}

// ═══════════════════════════════════════
// PSD 导出
// ═══════════════════════════════════════

/**
 * 导出为 PSD 文件
 * @param {object} canvasManager
 * @param {object} layerManager
 * @param {object} [hostAdapter]
 * @returns {Promise<boolean>}
 */
export async function exportPSD(canvasManager, layerManager, hostAdapter = null) {
  const canvas = canvasManager.canvas;
  if (!canvas) return false;

  try {
    const objects = canvas.getObjects();
    const originalImage = canvasManager.originalImage;
    const w = canvas.width;
    const h = canvas.height;

    const psdChildren = [];

    // 背景图层
    if (originalImage) {
      const bgCanvas = _renderBackgroundToCanvas(canvasManager, w, h);
      if (bgCanvas) {
        psdChildren.push({
          name: '背景',
          canvas: bgCanvas,
          left: 0, top: 0, right: w, bottom: h,
          opacity: _fabricOpacityToPsd(originalImage.opacity),
          blendMode: FABRIC_TO_PSD_BLEND[originalImage.globalCompositeOperation] || 'normal',
          hidden: originalImage.visible === false,
        });
      }
    }

    // 覆盖图层（PSD 顶层在前，Fabric 底层在前 → 反转）
    const overlays = [];
    for (const obj of objects) {
      if (obj === originalImage) continue;
      if (obj.excludeFromLayer || obj.excludeFromHistory) continue;
      const cv = _renderObjectToCanvas(obj, w, h);
      if (cv) {
        overlays.push({
          name: _getLayerName(obj, layerManager),
          canvas: cv,
          left: 0, top: 0, right: w, bottom: h,
          opacity: _fabricOpacityToPsd(obj.opacity),
          blendMode: FABRIC_TO_PSD_BLEND[obj.globalCompositeOperation] || 'normal',
          hidden: obj.visible === false,
        });
      }
    }
    // overlays 底层在前 → 反转让顶层在前（PSD children 顺序）
    psdChildren.push(...overlays.reverse());

    const psd = {
      width: w,
      height: h,
      children: psdChildren,
    };

    // ag-psd writePsd 同步返回 ArrayBuffer
    const arrayBuffer = writePsd(psd);
    const blob = new Blob([arrayBuffer], { type: 'image/vnd.adobe.photoshop' });

    const status = await _savePsdFile(blob, hostAdapter);
    if (status === SAVE_STATUS.CANCELED) return false;
    if (status === SAVE_STATUS.SAVED) {
      eventBus.emit('toast:show', { message: 'PSD 文件已保存', type: 'success' });
      return true;
    }
    eventBus.emit('toast:show', { message: 'PSD 保存失败：无法写入文件', type: 'error' });
    return false;
  } catch (err) {
    console.error('[PSD] 导出失败:', err);
    eventBus.emit('toast:show', { message: 'PSD 导出失败: ' + err.message, type: 'error' });
    return false;
  }
}

async function _savePsdFile(blob, hostAdapter) {
  const binaryFile = hostAdapter?.binaryFile;
  if (binaryFile?.showSaveDialog && binaryFile?.write) {
    const filePath = binaryFile.showSaveDialog('project.psd');
    if (!filePath) return SAVE_STATUS.CANCELED;
    const psdPath = filePath.replace(/\.[^.]+$/, '') + '.psd';
    const arrayBuffer = await blob.arrayBuffer();
    let saved = false;
    try {
      saved = binaryFile.write(psdPath, arrayBuffer) !== false;
    } catch (err) {
      console.error('[PSD] 写入文件失败:', err);
      saved = false;
    }
    return saved ? SAVE_STATUS.SAVED : SAVE_STATUS.FAILED;
  }

  if (hostAdapter?.showSaveImageDialog && hostAdapter?.writeImageFile) {
    const filePath = hostAdapter.showSaveImageDialog('project.psd');
    if (!filePath) return SAVE_STATUS.CANCELED;
    const psdPath = filePath.replace(/\.[^.]+$/, '') + '.psd';
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const dataURL = `data:image/vnd.adobe.photoshop;base64,${base64}`;
    let result;
    try {
      result = hostAdapter.writeImageFile(psdPath, dataURL);
    } catch (err) {
      console.error('[PSD] 写入文件失败:', err);
      return SAVE_STATUS.FAILED;
    }
    const normalized = normalizeSaveResult(result);
    return normalized.status === SAVE_STATUS.UNSUPPORTED ? SAVE_STATUS.FAILED : normalized.status;
  }

  const result = downloadViaBrowser(blob, 'project.psd');
  return result.ok ? SAVE_STATUS.SAVED : SAVE_STATUS.FAILED;
}

// ═══════════════════════════════════════
// PSD 导入
// ═══════════════════════════════════════

/**
 * 从 PSD 文件导入
 * @param {Blob} psdBlob
 * @param {object} canvasManager
 * @param {object} layerManager
 * @param {object} historyManager
 * @returns {Promise<boolean>}
 */
export async function importPSD(psdBlob, canvasManager, layerManager, historyManager) {
  try {
    const arrayBuffer = await psdBlob.arrayBuffer();
    const psd = readPsd(arrayBuffer);

    // 设置画布尺寸
    if (psd.width > 0 && psd.height > 0) {
      canvasManager.canvas.setWidth(psd.width);
      canvasManager.canvas.setHeight(psd.height);
      canvasManager.canvas.calcOffset();
    }

    // 扁平化嵌套图层，过滤无 canvas 的层
    const flat = _flattenLayers(psd.children);
    // PSD children 顶层在前 → 反转为底层在前（Fabric 顺序）
    const ordered = [...flat].reverse();

    // 清空当前画布
    canvasManager.canvas.clear();
    canvasManager.originalImage = null;

    let bgImage = null;

    for (let i = 0; i < ordered.length; i++) {
      const layer = ordered[i];
      if (!layer.canvas) continue;

      const dataURL = _canvasToDataURL(layer.canvas);
      const fabricObj = await _loadImageFromDataURL(dataURL);
      if (!fabricObj) continue;

      fabricObj.set({
        left: layer.left || 0,
        top: layer.top || 0,
        opacity: _psdOpacityToFabric(layer.opacity),
        visible: !layer.hidden,
      });

      const blend = PSD_TO_FABRIC_BLEND[layer.blendMode];
      if (blend && blend !== 'source-over') {
        fabricObj.set('globalCompositeOperation', blend);
      }

      if (i === 0) {
        fabricObj._originalImage = true;
        fabricObj._layerName = layer.name || '背景';
        canvasManager.originalImage = fabricObj;
        bgImage = fabricObj;
      } else {
        fabricObj._layerName = layer.name || '图层';
      }

      canvasManager.canvas.add(fabricObj);
    }

    if (bgImage) {
      canvasManager._applyBackgroundImageProps?.(bgImage);
    }

    canvasManager.canvas.renderAll();
    canvasManager.fitToCanvas(40);

    layerManager.syncLayers();
    historyManager.clear();
    historyManager.saveState();

    eventBus.emit('image:loaded', bgImage);
    eventBus.emit('toast:show', { message: 'PSD 文件已导入', type: 'success' });
    return true;
  } catch (err) {
    console.error('[PSD] 导入失败:', err);
    eventBus.emit('toast:show', { message: 'PSD 导入失败: ' + err.message, type: 'error' });
    return false;
  }
}
