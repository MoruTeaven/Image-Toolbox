/**
 * 跨图层对齐/分布回归验证（独立门禁，pnpm build 不调用）。
 *
 * 用法：node scripts/verify-align-distribute.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 *
 * 守护的回归（对齐/分布验收标准，任务卡 t-mumi5hpq-00zfnn）：
 *
 * A) 坐标系统一：SelectModule 的对齐/分布必须全部以画布坐标
 *    （getBoundingRect(true)）计算。getBoundingRect() 默认返回视口坐标
 *    （已含 viewportTransform 缩放平移），而对象 left/top 是画布坐标；
 *    用户缩放/平移画布后混算两者会得到成比例错位的结果。这一缺陷在
 *    vpt=identity 的 mock 场景里完全不可见，必须用真 fabric + 非恒等
 *    viewportTransform 才能暴露。
 *
 * B) 对齐语义：多选以选择组包围盒为基准（6 模式），单选退化为对齐画布
 *    文档边缘 [0, W] × [0, H]（而非屏幕视口），与 PS「对齐画布」一致，
 *    且与当前缩放平移状态无关。
 *
 * C) 等距分布：≥3 个对象按中心点排序，首尾固定，其余等间距；<3 禁用。
 *
 * D) 旋转/缩放对象：以 AABB（外接矩形）参与计算，对齐只平移不改
 *    angle/scale/flip。
 *
 * E) 撤销/重做：走 HistoryManager 快照（改动前 saveState）。
 *
 * F) 变异自验：把 getBoundingRect(true) 临时退化回 getBoundingRect()
 *    （即旧行为），缩放场景断言必须失败——证明本脚本不是「空洞断言」。
 *    变异前后源文件逐字节恢复。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom } from './test-env.mjs';
import { readVendorSource, wrapFabric } from './lib/vendor-wrapper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── 真 fabric 5.3.0 装载（与 verify-clip-path-session.mjs 同一模式）──

installDom();
globalThis.Document = class Document {};
globalThis.HTMLDocument = class HTMLDocument extends globalThis.Document {};
globalThis.Element = class Element {};
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
if (!globalThis.document.implementation) {
  globalThis.document.implementation = { createHTMLDocument: () => globalThis.document };
}

const ctxStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') { return {}; }
    return () => {};
  },
  set() { return true; }
});
const styleStub = new Proxy({}, {
  get() { return () => {}; },
  set() { return true; }
});
function makeElementStyleWritable(el) {
  Object.defineProperty(el, 'style', {
    configurable: true,
    get() { return styleStub; },
    set(v) { this.__style = v; }
  });
  return el;
}

const origCreateElement = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.createElement = (tag) => {
  const el = makeElementStyleWritable(origCreateElement(tag));
  if (tag === 'canvas') { el.getContext = () => ctxStub; }
  return el;
};

const wrapped = wrapFabric(readVendorSource(ROOT).fabric);
const imported = await import(`data:text/javascript;base64,${Buffer.from(wrapped, 'utf8').toString('base64')}`);
const fabric = imported.default || imported.fabric;
globalThis.fabric = fabric;

check('真 fabric 5.3.0 已载入', fabric && fabric.version === '5.3.0', 'version=' + (fabric && fabric.version));

fabric.util.createCanvasElement = () => ({
  width: 0,
  height: 0,
  style: {},
  getContext: () => ctxStub,
  setAttribute() {},
  getAttribute() { return null; },
  addEventListener() {},
  removeEventListener() {}
});

let elSeq = 0;
const fabricEls = new Map();
const origGetElementById = globalThis.document.getElementById.bind(globalThis.document);
globalThis.document.getElementById = (id) => fabricEls.get(id) || origGetElementById(id);

function makeFabricCanvas(width = 400, height = 300) {
  elSeq += 1;
  const id = `align-gate-canvas-${elSeq}`;
  const el = makeElementStyleWritable(origCreateElement('canvas'));
  el.id = id;
  el.getContext = () => ctxStub;
  el.setAttribute = () => {};
  el.getAttribute = () => null;
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  fabricEls.set(id, el);
  return new fabric.Canvas(id, { width, height });
}

function makeRect(left, top, width, height, extra = {}) {
  // 默认去掉 strokeWidth（fabric Rect 默认 1 会被计入 getBoundingRect 宽高，
  // 使 right/bottom/center 期望值整体偏移 0.5）；stroke 语义单独在第 1b 组锚定。
  return new fabric.Rect({ left, top, width, height, strokeWidth: 0, fill: '#888', ...extra });
}

/** 丢弃选区，返回每个对象的画布坐标 AABB（验证前先脱离选择组坐标空间）。 */
function aabbs(canvas, objects) {
  canvas.discardActiveObject();
  objects.forEach(o => o.setCoords());
  return objects.map(o => o.getBoundingRect(true));
}

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ── 模块装载 ──

const { default: SelectModule } = await import('../core/src/modules/SelectModule.js');
const { default: HistoryManager } = await import('../core/src/HistoryManager.js');

/** cm 桥：SelectModule/HistoryManager 需要的最小 CanvasManager 接口（真 fabric 画布）。 */
function makeCmBridge(canvas) {
  return {
    canvas,
    originalImage: null,
    toJSON: () => canvas.toJSON(),
    fromJSON: (json) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('loadFromJSON 超时')), 5000);
      canvas.loadFromJSON(json, () => {
        clearTimeout(timer);
        canvas.getObjects().forEach(o => o.setCoords());
        canvas.renderAll();
        resolve();
      });
    }),
  };
}

// ── 1. 坐标语义锚定：钉住 fabric 5.3.0 的 getBoundingRect 行为 ──

section('1. fabric getBoundingRect 坐标语义锚定');

{
  const canvas = makeFabricCanvas();
  const rect = makeRect(100, 50, 60, 40);
  canvas.add(rect);

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  const identity = rect.getBoundingRect();
  const identityAbs = rect.getBoundingRect(true);
  check('vpt=identity 时两种取法相等', near(identity.left, identityAbs.left) && near(identity.top, identityAbs.top));

  canvas.setViewportTransform([2, 0, 0, 2, 80, 40]);
  const viewport = rect.getBoundingRect();
  const absolute = rect.getBoundingRect(true);
  check('视口取法含 viewportTransform（left=280）', near(viewport.left, 80 + 2 * 100), `left=${viewport.left}`);
  check('absolute 取法仍是画布坐标（left=100）', near(absolute.left, 100), `left=${absolute.left}`);
  check('缩放平移后两种取法显著不同', !near(viewport.left, absolute.left));
}

// ── 1b. strokeWidth 计入 AABB 的语义锚定 ──

section('1b. strokeWidth 计入 AABB 语义锚定（真实默认对象）');

{
  const canvas = makeFabricCanvas();
  const rect = makeRect(100, 50, 60, 40, { strokeWidth: 1 });
  canvas.add(rect);
  const b = rect.getBoundingRect(true);
  check('默认描边对象 AABB 宽高含 strokeWidth（61×41）', near(b.width, 61) && near(b.height, 41),
    `${b.width}×${b.height}`);

  // 对齐贴齐语义不受 stroke 影响：两个带默认描边的对象左对齐后 AABB left 一致。
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const other = makeRect(220, 150, 50, 30, { strokeWidth: 1 });
  canvas.add(other);
  canvas.setActiveObject(new fabric.ActiveSelection([rect, other], { canvas }));
  mod.applyPreset('select-align-left');
  const [ba, bb] = aabbs(canvas, [rect, other]);
  check('带描边对象左对齐仍以 AABB 贴齐', near(ba.left, bb.left) && near(ba.left, 100),
    `a=${ba.left} b=${bb.left}`);
}

// ── 2. 多选对齐 6 模式（identity vpt，真实 ActiveSelection 路径）──

section('2. 多选对齐 6 模式（ActiveSelection 路径）');

const G2_CASES = [
  { mode: 'select-align-left', axis: 'left' },
  { mode: 'select-align-hcenter', axis: 'hcenter' },
  { mode: 'select-align-right', axis: 'right' },
  { mode: 'select-align-top', axis: 'top' },
  { mode: 'select-align-vcenter', axis: 'vcenter' },
  { mode: 'select-align-bottom', axis: 'bottom' },
];

for (const { mode, axis } of G2_CASES) {
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(100, 80, 60, 40);
  const b = makeRect(220, 150, 50, 30);
  canvas.add(a, b);

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
  mod.applyPreset(mode);

  const [ba, bb] = aabbs(canvas, [a, b]);
  const assertBy = {
    left: () => near(ba.left, bb.left) && near(ba.left, 100),
    hcenter: () => near((ba.left + ba.width / 2), (bb.left + bb.width / 2)) && near(bb.left + bb.width / 2, 185),
    right: () => near(ba.left + ba.width, bb.left + bb.width) && near(ba.left + ba.width, 270),
    top: () => near(ba.top, bb.top) && near(ba.top, 80),
    vcenter: () => near((ba.top + ba.height / 2), (bb.top + bb.height / 2)) && near(bb.top + bb.height / 2, 130),
    bottom: () => near(ba.top + ba.height, bb.top + bb.height) && near(ba.top + ba.height, 180),
  }[axis];
  check(`多选 ${mode}：两对象基准线一致且落在期望值`, assertBy(),
    `a=(${ba.left.toFixed(1)},${ba.top.toFixed(1)}) b=(${bb.left.toFixed(1)},${bb.top.toFixed(1)})`);
}

// ── 3. viewportTransform 缩放平移下的对齐（本回归的核心场景）──

section('3. 缩放平移状态下对齐（画布坐标一致性）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(100, 50, 60, 40);
  const b = makeRect(200, 120, 50, 30);
  canvas.add(a, b);

  // scale=2 + 平移(80,40)：视口坐标与画布坐标相差一个 2x 缩放与平移项。
  canvas.setViewportTransform([2, 0, 0, 2, 80, 40]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
  mod.applyPreset('select-align-left');

  const [ba, bb] = aabbs(canvas, [a, b]);
  check('缩放平移下左对齐：两对象画布坐标 AABB left 均为 100',
    near(ba.left, 100) && near(bb.left, 100), `a=${ba.left} b=${bb.left}`);

  const [va, vb] = [a.getBoundingRect(), b.getBoundingRect()];
  check('缩放平移下屏幕视口同样贴齐（left=280）',
    near(va.left, 280) && near(vb.left, 280), `a=${va.left} b=${vb.left}`);

  check('对齐未改变对象 angle/scale', near(a.angle, 0) && near(a.scaleX, 1) && near(b.scaleX, 1));
}

{
  // 纯缩放（无平移）：旧实现会把 B 错移到 left=0。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(100, 50, 60, 40);
  const b = makeRect(200, 120, 50, 30);
  canvas.add(a, b);

  canvas.setViewportTransform([2, 0, 0, 2, 0, 0]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
  mod.applyPreset('select-align-left');

  const [ba, bb] = aabbs(canvas, [a, b]);
  check('纯缩放下左对齐结果正确（B.left=100 而非 0）',
    near(ba.left, 100) && near(bb.left, 100), `a=${ba.left} b=${bb.left}`);
}

{
  // 垂直居中同样受 vpt 影响的场景。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(100, 80, 60, 40);
  const b = makeRect(220, 150, 50, 30);
  canvas.add(a, b);

  canvas.setViewportTransform([0.5, 0, 0, 0.5, -30, 60]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
  mod.applyPreset('select-align-vcenter');

  const [ba, bb] = aabbs(canvas, [a, b]);
  const midA = ba.top + ba.height / 2;
  const midB = bb.top + bb.height / 2;
  check('缩小平移下垂直居中：两对象画布坐标中线均为 130',
    near(midA, 130) && near(midB, 130), `a=${midA} b=${midB}`);
}

// ── 4. 单选对齐画布 ──

section('4. 单选对齐画布（基准 = 画布文档边缘）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const c = makeRect(300, 250, 40, 30);
  canvas.add(c);

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(c);
  mod.applyPreset('select-align-left');
  check('单选左对齐贴画布左边（left=0）', near(aabbs(canvas, [c])[0].left, 0));

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(c);
  mod.applyPreset('select-align-top');
  check('单选顶对齐贴画布顶边（top=0）', near(aabbs(canvas, [c])[0].top, 0));

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(c);
  mod.applyPreset('select-align-right');
  const rc = aabbs(canvas, [c])[0];
  check('单选右对齐贴画布右边（right=400）', near(rc.left + rc.width, 400), `right=${rc.left + rc.width}`);

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(c);
  mod.applyPreset('select-align-bottom');
  const bc = aabbs(canvas, [c])[0];
  check('单选底对齐贴画布底边（bottom=300）', near(bc.top + bc.height, 300), `bottom=${bc.top + bc.height}`);
}

{
  // 关键：缩放平移后，单选对齐画布仍贴画布文档边缘，而不是屏幕视口。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const d = makeRect(300, 250, 40, 30);
  canvas.add(d);

  canvas.setViewportTransform([2, 0, 0, 2, 80, 40]);
  canvas.setActiveObject(d);
  mod.applyPreset('select-align-left');

  const ad = aabbs(canvas, [d])[0];
  check('缩放平移下单选左对齐仍贴画布文档左边（left=0）', near(ad.left, 0), `left=${ad.left}`);
  check('缩放平移下单选左对齐未贴到屏幕视口左边（left≠-40）', !near(ad.left, -40));
}

// ── 5. 等距分布 ──

section('5. 等距分布（水平/垂直，中心点等距）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(40, 10, 20, 20);   // 中心 x=50
  const b = makeRect(80, 10, 20, 20);   // 中心 x=90（应被移到 150）
  const c = makeRect(240, 10, 20, 20);  // 中心 x=250
  canvas.add(a, b, c);

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b, c], { canvas }));
  mod.applyPreset('select-distribute-h');

  const centers = aabbs(canvas, [a, b, c]).map(r => r.left + r.width / 2);
  check('水平分布：三中心 50/150/250 等距', near(centers[0], 50) && near(centers[1], 150) && near(centers[2], 250),
    `centers=${centers.map(v => v.toFixed(1)).join('/')}`);
}

{
  // 输入顺序打乱：必须按中心排序后再分布。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(240, 10, 20, 20);  // 中心 x=250
  const b = makeRect(40, 10, 20, 20);   // 中心 x=50
  const c = makeRect(80, 10, 20, 20);   // 中心 x=90
  canvas.add(a, b, c);

  canvas.setActiveObject(new fabric.ActiveSelection([a, b, c], { canvas }));
  mod.applyPreset('select-distribute-h');

  const centers = aabbs(canvas, [a, b, c]).map(r => r.left + r.width / 2).sort((x, y) => x - y);
  check('水平分布（乱序输入）：排序后中心 50/150/250',
    near(centers[0], 50) && near(centers[1], 150) && near(centers[2], 250),
    `centers=${centers.map(v => v.toFixed(1)).join('/')}`);
}

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(10, 20, 20, 20);   // 中心 y=30
  const b = makeRect(10, 200, 20, 20);  // 中心 y=210
  const c = makeRect(10, 80, 20, 20);   // 中心 y=90（应被移到 120）
  canvas.add(a, b, c);

  canvas.setActiveObject(new fabric.ActiveSelection([a, b, c], { canvas }));
  mod.applyPreset('select-distribute-v');

  const centers = aabbs(canvas, [a, b, c]).map(r => r.top + r.height / 2).sort((x, y) => x - y);
  check('垂直分布：三中心 30/120/210 等距', near(centers[0], 30) && near(centers[1], 120) && near(centers[2], 210),
    `centers=${centers.map(v => v.toFixed(1)).join('/')}`);
}

{
  // 缩放 vpt 下分布：结果必须与画布坐标一致（与视图状态无关）。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(40, 10, 20, 20);
  const b = makeRect(80, 10, 20, 20);
  const c = makeRect(240, 10, 20, 20);
  canvas.add(a, b, c);

  canvas.setViewportTransform([2, 0, 0, 2, 0, 0]);
  canvas.setActiveObject(new fabric.ActiveSelection([a, b, c], { canvas }));
  mod.applyPreset('select-distribute-h');

  const centers = aabbs(canvas, [a, b, c]).map(r => r.left + r.width / 2);
  check('缩放下水平分布：三中心 50/150/250（B 中心不被错移到 250）',
    near(centers[0], 50) && near(centers[1], 150) && near(centers[2], 250),
    `centers=${centers.map(v => v.toFixed(1)).join('/')}`);
}

// ── 6. 旋转/缩放对象 ──

section('6. 已旋转/已缩放对象（AABB 语义）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const e = makeRect(50, 50, 100, 50, { angle: 30 });
  const f = makeRect(250, 100, 60, 60, { angle: -20 });
  canvas.add(e, f);

  canvas.setActiveObject(new fabric.ActiveSelection([e, f], { canvas }));
  mod.applyPreset('select-align-left');

  const [be, bf] = aabbs(canvas, [e, f]);
  check('旋转对象左对齐：AABB 左边贴齐', near(be.left, bf.left), `e=${be.left.toFixed(2)} f=${bf.left.toFixed(2)}`);
  check('旋转对象 angle 未被改动', near(e.angle, 30) && near(f.angle, -20));
}

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const e = makeRect(30, 30, 100, 50, { scaleX: 1.5, scaleY: 0.8 });
  const f = makeRect(260, 120, 60, 60);
  canvas.add(e, f);

  canvas.setActiveObject(new fabric.ActiveSelection([e, f], { canvas }));
  mod.applyPreset('select-align-top');

  const [be, bf] = aabbs(canvas, [e, f]);
  check('缩放对象顶对齐：AABB 顶边贴齐', near(be.top, bf.top), `e=${be.top.toFixed(2)} f=${bf.top.toFixed(2)}`);
  check('缩放对象 scaleX/scaleY 未被改动', near(e.scaleX, 1.5) && near(e.scaleY, 0.8));
  check('缩放对象 AABB 宽 = 100×1.5', near(be.width, 150), `width=${be.width}`);
}

// ── 7. 撤销/重做（真 HistoryManager 快照）──

section('7. 撤销/重做（HistoryManager 快照）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(100, 50, 60, 40);
  const b = makeRect(200, 120, 50, 30);
  canvas.add(a, b);

  canvas.setViewportTransform([2, 0, 0, 2, 80, 40]);
  const aLeftBefore = a.left;
  const bLeftBefore = b.left;

  canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
  mod.applyPreset('select-align-left');

  const moved = aabbs(canvas, [a, b]);
  check('对齐生效（撤销前提）', near(moved[0].left, 100) && near(moved[1].left, 100));
  check('saveState 已在对齐前入栈', history.canUndo());

  await history.undo();
  // loadFromJSON 会用新实例替换旧对象，必须从画布重取，不能沿用旧引用。
  const [ua, ub] = canvas.getObjects();
  check('撤销后恢复原始位置', near(ua.left, aLeftBefore) && near(ub.left, bLeftBefore),
    `a=${ua.left} b=${ub.left}`);
  check('撤销后可重做', history.canRedo());

  await history.redo();
  const [ra, rb] = canvas.getObjects();
  const redone = aabbs(canvas, [ra, rb]);
  check('重做后重新对齐', near(redone[0].left, 100) && near(redone[1].left, 100),
    `a=${redone[0].left} b=${redone[1].left}`);
}

{
  // 分布同样可撤销。
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);
  const a = makeRect(40, 10, 20, 20);
  const b = makeRect(80, 10, 20, 20);
  const c = makeRect(240, 10, 20, 20);
  canvas.add(a, b, c);
  const bLeftBefore = b.left;

  canvas.setActiveObject(new fabric.ActiveSelection([a, b, c], { canvas }));
  mod.applyPreset('select-distribute-h');
  // applyPreset 返回后对象在重建的选区里（坐标为组内相对值），先 discard 再取画布坐标。
  const dist = aabbs(canvas, [a, b, c]);
  check('分布生效（撤销前提）', near(dist[1].left, 140), `b.left=${dist[1].left}`);

  await history.undo();
  const ub = canvas.getObjects()[1];
  check('分布撤销后恢复原始位置', near(ub.left, bLeftBefore), `b.left=${ub.left}`);
}

// ── 8. 选项栏入口 ──

section('8. 选项栏入口（按钮组与禁用态）');

{
  const canvas = makeFabricCanvas();
  const cm = makeCmBridge(canvas);
  const history = new HistoryManager(cm);
  const mod = new SelectModule(cm, history);

  const htmlNone = mod.getOptionsBarHTML();
  const count = (re) => (htmlNone.match(re) || []).length;
  check('HTML 含 6 个对齐按钮', count(/data-preset="select-align-/g) === 6);
  check('HTML 含 2 个分布按钮', count(/data-preset="select-distribute-/g) === 2);
  check('无选中时按钮禁用', count(/data-preset="select-align-[a-z]+" disabled/g) === 6);

  const one = makeRect(10, 10, 20, 20);
  canvas.add(one);
  canvas.setActiveObject(one);
  const htmlOne = mod.getOptionsBarHTML();
  check('单选时对齐可用', !/data-preset="select-align-[a-z]+" disabled/.test(htmlOne));
  check('单选时分布禁用（<3 个）', /data-preset="select-distribute-[hv]" disabled/.test(htmlOne));

  const two = makeRect(60, 10, 20, 20);
  const three = makeRect(120, 10, 20, 20);
  canvas.add(two, three);
  canvas.setActiveObject(new fabric.ActiveSelection([one, two, three], { canvas }));
  const htmlThree = mod.getOptionsBarHTML();
  check('三选时分布可用', !/data-preset="select-distribute-[hv]" disabled/.test(htmlThree));
}

// ── 9. 源码级断言 ──

section('9. 源码级断言（坐标约定固化）');

const SELECT_PATH = path.join(ROOT, 'core/src/modules/SelectModule.js');
const selectSrc = fs.readFileSync(SELECT_PATH, 'utf8');

check('_alignTargets/_distributeTargets 使用画布坐标 getBoundingRect(true)',
  (selectSrc.match(/getBoundingRect\(true\)/g) || []).length >= 2,
  `出现 ${(selectSrc.match(/getBoundingRect\(true\)/g) || []).length} 次`);
// 只查真实调用（.getBoundingRect()），避免误伤注释里的文字描述。
check('源码中不存在无参 .getBoundingRect()（视口坐标）调用',
  !/\.getBoundingRect\(\)/.test(selectSrc));
check('源码含画布坐标约定注释', selectSrc.includes('画布坐标') && selectSrc.includes('viewportTransform'));
check('对齐入口为选项栏按钮组（data-preset select-align-*）',
  /data-preset="select-align-left"/.test(selectSrc) && /_alignTargets\(targets, alignMap\[presetName\]\)/.test(selectSrc));

// ── 10. 变异自验：退化回视口坐标时回归套件必须失败 ──

section('10. 变异自验（防空洞断言）');

{
  const originalBytes = fs.readFileSync(SELECT_PATH);
  const mutated = selectSrc.replace(/getBoundingRect\(true\)/g, 'getBoundingRect()');
  if (mutated === selectSrc) {
    check('变异注入成功（找到变异点）', false, '未找到 getBoundingRect(true)，锚点失配');
  } else {
    let variantFailed = false;
    let variantDetail = '';
    try {
      const variantPath = path.join(ROOT, 'core/src/modules/.verify-align-variant.mjs');
      fs.writeFileSync(variantPath, mutated);
      try {
        const { default: MutatedSelectModule } = await import(variantPath);
        // 场景复刻第 3 组「缩放平移下左对齐」：旧实现必然错位。
        const canvas = makeFabricCanvas();
        const cm = makeCmBridge(canvas);
        const history = new HistoryManager(cm);
        const mod = new MutatedSelectModule(cm, history);
        const a = makeRect(100, 50, 60, 40);
        const b = makeRect(200, 120, 50, 30);
        canvas.add(a, b);
        canvas.setViewportTransform([2, 0, 0, 2, 80, 40]);
        canvas.setActiveObject(new fabric.ActiveSelection([a, b], { canvas }));
        mod.applyPreset('select-align-left');
        const [ba, bb] = aabbs(canvas, [a, b]);
        if (near(ba.left, 100) && near(bb.left, 100)) {
          variantFailed = false;
          variantDetail = `变异版竟然也对齐正确（a=${ba.left} b=${bb.left}），断言抓不住该回归`;
        } else {
          variantFailed = true;
          variantDetail = `变异版如预期错位（a=${ba.left.toFixed(1)} b=${bb.left.toFixed(1)}）`;
        }
      } finally {
        fs.rmSync(variantPath, { force: true });
      }
    } catch (err) {
      variantFailed = true;
      variantDetail = `变异执行异常（视为捕获到行为变化）：${err.message}`;
    }
    check('变异版在缩放场景下错位（断言能抓住回归）', variantFailed, variantDetail);
  }

  // 逐字节恢复校验。
  const restored = fs.readFileSync(SELECT_PATH);
  check('变异后源文件逐字节恢复', restored.equals(originalBytes));
}

// ── 汇总 ──

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.error('\n失败清单:');
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
}
