/**
 * 画笔光标跟随门禁（独立门禁，pnpm build 不调用）。
 *
 * 守护「画笔光标有时候不显示」这一类回归。历史上这个 bug 反复出现，根因不止一种：
 *   A) _requestRender 走 requestRenderAll（rAF），在 uTools/ZTools 被宿主节流，
 *      光标那一帧迟迟不画；
 *   B) 依赖 Fabric 的 mouse:over/out 驱动显隐，但绘图模式下这两个合成事件被跳过，
 *      mouse:over 还要求 findTarget 为空——鼠标已在画布内切到画笔、或压在对象上时
 *      永不显示；
 *   C) 撤销/重做、换图后画布对象重建，旧预览引用失效，鼠标静止时不再恢复；
 *   D) 重复 activate / 画布重建后事件绑定丢失或重复。
 *
 * 本脚本用最小桩件直接驱动 BrushModule 的光标相关方法，断言上述修复点：
 *   1. 光标跟随走同步 renderAll，不再依赖 requestRenderAll；
 *   2. mouseenter 立即显示，不依赖 mousemove / Fabric 合成事件；
 *   3. 画布重建（canvas:restored）后立即按最后指针位置重建预览，无需鼠标再动；
 *   4. 画布对象被清空、旧引用失效时 _ensureCursorPreview 能自愈重建；
 *   5. 反复 activate/deactivate 不重复绑定、不残留监听；
 *   6. mouseleave 隐藏，mousemove 又能恢复显示。
 *
 * 用法：node scripts/verify-brush-cursor.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 */

import { installDom } from './test-env.mjs';

installDom();

// ── 最小 fabric 桩件：只需覆盖 BrushModule 光标路径用到的成员 ──

class StubObject {
  constructor(props = {}) {
    this.left = 0;
    this.top = 0;
    this.visible = false;
    this.objectCaching = false;
    Object.assign(this, props);
  }
  set(props, value) {
    // Fabric 的 set 既支持 set({a:1}) 也支持 set('a', 1)，桩件两者都要覆盖。
    if (typeof props === 'string') { this[props] = value; } else { Object.assign(this, props); }
    return this;
  }
  setCoords() { this._coordsReady = true; }
  getObjects() { return this._objects || []; }
}

class StubGroup extends StubObject {
  constructor(objects = [], props = {}) {
    super(props);
    this._objects = objects;
  }
}

class StubUpperCanvasEl {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) { this._listeners.set(type, []); }
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const fns = this._listeners.get(type);
    if (!fns) { return; }
    this._listeners.set(type, fns.filter(f => f !== fn));
  }
  fire(type, e = {}) {
    for (const fn of (this._listeners.get(type) || [])) { fn(e); }
  }
  listenerCount(type) { return (this._listeners.get(type) || []).length; }
  totalListeners() {
    let n = 0;
    for (const fns of this._listeners.values()) { n += fns.length; }
    return n;
  }
}

class StubCanvas {
  constructor() {
    this.upperCanvasEl = new StubUpperCanvasEl();
    this._objects = [];
    this._fabricListeners = new Map();
    this.renderAllCount = 0;
    this.requestRenderAllCount = 0;
    this.freeDrawingBrush = null;
    this.isDrawingMode = false;
  }
  on(type, fn) {
    if (!this._fabricListeners.has(type)) { this._fabricListeners.set(type, []); }
    this._fabricListeners.get(type).push(fn);
  }
  off(type, fn) {
    const fns = this._fabricListeners.get(type);
    if (!fns) { return; }
    this._fabricListeners.set(type, fns.filter(f => f !== fn));
  }
  fabricListenerCount(type) { return (this._fabricListeners.get(type) || []).length; }
  add(obj) { this._objects.push(obj); }
  remove(obj) {
    const i = this._objects.indexOf(obj);
    if (i >= 0) { this._objects.splice(i, 1); }
  }
  clear() { this._objects = []; }
  getObjects() { return this._objects.concat(); }
  bringToFront(obj) {
    this.remove(obj);
    this._objects.push(obj);
  }
  getPointer(_nativeEvent) {
    // 桩件直接返回预设指针；缩放/平移由真实 getPointer 负责反算。
    return this.__pointer || { x: 0, y: 0 };
  }
  renderAll() { this.renderAllCount++; }
  requestRenderAll() { this.requestRenderAllCount++; }
  discardActiveObject() {}
}

globalThis.fabric = {
  Group: StubGroup,
  Circle: class Circle extends StubObject {},
  PencilBrush: class PencilBrush {
    constructor() { this.color = null; this.width = null; }
  },
};

// ── 加载被测模块 ──

const { default: eventBus } = await import('../core/src/EventBus.js');
const { default: BrushModule } = await import('../core/src/modules/BrushModule.js');

const failures = [];
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const canvas = new StubCanvas();
const canvasManager = { canvas };
const history = { saveState() {} };
const brush = new BrushModule(canvasManager, history);

eventBus.clear();
brush.activate();

const el = canvas.upperCanvasEl;
const preview = () => brush._cursorPreview;

// ── 1. mouseenter 立即显示，无需 mousemove ──
canvas.__pointer = { x: 120, y: 80 };
el.fire('mouseenter', { clientX: 120, clientY: 80 });
check('mouseenter 立即创建并显示光标预览', !!preview() && preview().visible === true);
check('光标定位到指针位置', preview() && preview().left === 120 && preview().top === 80);

// ── 2. 光标跟随走同步 renderAll，不用 requestRenderAll ──
const rendersBefore = canvas.renderAllCount;
const asyncBefore = canvas.requestRenderAllCount;
canvas.__pointer = { x: 200, y: 160 };
el.fire('mousemove', { clientX: 200, clientY: 160 });
check('mousemove 后光标位置更新', preview().left === 200 && preview().top === 160);
check('光标跟随触发同步 renderAll', canvas.renderAllCount > rendersBefore);
check('光标跟随不依赖 requestRenderAll', canvas.requestRenderAllCount === asyncBefore);

// ── 3. mouseleave 隐藏，mousemove 恢复 ──
el.fire('mouseleave', {});
check('mouseleave 隐藏光标', preview().visible === false);
canvas.__pointer = { x: 210, y: 170 };
el.fire('mousemove', { clientX: 210, clientY: 170 });
check('回到画布后 mousemove 恢复显示', preview().visible === true);

// ── 4. 画布重建（canvas:restored）后立即按最后位置恢复，无需鼠标再动 ──
const oldPreview = preview();
canvas.clear(); // 模拟 loadFromJSON 清空对象
check('画布清空后旧预览已不在画布上', canvas.getObjects().indexOf(oldPreview) === -1);
eventBus.emit('canvas:restored');
check('canvas:restored 后重建预览引用', !!preview() && preview() !== oldPreview);
check('重建后立即可见，无需鼠标移动', preview().visible === true);
check('重建位置沿用最后指针', preview().left === 210 && preview().top === 170);
check('重建后的预览已加入画布', canvas.getObjects().includes(preview()));

// ── 5. 缩放后重定位（canvas:zoomChanged）同样无需鼠标再动 ──
canvas.clear();
eventBus.emit('canvas:zoomChanged', 2);
check('canvas:zoomChanged 后预览重建且可见', !!preview() && preview().visible === true);

// ── 6. 重复 activate 不重复绑定、不残留监听 ──
brush.activate();
check('重复 activate 后 Fabric mouse:down 监听不重复', canvas.fabricListenerCount('mouse:down') === 1);
check('重复 activate 后 mouseenter 监听不重复', el.listenerCount('mouseenter') === 1);
check('重复 activate 后 mousemove 监听不重复', el.listenerCount('mousemove') === 1);
check('重复 activate 后 mouseleave 监听不重复', el.listenerCount('mouseleave') === 1);

// ── 7. deactivate 解绑全部监听并清理预览 ──
brush.deactivate();
check('deactivate 后 mousemove 监听清零', el.listenerCount('mousemove') === 0);
check('deactivate 后 mouseenter 监听清零', el.listenerCount('mouseenter') === 0);
check('deactivate 后 mouseleave 监听清零', el.listenerCount('mouseleave') === 0);
check('deactivate 后 Fabric mouse:down 监听清零', canvas.fabricListenerCount('mouse:down') === 0);
check('deactivate 后预览引用清空', preview() === null);

console.log(`\n[画笔光标门禁] ${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
