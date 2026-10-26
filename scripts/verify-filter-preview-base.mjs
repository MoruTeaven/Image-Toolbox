/**
 * 滤镜预览基准门禁 — 预览缩略图必须始终从「原图」计算，不能受图层当前滤镜影响
 *
 * 历史缺陷：filterPreview.js 用 image.getElement() 取预览底图。fabric.Image 的
 * getElement() 返回 _element，而 applyFilters 会把 _element 替换为「已套滤镜」的
 * canvas（_filteredEl）。因此用户点过一次预设后，后续所有缩略图都基于已滤镜的画面
 * 再叠一次滤镜，预览互相污染，与「点击后作用于原图」的真实结果不符。
 *
 * 本脚本构造一个 getElement() 返回「已污染 canvas」、_originalElement 返回原图的
 * fabric.Image 桩件，断言：
 *   1. 预览底图取自 _originalElement（原图像素），而非 getElement()（已滤镜 canvas）
 *   2. getPreviewSourceKey 在原图元素上取值，不受 _element 变成 canvas 影响
 *
 * 运行：node scripts/verify-filter-preview-base.mjs
 */

import assert from 'node:assert/strict';

// ── 最小 fabric / DOM 桩件 ──
const RED = [255, 0, 0, 255];

function makeCanvasStub(width, height, fill) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels.set(fill, i);
    }
  }
  const ctx = {
    _pixels: pixels,
    _drawCalls: [],
    drawImage(src, ...args) {
      // 记录被绘制的源，供断言「画的是哪张图」
      this._drawCalls.push(src);
      // 若源是带像素的 canvas 桩件，复制其首像素颜色
      const srcPixels = src && src.__pixels;
      if (srcPixels && srcPixels.length >= 4) {
        this._pixels.set(srcPixels.subarray(0, 4), 0);
      }
    },
    getImageData(x, y, w, h) {
      return { data: this._pixels, width: w, height: h };
    },
    clearRect() {},
    putImageData() {},
    translate() {},
    scale() {},
    save() {},
    restore() {},
  };
  return {
    width,
    height,
    __pixels: pixels,
    __ctx: ctx,
    getContext: () => ctx,
  };
}

globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') return makeCanvasStub(1, 1, RED);
    return {};
  },
};
globalThis.window = globalThis;
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

// fabric.Image.filters 桩件：套用后把结果像素写进目标 canvas
class StubFilter {
  constructor(opts = {}) {
    Object.assign(this, opts);
  }
  applyTo2d({ imageData }) {
    // 模拟滤镜改写像素：任何滤镜都把首像素改成蓝色，便于区分「原图红」与「滤镜蓝」
    imageData.data[0] = 0;
    imageData.data[1] = 0;
    imageData.data[2] = 255;
  }
  isNeutralState() { return false; }
}

let renderCount = 0;
globalThis.fabric = {
  Image: Object.assign(
    function ImageStub(el) {
      this._originalElement = el;
      this._element = el;
      this.filters = [];
      this.type = 'image';
      this.set = (opts) => { Object.assign(this, opts); return this; };
      this.applyFilters = () => {
        // 模拟 fabric 的真实行为：套滤镜后 _element 变成独立的已滤镜 canvas
        this._element = makeCanvasStub(1, 1, [0, 0, 255, 255]);
        return this;
      };
    },
    { filters: { Brightness: StubFilter, Contrast: StubFilter } }
  ),
  StaticCanvas: function StaticCanvasStub(_el, opts = {}) {
    this.width = opts.width;
    this.height = opts.height;
    this._objects = [];
    this.add = (obj) => { this._objects.push(obj); };
    this.renderAll = () => { renderCount++; };
    this.dispose = () => {};
    this.toDataURL = () => 'data:image/png;base64,STUB';
  },
  util: {
    createCanvasElement: () => makeCanvasStub(1, 1, RED),
  },
};

const { createFilterPreviewDataURL, getPreviewSourceKey } = await import('../core/src/utils/filterPreview.js');

// ── 场景：图层已套滤镜，_element 已被替换为「已污染」的 canvas ──
const originalCanvas = makeCanvasStub(100, 60, RED);   // 原图：红
const pollutedCanvas = makeCanvasStub(100, 60, [0, 0, 255, 255]); // 已滤镜：蓝

const image = new fabric.Image(originalCanvas);
image._element = pollutedCanvas; // 模拟 applyFilters 之后的真实状态

// 断言 1：源图 key 取原图元素（有 src），而非 getElement()（canvas 无 src）
originalCanvas.src = 'blob:original-red';
const key = getPreviewSourceKey(image);
assert.equal(key, 'blob:original-red', 'getPreviewSourceKey 必须取 _originalElement 的地址');

// 断言 2：预览底图画的是原图，不是已滤镜的 canvas
const dataURL = createFilterPreviewDataURL(image, [{ type: 'Brightness', attr: 'brightness', value: 0.5 }]);
assert.ok(dataURL, 'createFilterPreviewDataURL 应返回 dataURL');

// 取出离屏画布底图（fabric.Image 桩件构造时的 el）
const entry = image.__colorPreviewState;
assert.ok(entry, '应建立预览缓存条目');
const drawn = entry.baseCanvas.__ctx._drawCalls;
assert.ok(drawn.length > 0, '预览底图应有 drawImage 调用');
assert.equal(
  drawn[0],
  originalCanvas,
  '预览底图必须绘制 _originalElement（原图），而不是 getElement() 返回的已滤镜 canvas'
);
assert.notEqual(
  drawn[0],
  pollutedCanvas,
  '预览底图不得绘制已被滤镜污染的 _element，否则缩略图会互相叠加'
);

// 断言 3：不同滤镜各自独立渲染，渲染次数随预设数增长（无缓存串味）
const before = renderCount;
createFilterPreviewDataURL(image, [{ type: 'Contrast', attr: 'contrast', value: 0.3 }]);
assert.ok(renderCount > before, '第二个滤镜应触发独立渲染');

console.log('OK   预览基准 = 原图（_originalElement），不受图层当前滤镜影响');
console.log('OK   getPreviewSourceKey 取原图地址，_element 变 canvas 后仍稳定');
console.log('OK   多个预设各自独立渲染，缩略图不互相叠加');
console.log('\n滤镜预览基准门禁：全部通过');
