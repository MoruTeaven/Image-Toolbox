/**
 * 画笔光标跟随门禁（独立门禁，pnpm build 不调用）。
 *
 * 光标指示的演进：早期用 Fabric 画布对象（Group + 3 个 Circle），反复出问题——
 * 缩放后对象坐标正确、visible=true，但 Fabric 在 isDrawingMode 下不再画它
 * （真机逐像素扫描：缩放后整张画布 0 个红色像素），且外圈+主圈看起来是
 * 「两个圈」。现改为 DOM 覆盖层（单个圆圈），用原生 clientX/clientY 直接定位，
 * 与画布缩放/对象缓存/历史序列化彻底解耦。
 *
 * 本脚本用桩件驱动 BrushModule，守护：
 *   1. 光标是单个 DOM 元素（不是 Fabric 对象，不会出现两个圈）；
 *   2. mousemove/mouseenter 用 clientX/clientY 定位并立即可见；
 *   3. 缩放（canvas:zoomChanged）只改直径，不改变位置、不隐藏、不新增元素；
 *   4. mouseleave 隐藏，再次 mousemove 恢复；
 *   5. 切走工具 deactivate 清理元素与监听，重复 activate 不重复绑定；
 *   6. 换色/改粗细同步光圈样式；直径随缩放放大。
 *
 * 真机 CDP + 像素级验证见 scripts/probe-brush-real.mjs。
 *
 * 用法：node scripts/verify-brush-cursor.mjs
 */

import { installDom } from './test-env.mjs';

installDom();

const { default: eventBus } = await import('../core/src/EventBus.js');
const { default: BrushModule } = await import('../core/src/modules/BrushModule.js');
const { setDomPort } = await import('../core/src/ports/DomPort.js');

// ── 注入测试 DomPort：createElement 返回可用 style/append 的桩件 ──
const created = [];
setDomPort({
  createElement(tag) {
    const el = {
      tagName: tag,
      style: { setProperty(k, v) { this[k] = String(v); } },
      dataset: {},
      parentNode: null,
    };
    created.push(el);
    return el;
  },
  getBody() {
    return {
      appendChild(child) { child.parentNode = this; },
      removeChild(child) { child.parentNode = null; },
    };
  },
});

// 最小 fabric 桩件（_ensureBrush 需要 PencilBrush）
globalThis.fabric = { PencilBrush: class { constructor(c) { this.canvas = c; } } };

// 最小 canvas 桩件
const upper = {
  _l: new Map(),
  addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); },
  removeEventListener(t, f) { const a = this._l.get(t); if (a) this._l.set(t, a.filter(x => x !== f)); },
  fire(t, e) { for (const f of (this._l.get(t) || [])) f(e); },
  count(t) { return (this._l.get(t) || []).length; },
};
const canvas = {
  upperCanvasEl: upper,
  isDrawingMode: false,
  freeDrawingBrush: null,
  getObjects() { return []; },
  renderAll() {},
  discardActiveObject() {},
  on() {}, off() {},
};
const cm = { canvas, zoomLevel: 1 };
const hm = { saveState() {} };

const failures = [];
let passed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

eventBus.clear();
const brush = new BrushModule(cm, hm);
brush.activate();

const el = brush._cursorEl;
check('光标是单个 DOM 元素', !!el && created.filter(e => e.dataset.brushCursor === '1').length === 1);
check('光标 DOM 用 fixed 定位', el?.style.position === 'fixed');
check('光标只有一层圆圈（非 Fabric Group）', el?.tagName === 'div' && !('getObjects' in (el || {})));

// mousemove 定位到 client 坐标
upper.fire('mousemove', { clientX: 320, clientY: 240 });
check('mousemove 后立即显示', el.style.display === 'block');
check('mousemove 定位到 clientX/clientY', el.style.left === '320px' && el.style.top === '240px');
check('记录最后鼠标屏幕坐标', brush._lastClientPoint?.clientX === 320 && brush._lastClientPoint?.clientY === 240);

// 缩放：只改直径，不改位置、不隐藏、不新增元素
const beforeW = el.style.width;
const beforeLeft = el.style.left;
cm.zoomLevel = 1.5;
eventBus.emit('canvas:zoomChanged', 1.5);
check('缩放后光标仍显示', el.style.display === 'block');
check('缩放后位置不变（贴着未动的鼠标）', el.style.left === beforeLeft);
check('缩放后直径随缩放变大', parseFloat(el.style.width) > parseFloat(beforeW),
  `before=${beforeW}, after=${el.style.width}`);
check('缩放不新增光标元素', created.filter(e => e.dataset.brushCursor === '1').length === 1);

// mouseleave 隐藏，mousemove 恢复
upper.fire('mouseleave', {});
check('mouseleave 隐藏光标', el.style.display === 'none');
upper.fire('mousemove', { clientX: 400, clientY: 300 });
check('mousemove 恢复显示', el.style.display === 'block');
check('恢复后定位到新坐标', el.style.left === '400px' && el.style.top === '300px');

// 换色/改粗细
brush.setColor('#1677ff');
check('换色同步光圈边框', el.style['border-color'] === '#1677ff', el.style['border-color']);
brush.setWidth(12);
check('改粗细同步光圈直径', parseFloat(el.style.width) >= 12, el.style.width);

// 重复 activate 不重复绑定
brush.activate();
check('重复 activate 后 mousemove 监听不重复', upper.count('mousemove') === 1);
check('重复 activate 后光标元素不重复', created.filter(e => e.dataset.brushCursor === '1').length === 1);

// deactivate 清理
brush.deactivate();
check('deactivate 后光标元素移除', el.parentNode === null);
check('deactivate 后 mousemove 监听清零', upper.count('mousemove') === 0);

console.log(`\n[画笔光标门禁] ${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
