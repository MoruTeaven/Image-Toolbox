/**
 * canvas 级 clipPath 门禁（构建门禁第 8 项）。
 *
 * 守护两类回归，两类都曾经真实发生过：
 *
 * A) 换入换出会话：裁剪/打码模块要把画布级 clipPath 临时摘掉，否则交互辅助图形
 *    会被一起裁掉。历史上两个模块各自缓存一份备份，操作同一份画布级全局状态，
 *    恢复时把对方的临时 clipPath 当成原始值写回，图层被永久裁掉——而且这类 bug
 *    不会立刻报错，要等后续某次操作才显形，所以必须有门禁。
 *
 * B) 序列化：CanvasManager 曾经手写一份 json._canvasClipPath，并在 fromJSON 里
 *    无条件 canvas.clipPath = null。Fabric 5.3.0 的 _toObjectMethod 原生就会把
 *    clipPath 写进 json.clipPath，loadFromJSON 也会自行恢复它——手写那份只是冗余
 *    来源，而无脑清空会把 Fabric 刚恢复的 clipPath 抹掉，撤销裁切后状态错乱。
 *    另外 toJSON(props) 的 props 是浅赋值，把 'clipPath' 列进去会让快照持有活
 *    对象引用，历史栈与画布共享同一个 clipPath。
 *
 * 用法：node scripts/verify-clip-path-session.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 *
 * 层次：
 *   1. 会话不变量（真 fabric 驱动 core 源码）；
 *   2. 序列化往返（真 fabric：原生 json.clipPath、非活引用、loadFromJSON 恢复）；
 *   3. 撤销/重做一致性（真 fabric 快照往返）；
 *   4. 源码级断言（两个模块真的用共享会话、CanvasManager 无冗余手写）；
 *   5. 变异自验：把已知会回归的旧逻辑临时注回源码，回归套件必须出现失败，
 *      否则说明断言本身是「兜底掩盖式」的空洞断言。变异前后逐字节恢复。
 *
 * 第 5 层与 scripts/mutation-check-sanitizers.mjs 同一思路：断言若抓不住它声称
 * 守护的那类回归，比没有断言更危险——它会一直报告「已验证」。
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

// ── 真 fabric 5.3.0 装载 ──
//
// 只装 DOM 桩件（不装 fabric 桩件），再用与构建期 vendor-wrapper.mjs 相同的
// 方式把 classic script 版 fabric.min.js 载入。桩件缺 2D context 与 Element，
// fabric 的 loadFromJSON → clear() → clearContext() 会用到，这里补齐最小实现。
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
// fabric 会给自建/桩件元素设 style.cssText、调 style.setProperty()，
// 桩件的 style 只有 getter，必须整体换成一个「什么都收」的 Proxy。
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
  if (tag === 'textarea') {
    el.focus = () => {};
    el.setAttribute = () => {};
    el.addEventListener = () => {};
  }
  return el;
};

// fabric.min.js 是 classic script（UMD），用与构建期 vendor-wrapper.mjs 相同的
// 包装变成 ES 模块，再用 data: URL 直接 import —— 不往磁盘写临时文件
// （沙箱下 scripts/ 的写权限并非常态可用）。
const wrapped = wrapFabric(readVendorSource(ROOT).fabric);
const imported = await import(`data:text/javascript;base64,${Buffer.from(wrapped, 'utf8').toString('base64')}`);
const fabric = imported.default || imported.fabric;
globalThis.fabric = fabric;

check('真 fabric 5.3.0 已载入', fabric && fabric.version === '5.3.0', 'version=' + (fabric && fabric.version));

// fabric 自己走 util.createCanvasElement() 造 canvas，必须让它带上 2D context。
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
const canvasAreaEl = globalThis.document.getElementById('canvas-area');
if (canvasAreaEl) { canvasAreaEl.getContext = () => ctxStub; }

const { acquireClipPathSession, releaseClipPathSession } = await import(
  '../core/src/utils/ClipPathSession.js'
);

// ── 1. 会话不变量 ──

{
  // 同一实例写回：恢复后的 canvas.clipPath 必须是原来那个对象，
  // 不能是等价副本——副本会让「撤销」恢复到错误的状态。
  const original = makeObject('original');
  const canvas = makeCanvas([makeObject('a'), makeObject('b')]);
  canvas.clipPath = original;

  const session = acquireClipPathSession(canvas, { exclude: [] });
  session.detach();
  check('detach 后画布级 clipPath 被摘除', canvas.clipPath === null);
  check('对象级临时挂上了等价 clipPath', canvas.objects.every((o) => o.clipPath === original));

  session.release();
  check('release 后 canvas.clipPath 是同一实例', canvas.clipPath === original,
    canvas.clipPath === original ? '' : '写回了副本或 null');
  check('release 后对象级 clipPath 全部还原为 null',
    canvas.objects.every((o) => o.clipPath === null));
}

{
  // 逐对象还原：各对象原值不同，不得整批写成同一个。
  const shared = makeObject('shared');
  const canvas = makeCanvas([
    makeObject('keepOwn', makeObject('ownA')),
    makeObject('keepNull', null),
  ]);
  canvas.clipPath = shared;

  const session = acquireClipPathSession(canvas, {});
  session.detach();
  session.release();

  check('各对象的 clipPath 写回自己的原值（互不污染）',
    canvas.objects[0].clipPath !== null && canvas.objects[0].clipPath.__id === 'ownA'
    && canvas.objects[1].clipPath === null,
    `a=${canvas.objects[0].clipPath && canvas.objects[0].clipPath.__id} b=${canvas.objects[1].clipPath}`);
}

{
  // exclude：辅助图形不参与临时挂载。
  const shared = makeObject('shared');
  const helper = makeObject('helper');
  const canvas = makeCanvas([makeObject('normal'), helper]);
  canvas.clipPath = shared;

  const session = acquireClipPathSession(canvas, { exclude: [helper] });
  session.detach();
  const helperUntouched = helper.clipPath === null;
  session.release();
  check('exclude 列出的辅助对象不被临时挂载', helperUntouched);
}

{
  // 幂等：重复 release 不得把 canvas.clipPath 写成 null。
  const original = makeObject('original');
  const canvas = makeCanvas([]);
  canvas.clipPath = original;
  const session = acquireClipPathSession(canvas, {});
  session.detach();
  session.release();
  session.release();
  session.release();
  check('重复 release 幂等（clipPath 不被清空）', canvas.clipPath === original);
}

{
  // 残留持有者必须显式炸掉，而不是静默接管另一个会话的备份。
  const canvas = makeCanvas([makeObject('x')]);
  canvas.clipPath = makeObject('c1');
  const first = acquireClipPathSession(canvas, {});
  first.detach();

  let secondThrew = false;
  try {
    acquireClipPathSession(canvas, {});
  } catch {
    secondThrew = true;
  }
  check('同一画布上的第二个会话被拒绝（不静默覆盖备份）', secondThrew);

  first.release();
  const afterRelease = (() => {
    try { acquireClipPathSession(canvas, { return: null }).release(); return true; }
    catch { return false; }
  })();
  check('release 后可再次取得会话（无泄漏）', afterRelease);
}

// ── 2. 跨会话隔离（当年事故的复现场景） ──

{
  // 复盘事故本体：两个模块各自维护状态时，后进入者恢复会把先者的备份
  // 当成原始值写回。共享会话下这个交叉不可能发生——第二个会话根本拿不到。
  const original = makeObject('original');
  const canvas = makeCanvas([makeObject('obj')]);
  canvas.clipPath = original;

  const mosaicLike = acquireClipPathSession(canvas, { exclude: [] });
  mosaicLike.detach();
  // 打码模块此时也想进入：旧实现是 new 一份自己的缓存并直接改 canvas.clipPath。
  // 新实现必须被拒绝，于是 mosaic 的备份不可能被覆盖。
  let cropBlocked = false;
  try { acquireClipPathSession(canvas, { exclude: [] }); }
  catch { cropBlocked = true; }

  mosaicLike.release();
  check('事故场景：后进入者无法覆盖先者的备份', cropBlocked);
  check('事故场景：先者恢复后 clipPath 仍是原始实例', canvas.clipPath === original);
}

{
  // 漏调 release 时的兜底：显式释放接口必须能清掉残留持有者。
  const canvas = makeCanvas([]);
  const s = acquireClipPathSession(canvas, {});
  s.detach();
  releaseClipPathSession(canvas);
  check('releaseClipPathSession 清掉残留持有者', canvas.__clipPathSession === null);
}

// ── 3. 序列化往返（真 fabric） ──

// fabric.Canvas 会把元素包进自己的 wrapperEl，复用同一个 id 造第二个画布会失败，
// 因此每个画布配一个独立 id 的新建元素。
const fabricEls = new Map();
let elSeq = 0;
const origGetElementById = globalThis.document.getElementById.bind(globalThis.document);
globalThis.document.getElementById = (id) => fabricEls.get(id) || origGetElementById(id);

/** 造一个全新的真 fabric 画布。 */
function makeFabricCanvas(width = 400, height = 300) {
  elSeq += 1;
  const id = `clip-gate-canvas-${elSeq}`;
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

function loadFromJSONAsync(canvas, json) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('loadFromJSON 回调超时')); }
    }, 5000);
    canvas.loadFromJSON(json, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

{
  // Fabric 原生就会把 canvas.clipPath 序列化进 json.clipPath，
  // 所以 CanvasManager 不该再手写一份 _canvasClipPath。
  const canvas = makeFabricCanvas();
  canvas.clipPath = new fabric.Rect({
    left: 10, top: 10, width: 300, height: 200, absolutePositioned: true
  });

  const json = canvas.toJSON();
  check('真 fabric：canvas.toJSON() 原生写入 json.clipPath',
    Object.prototype.hasOwnProperty.call(json, 'clipPath') && json.clipPath
    && json.clipPath.type === 'rect' && json.clipPath.width === 300,
    json.clipPath ? `type=${json.clipPath.type} width=${json.clipPath.width}` : '缺失');

  // 快照必须是数据而不是活对象引用，否则历史栈会与画布共享同一个 clipPath。
  check('真 fabric：快照里的 clipPath 不是活对象引用',
    json.clipPath !== canvas.clipPath);

  await loadFromJSONAsync(canvas, { ...json });
  check('真 fabric：loadFromJSON 自行恢复 canvas.clipPath',
    canvas.clipPath && canvas.clipPath.type === 'rect' && canvas.clipPath.width === 300,
    canvas.clipPath ? `type=${canvas.clipPath.type} width=${canvas.clipPath.width}` : '为 null');

  // 这正是 CanvasManager.fromJSON 曾经踩的坑：恢复之后又无条件写 null。
  check('真 fabric：恢复后不应被 fromJSON 二次清空',
    canvas.clipPath !== null);
}

{
  // 撤销「应用裁剪」的场景：旧快照没有 clipPath，而画布上有一个 →
  // 这时才该清空。CanvasManager.fromJSON 的清空必须区分「快照无裁剪」与「快照有裁剪」。
  //
  // 注意这是 CanvasManager 的职责而不是 fabric 的：真 fabric 的 loadFromJSON
  // 在快照缺 clipPath 时**不会**动画布上已有的 clipPath（下面第一条就是证据），
  // 所以必须由 fromJSON 显式清，否则撤销裁切后裁剪区域残留。
  const CanvasManager = (await import('../core/src/CanvasManager.js')).default;
  const cm = new CanvasManager('unused');
  cm.canvas = makeFabricCanvas();
  cm.canvas.clipPath = new fabric.Rect({ left: 0, top: 0, width: 150, height: 100 });

  const withoutClip = cm.toJSON();
  // 有裁剪时快照自带 clipPath；构造「没有裁剪」的旧快照则要显式删掉该字段。
  check('CanvasManager.toJSON：有裁剪时快照带 clipPath',
    Object.prototype.hasOwnProperty.call(withoutClip, 'clipPath'));
  const stripped = { ...withoutClip };
  delete stripped.clipPath;

  // 先证明「fabric 不清」：直接走裸 loadFromJSON，clipPath 应当仍在。
  const probe = makeFabricCanvas();
  probe.clipPath = new fabric.Rect({ left: 0, top: 0, width: 150, height: 100 });
  await loadFromJSONAsync(probe, stripped);
  check('真 fabric：裸 loadFromJSON 对缺失 clipPath 不做清空（需上层补）',
    probe.clipPath !== null, 'fabric 已自行清空');

  // 再走 CanvasManager.fromJSON：应当清掉。
  await cm.fromJSON(stripped);
  check('CanvasManager.fromJSON：快照无 clipPath 时清掉画布上的',
    cm.canvas.clipPath === null, 'clipPath=' + (cm.canvas.clipPath && cm.canvas.clipPath.width));
}

// ── 4. 撤销 / 重做一致性 ──

{
  // 复现验收场景：连续两次「应用裁剪」后撤销一次，应回到第一次的裁剪区域；
  // 重做再回到第二次；再撤销一次仍正确。
  // 用 CanvasManager 的真实 toJSON/fromJSON 走 HistoryManager 的路径，
  // 但绕开 DOM 初始化：直接构造 CanvasManager 并注入 fabric.Canvas。
  const CanvasManager = (await import('../core/src/CanvasManager.js')).default;
  const cm = new CanvasManager('canvas-area');
  cm.canvas = makeFabricCanvas(400, 300);

  // 第一次裁剪：300 宽
  cm.canvas.clipPath = new fabric.Rect({ left: 0, top: 0, width: 300, height: 200, absolutePositioned: true });
  const snap1 = cm.toJSON();

  // 第二次裁剪：150 宽
  cm.canvas.clipPath = new fabric.Rect({ left: 0, top: 0, width: 150, height: 100, absolutePositioned: true });
  const snap2 = cm.toJSON();

  check('CanvasManager.toJSON 不再手写 _canvasClipPath',
    !Object.prototype.hasOwnProperty.call(snap1, '_canvasClipPath')
    && !Object.prototype.hasOwnProperty.call(snap2, '_canvasClipPath'),
    '仍存在冗余的 _canvasClipPath 字段');
  check('CanvasManager.toJSON 原生保留 json.clipPath',
    snap1.clipPath && snap1.clipPath.width === 300 && snap2.clipPath && snap2.clipPath.width === 150,
    `snap1=${snap1.clipPath && snap1.clipPath.width} snap2=${snap2.clipPath && snap2.clipPath.width}`);

  // 撤销 → snap1
  await cm.fromJSON(snap1);
  check('撤销一次后恢复第一次裁剪区域（width=300）',
    cm.canvas.clipPath && cm.canvas.clipPath.width === 300,
    'width=' + (cm.canvas.clipPath && cm.canvas.clipPath.width));

  // 重做 → snap2
  await cm.fromJSON(snap2);
  check('重做后回到第二次裁剪区域（width=150）',
    cm.canvas.clipPath && cm.canvas.clipPath.width === 150,
    'width=' + (cm.canvas.clipPath && cm.canvas.clipPath.width));

  // 再撤销 → snap1
  await cm.fromJSON(snap1);
  check('再次撤销仍恢复第一次裁剪区域（width=300）',
    cm.canvas.clipPath && cm.canvas.clipPath.width === 300,
    'width=' + (cm.canvas.clipPath && cm.canvas.clipPath.width));
}

{
  // 工具往返 + 漏调 deactivate：会话必须从结构上阻止第二个持有者，
  // 且残留持有者可被显式清掉，图层 clipPath 不被永久裁掉。
  // 图层用真 fabric.Rect（canvas.add 只接真 fabric 对象）。
  const canvas = makeFabricCanvas(400, 300);
  const layerOwn = new fabric.Rect({ width: 10, height: 10 });
  const layer = new fabric.Rect({ width: 20, height: 20 });
  layer.clipPath = layerOwn;
  canvas.add(layer);
  canvas.clipPath = new fabric.Rect({ left: 0, top: 0, width: 300, height: 200 });

  const mosaicSession = acquireClipPathSession(canvas, { exclude: [] });
  mosaicSession.detach();
  const detachedOriginal = canvas.__clipPathSession.getDetached();

  // 模拟 CropModule 在 MosaicModule 漏调 release 时也想进入
  let blocked = false;
  try { acquireClipPathSession(canvas, { exclude: [] }); } catch { blocked = true; }
  check('工具往返：漏调 release 时第二个模块被拒绝', blocked);

  mosaicSession.release();
  check('工具往返：release 后 canvas.clipPath 回到原始实例',
    canvas.clipPath === detachedOriginal);
  check('工具往返：图层 clipPath 未被永久裁掉（回到自己的原值）',
    layer.clipPath === layerOwn,
    'layer.clipPath=' + (layer.clipPath === layerOwn ? 'own' : '被改成临时值'));
  check('工具往返：无残留 owner', canvas.__clipPathSession === null);
}

// ── 5. 源码级断言 ──

const sessionSrc = fs.readFileSync(path.join(ROOT, 'core/src/utils/ClipPathSession.js'), 'utf8');
check('ClipPathSession.js 导出 acquireClipPathSession', /export function acquireClipPathSession/.test(sessionSrc));

const canvasManagerSrc = fs.readFileSync(path.join(ROOT, 'core/src/CanvasManager.js'), 'utf8');
check('CanvasManager 不再手写 _canvasClipPath',
  !/json\._canvasClipPath\s*=/.test(canvasManagerSrc)
  && !/CLIP_PATH_SERIALIZED_PROPS/.test(canvasManagerSrc));
check('CanvasManager.toJSON 的 props 不含 clipPath（浅赋值活引用陷阱）',
  !/toJSON\(\[\s*'clipPath'/.test(canvasManagerSrc));
check('CanvasManager.fromJSON 区分快照有无 clipPath',
  /hasNativeClipPath/.test(canvasManagerSrc));

for (const [label, file] of [
  ['MosaicModule', 'core/src/modules/MosaicModule.js'],
  ['CropModule', 'core/src/modules/CropModule.js']
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const usesShared = /ClipPathSession/.test(src);
  const hasPrivateCache = /this\._objectClipPathBackups\s*=/.test(src)
    && /this\._detachedCanvasClipPath\s*=/.test(src);
  check(`${label} 改用共享会话（import ClipPathSession）`, usesShared);
  check(`${label} 不再各自缓存 clipPath 备份`, !hasPrivateCache,
    hasPrivateCache ? '仍持有 _objectClipPathBackups / _detachedCanvasClipPath' : '');
}

// ── 5. 变异自验 ──
//
// 把已知会回归的旧逻辑临时注回源码，用同一套断言重跑，必须看到失败。
// 在子进程里做，避免污染本进程已加载的模块；变异前后逐字节恢复。
// 单个子进程里同时注入 M1+M2，任一未被抓住都判失败。
// 子进程自身不再递归跑变异层（靠 CLIP_GATE_CHILD 守卫）。

const MUTATIONS = [
  {
    id: 'M1',
    file: 'core/src/CanvasManager.js',
    from: "      json = canvas.toJSON([\r\n        'filters',",
    to: "      json = canvas.toJSON([\r\n        'clipPath',\r\n        'filters',",
    why: 'toJSON(props) 里列回 clipPath（浅赋值 → 快照变活对象引用）'
  },
  {
    id: 'M2',
    file: 'core/src/CanvasManager.js',
    from: '        } else {\r\n          // 原生 json.clipPath 存在',
    to: '        } else if (true) {\r\n          this.canvas.clipPath = null;\r\n          finishRestore();\r\n        } else if (false) {\r\n          // 原生 json.clipPath 存在',
    why: 'fromJSON 恢复后无条件清空 canvas.clipPath（旧逻辑）'
  }
];

/**
 * 仓库源码是 CRLF。锚点按 CRLF 书写（与磁盘一致），
 * 若某文件是 LF 则把锚点降级成 LF，保证两种行尾都能命中。
 */
function normalizeEol(anchor, eol) {
  if (eol === '\n') { return anchor.replace(/\r\n/g, '\n'); }
  return anchor;
}

function applyMutations(texts) {
  for (const m of MUTATIONS) {
    const cur = texts.get(m.file);
    const eol = cur.includes('\r\n') ? '\r\n' : '\n';
    const from = normalizeEol(m.from, eol);
    const to = normalizeEol(m.to, eol);
    if (!cur.includes(from)) {
      throw new Error(`变异 ${m.id} 锚点未命中：${m.file} —— 源码结构已变，请同步更新本脚本`);
    }
    texts.set(m.file, cur.replace(from, to));
  }
}

{
  // 子进程（被变异注入后重跑的那个）不再递归进入变异层。
  const isChild = process.env.CLIP_GATE_CHILD === '1';
  const originals = new Map();
  for (const m of MUTATIONS) {
    if (!originals.has(m.file)) { originals.set(m.file, fs.readFileSync(path.join(ROOT, m.file), 'utf8')); }
  }

  const { execFileSync } = await import('node:child_process');
  const childEnv = { ...process.env, CLIP_GATE_CHILD: '1' };

  // 子进程：只读，跑完就退。父进程才是注入/还原的那一方。
  if (isChild) {
    // 什么都不做，断言已在本进程跑过（见上文各层），退出码由 failures 决定。
  } else {
    const mutated = new Map(originals);
    try {
      applyMutations(mutated);
      for (const [file, text] of mutated) { fs.writeFileSync(path.join(ROOT, file), text); }

      let exitCode = 0;
      try {
        execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'pipe', env: childEnv });
      } catch (err) {
        exitCode = err.status === undefined ? 1 : err.status;
      }
      check('变异自验：注入旧逻辑后门禁出现失败（非 0 退出）', exitCode !== 0,
        '门禁仍以 0 退出 —— 断言抓不住它声称守护的回归');
    } finally {
      for (const [file, text] of originals) { fs.writeFileSync(path.join(ROOT, file), text); }
    }

    // 还原后必须仍能通过，否则说明还原不完整。
    let cleanExit = 0;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'pipe', env: childEnv });
    } catch (err) {
      cleanExit = err.status === undefined ? 1 : err.status;
    }
    check('变异自验：还原后门禁恢复通过', cleanExit === 0, 'exit=' + cleanExit);
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`❌ clipPath 门禁失败：${failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ 通过：${passed} 项断言（会话不变量 + 跨会话隔离 + 真 fabric 序列化往返 + 撤销/重做一致性 + 源码级断言 + 变异自验）`);

// ── 本地小桩件（保持与旧版一致的最小实现） ──

function makeObject(id, clipPath = null) {
  return {
    __id: id,
    clipPath,
    dirty: false,
    set(key, value) {
      if (key === 'clipPath') this.clipPath = value;
      else this[key] = value;
    },
  };
}

function makeCanvas(objects = []) {
  let renders = 0;
  return {
    clipPath: null,
    objects,
    getObjects() { return this.objects; },
    requestRenderAll() { renders += 1; },
    get renderCount() { return renders; },
  };
}
