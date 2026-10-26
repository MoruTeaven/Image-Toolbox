/**
 * CanvasPort — 离屏画布的创建入口（非 UI 层用）
 *
 * 背景
 * ----
 * 像素算法模块（MosaicModule 的模糊/马赛克、ora 的图层合成、filterPreview
 * 的预设缩略图）需要大量离屏 canvas 做中间缓冲。它们过去直接写
 * `document.createElement('canvas')`，把「需要一块 2D 绘制表面」这一纯粹
 * 的计算需求，表达成了「我需要 DOM」——这正是 core 无法脱离浏览器运行的原因。
 *
 * 本端口把该需求抽象为「给我一块画布」：
 *   - 浏览器实现走 `document.createElement('canvas')`；
 *   - 其他宿主（如未来的 Node / OffscreenCanvas / node-canvas）可注入自己的实现；
 *   - 测试可注入桩件，无需 DOM。
 *
 * 注意：本端口只负责「创建」，不接管绘制；调用方仍用自己的 2D 上下文逻辑。
 */

let _factory = null;

/**
 * 注入画布工厂。
 * @param {((width?: number, height?: number) => object|null)|null} factory
 */
export function setCanvasFactory(factory) {
  _factory = typeof factory === 'function' ? factory : null;
}

/** 清空注入（测试用）。 */
export function resetCanvasFactory() {
  _factory = null;
}

/**
 * 创建一块离屏画布。
 * @param {number} [width]
 * @param {number} [height]
 * @returns {object|null} 画布对象（含 getContext）；环境不支持时返回 null
 */
export function createCanvas(width, height) {
  if (_factory) {
    const canvas = _factory(width, height);
    if (canvas) {
      if (Number.isFinite(width)) canvas.width = width;
      if (Number.isFinite(height)) canvas.height = height;
      return canvas;
    }
    return null;
  }

  // 默认：浏览器标准实现。用 typeof 守卫而非 `document.` 直取，
  // 使本模块在 Node 下被 import 时不会抛 ReferenceError。
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }

  const canvas = document.createElement('canvas');
  if (Number.isFinite(width)) canvas.width = width;
  if (Number.isFinite(height)) canvas.height = height;
  return canvas;
}

/**
 * 创建一块带 2D 上下文的画布。
 * @param {number} [width]
 * @param {number} [height]
 * @returns {{ canvas: object, ctx: object }|null}
 */
export function createCanvas2D(width, height) {
  const canvas = createCanvas(width, height);
  if (!canvas) return null;

  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch (e) {
    ctx = null;
  }

  if (!ctx) return null;
  return { canvas, ctx };
}

/**
 * 判断当前环境能否创建离屏画布。
 * 供调用方在动手前做能力探测，避免走到一半才失败。
 * @returns {boolean}
 */
export function canCreateCanvas() {
  if (_factory) {
    try {
      return !!_factory(1, 1);
    } catch (e) {
      return false;
    }
  }
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}
