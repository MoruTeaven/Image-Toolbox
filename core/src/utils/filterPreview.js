/**
 * 滤镜预览工具 — 为顶部预设栏生成「当前选中图层」的效果缩略图
 *
 * 说明：
 *   - 仅用于 UI 预览，不修改画布与图片本身的滤镜状态，也不进入历史记录。
 *   - 使用 fabric.StaticCanvas 离屏渲染：把当前源图绘制到 2D 画布后再交给 Fabric，
 *     避免 ImageBitmap / HTMLImageElement 在同源或异步解码上的兼容问题。
 */

import { createCanvas as createOffscreenCanvas } from '../ports/CanvasPort.js';
import { installIntensityFilters } from './filters.js';

/**
 * 预览缩略图的渲染高度（CSS 像素）
 *
 * 宽度不固定：由源图宽高比推导（见 resolvePreviewSize），使卡片宽度跟着
 * 图片比例动态变化，横图更宽、竖图更窄，且 object-fit: cover 不裁切画面。
 * 高度取卡片实际显示高度（选项栏 50px 减去边框与留白）。
 */
export const PREVIEW_HEIGHT = 44;

/** 卡片宽度上下限，避免极端比例（超宽全景 / 细长竖图）把选项栏撑爆或压成一条 */
const MIN_PREVIEW_WIDTH = 40;
const MAX_PREVIEW_WIDTH = 160;

/** 默认宽高比（源图尺寸拿不到时的兜底，约 16:9） */
const FALLBACK_ASPECT = 16 / 9;

/**
 * 按源图宽高比计算预览尺寸与 CSS 宽高比
 *
 * @param {fabric.Image} image
 * @returns {{width: number, height: number, aspect: string}}
 *   width/height 为离屏渲染尺寸，aspect 形如 "148 / 84"（供 CSS aspect-ratio 使用）
 */
export function resolvePreviewSize(image) {
  const { width: srcW, height: srcH } = getSourceSize(image);
  const ratio = (srcW > 0 && srcH > 0) ? (srcW / srcH) : FALLBACK_ASPECT;

  const height = PREVIEW_HEIGHT;
  const rawWidth = height * ratio;
  const width = Math.round(Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, rawWidth)));

  return { width, height, aspect: `${width} / ${height}` };
}

/** 生成预览源图的最大边长，超出则等比缩小，控制内存占用 */
const MAX_SOURCE_SIDE = 320;

/** 源图缓存：同一个图片对象只生成一次预览底图，滤镜参数变化时只重新套滤镜 */
const PREVIEW_STATE_KEY = '__colorPreviewState';

/**
 * 取图片的「原始未套滤镜」元素
 *
 * fabric.Image 持有两个元素引用：
 *   _originalElement — 始终指向原始像素（HTMLImageElement / Canvas），applyFilters 不会改它
 *   _element         — 一旦 applyFilters 就被替换为「已套滤镜」的 canvas（_filteredEl）
 *
 * getElement() 返回的是 _element。若图层已应用滤镜（用户点过一次预设），
 * 拿它当预览底图就会把已有滤镜烘焙进每一张缩略图，使所有预览互相叠加，
 * 与「点击后作用于原图」的真实结果不符。预览底图必须取 _originalElement，
 * 保证每个预设都从原图独立计算。
 *
 * @param {fabric.Image} image
 * @returns {HTMLImageElement|HTMLCanvasElement|null}
 */
function getOriginalElement(image) {
  return image?._originalElement || image?.getElement?.() || null;
}

/**
 * 获取图片的原始尺寸（不含图层缩放）
 * @param {fabric.Image} image
 * @returns {{width: number, height: number}}
 */
function getSourceSize(image) {
  const el = getOriginalElement(image);
  const width = (el && (el.naturalWidth || el.width)) || image?.width || 0;
  const height = (el && (el.naturalHeight || el.height)) || image?.height || 0;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * 预览缓存的判定键：源图身份 + 原图地址
 * 供调用方判断「换图」是否需要重建缩略图。
 * 用原图地址而非 getElement()——后者在图层套滤镜后会变成 canvas（无 src），
 * 导致键值抖动、缓存被反复清空重建。
 *
 * @param {fabric.Image} image
 * @returns {string}
 */
export function getPreviewSourceKey(image) {
  const el = getOriginalElement(image);
  return String(el?.currentSrc || el?.src || '');
}

/**
 * 构建预览用的离屏底图（等比缩放到 MAX_SOURCE_SIDE 以内）
 * @param {fabric.Image} image
 * @returns {HTMLCanvasElement|null}
 */
function buildPreviewSource(image) {
  const { width: srcW, height: srcH } = getSourceSize(image);
  if (!srcW || !srcH) return null;

  const el = getOriginalElement(image);
  if (!el) return null;

  // 先按比例绘制到普通 2D 画布：后续交给 fabric 时无需再处理跨源与异步解码
  const ratio = Math.min(1, MAX_SOURCE_SIDE / Math.max(srcW, srcH));
  const baseW = Math.max(1, Math.round(srcW * ratio));
  const baseH = Math.max(1, Math.round(srcH * ratio));

  const baseCanvas = createOffscreenCanvas(baseW, baseH);
  if (!baseCanvas) return null;
  const ctx = baseCanvas.getContext('2d');
  if (!ctx) return null;

  try {
    ctx.drawImage(el, 0, 0, baseW, baseH);
  } catch (err) {
    return null;
  }

  return baseCanvas;
}

/**
 * 申请（或复用）某个图片对象的预览底座
 *
 * 渲染尺寸随源图宽高比变化：如果缓存里的尺寸与当前比例不一致
 * （例如替换了另一张比例的图片），则重建离屏画布并同步尺寸。
 *
 * @param {fabric.Image} image
 * @returns {object|null} { canvas, sourceImage, size }
 */
function getPreviewEntry(image) {
  const el = getOriginalElement(image);
  if (!el) return null;

  const cacheKey = String(el.currentSrc || el.src || '');
  const size = resolvePreviewSize(image);
  let entry = image[PREVIEW_STATE_KEY];

  const isStale = !entry
    || entry.cacheKey !== cacheKey
    || !entry.baseCanvas
    || entry.size?.width !== size.width
    || entry.size?.height !== size.height;

  if (isStale) {
    if (entry?.canvas) {
      try { entry.canvas.dispose(); } catch (err) { /* 忽略销毁失败 */ }
    }

    const baseCanvas = buildPreviewSource(image);
    if (!baseCanvas) return null;

    const previewCanvas = new fabric.StaticCanvas(null, {
      width: size.width,
      height: size.height,
      backgroundColor: 'transparent',
      enableRetinaScaling: true,
      renderOnAddRemove: false,
    });

    const sourceImage = new fabric.Image(baseCanvas);
    sourceImage.set({
      selectable: false,
      evented: false,
      originX: 'center',
      originY: 'center',
      left: size.width / 2,
      top: size.height / 2,
    });

    // 保持原始宽高比，完整装入缩略图（contain）
    const scale = Math.min(size.width / baseCanvas.width, size.height / baseCanvas.height);
    sourceImage.set({ scaleX: scale, scaleY: scale });

    previewCanvas.add(sourceImage);
    entry = { cacheKey, baseCanvas, canvas: previewCanvas, sourceImage, size };
    image[PREVIEW_STATE_KEY] = entry;
  }

  return entry;
}

/**
 * 取指定图片的预览尺寸信息（供 UI 设置卡片宽高比）
 *
 * @param {fabric.Image} image
 * @returns {{width: number, height: number, aspect: string}}
 */
export function getPreviewSize(image) {
  return resolvePreviewSize(image);
}

/**
 * 生成某个预设应用到指定图片后的效果缩略图
 *
 * @param {fabric.Image} image 当前选中的图片图层（作为预览基准）
 * @param {Array<{type: string, attr: string, value: number}>} filters 预设滤镜参数
 * @returns {string|null} dataURL，失败时返回 null（调用方降级为纯文字按钮）
 */
export function createFilterPreviewDataURL(image, filters) {
  if (!image || image.type !== 'image') return null;

  const entry = getPreviewEntry(image);
  if (!entry) return null;

  const { canvas, sourceImage } = entry;

  // 缩略图与画面必须用同一套滤镜类：棕褐/灰度是自定义强度滤镜，这里同样要装好
  installIntensityFilters();

  sourceImage.filters = filters.map(({ type, attr, value }) => {
    const FilterClass = fabric.Image.filters[type];
    return FilterClass ? new FilterClass({ [attr]: value }) : null;
  }).filter(Boolean);

  try {
    sourceImage.applyFilters();
    canvas.renderAll();
  } catch (err) {
    return null;
  }

  try {
    return canvas.toDataURL({ format: 'png', multiplier: 2 });
  } catch (err) {
    return null;
  }
}

/**
 * 释放预览缓存（图片图层被移除或模块停用时调用）
 * @param {fabric.Image} image
 */
export function disposeFilterPreview(image) {
  const entry = image?.[PREVIEW_STATE_KEY];
  if (!entry) return;

  if (entry.canvas) {
    try { entry.canvas.dispose(); } catch (err) { /* 忽略销毁失败 */ }
  }
  delete image[PREVIEW_STATE_KEY];
}
