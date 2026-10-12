/**
 * 页面内断言脚本 —— 橡皮擦「框选」模式真实浏览器像素级验证。
 *
 * 由 scripts/verify-eraser-rect-browser.mjs 通过 CDP Runtime.evaluate 注入执行，
 * 也可在手工打开页面后于 DevTools Console 中整体粘贴执行。
 *
 * 前置条件：window.__imageToolboxApp 已完成初始化（App 已挂载）。
 * 返回：{ checks: [{ name, pass, detail }] }
 */
(async () => {
'use strict';
const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = window.__imageToolboxApp;
const canvas = app.canvasManager.canvas;

const srcCanvas = document.createElement('canvas');
srcCanvas.width = 200;
srcCanvas.height = 160;
const sg = srcCanvas.getContext('2d');
sg.fillStyle = '#ff0000';
sg.fillRect(0, 0, 200, 160);
await app._loadImage(srcCanvas.toDataURL('image/png'));
await sleep(500);

const layer = new fabric.Rect({ left: 20, top: 20, width: 120, height: 100, fill: '#00ff00' });
canvas.add(layer);
canvas.setActiveObject(layer);
canvas.renderAll();
await sleep(100);

app.toolManager.activateTool('eraser');
const mod = app.toolManager.getModule('eraser');
check('默认仍是涂抹模式', mod.options.drawMode === 'brush', mod.options.drawMode);
mod.setDrawMode('rect');
check('可切换到框选模式', mod.options.drawMode === 'rect', mod.options.drawMode);

const toClient = (x, y) => {
  const r = canvas.upperCanvasEl.getBoundingClientRect();
  const v = canvas.viewportTransform;
  return { clientX: r.left + x * v[0] + y * v[2] + v[4], clientY: r.top + x * v[1] + y * v[3] + v[5] };
};
const fire = (type, x, y, buttons) => {
  const ev = toClient(x, y);
  ev.button = 0;
  ev.buttons = buttons;
  canvas.fire('mouse:' + type, { e: ev, target: null });
};

fire('down', 40, 40, 1);
check('按下出现选区辅助框', !!mod._selectionRect);
check('辅助框不进图层/历史', !!(mod._selectionRect && mod._selectionRect.excludeFromHistory === true && mod._selectionRect.excludeFromLayer === true));
fire('move', 100, 80, 1);
const sz = mod._selectionRect ? { w: mod._selectionRect.width, h: mod._selectionRect.height, l: mod._selectionRect.left, t: mod._selectionRect.top } : {};
check('拖动更新选区几何', Math.round(sz.w) === 60 && Math.round(sz.h) === 40 && Math.round(sz.l) === 40 && Math.round(sz.t) === 40, JSON.stringify(sz));
fire('up', 100, 80, 0);
await sleep(200);

let objects = canvas.getObjects();
check('松开后不残留辅助框', objects.every(o => !o.excludeFromHistory && !o.excludeFromLayer), objects.map(o => o.type).join(','));
check('图层数量保持 2', objects.length === 2, objects.length);
const target = objects[1];
check('目标图层固化为位图', target.type === 'image', target.type);

const el = target.getElement();
const elctx = el.getContext('2d');
const data = elctx.getImageData(0, 0, el.width, el.height).data;
const alphaAt = (x, y) => data[(y * el.width + x) * 4 + 3];
check('选区内像素被擦除', alphaAt(30, 30) === 0 && alphaAt(79, 59) === 0, alphaAt(30, 30) + '/' + alphaAt(79, 59));
check('选区外像素保留', alphaAt(5, 5) === 255 && alphaAt(110, 90) === 255, alphaAt(5, 5) + '/' + alphaAt(110, 90));
check('擦除边界对齐选区左上角', alphaAt(19, 19) === 255 && alphaAt(20, 20) === 0, alphaAt(19, 19) + '/' + alphaAt(20, 20));
check('位图位置未偏移', Math.round(target.left) === 20 && Math.round(target.top) === 20, target.left + ',' + target.top);

const before = canvas.getObjects()[1];
fire('down', 400, 400, 1);
fire('move', 470, 470, 1);
fire('up', 470, 470, 0);
await sleep(150);
check('选区与图层不相交时不改动图层', canvas.getObjects()[1] === before && canvas.getObjects().length === 2, canvas.getObjects().map(o => o.type).join(','));

fire('down', 50, 50, 1);
fire('move', 53, 53, 1);
fire('up', 53, 53, 0);
await sleep(150);
check('过小框选视为误点', canvas.getObjects()[1] === before, canvas.getObjects()[1].type);

app.toolManager.activateTool('select');
const obj = canvas.getObjects()[1];
canvas.setActiveObject(obj);
canvas.renderAll();
app.toolManager.activateTool('eraser');
mod.setDrawMode('brush');
fire('down', 30, 30, 1);
fire('move', 60, 60, 1);
fire('up', 60, 60, 0);
await sleep(200);
const t3 = canvas.getObjects()[1];
const e3 = t3.getElement();
const d3 = e3.getContext('2d').getImageData(0, 0, e3.width, e3.height).data;
const a3 = (x, y) => d3[(y * e3.width + x) * 4 + 3];
check('涂抹模式仍可用', t3.type === 'image' && a3(15, 15) === 0, t3.type + '/' + a3(15, 15));

const optionsHtml = mod.getOptionsBarHTML();
check('预设栏含框选/涂抹', optionsHtml.indexOf('eraser-draw-rect') >= 0 && optionsHtml.indexOf('eraser-draw-brush') >= 0);
mod.applyPreset('eraser-thick');
check('点粗细预设切回涂抹', mod.options.drawMode === 'brush' && mod.options.width === 40, mod.options.drawMode + '/' + mod.options.width);
mod.setDrawMode('rect');
check('框选模式隐藏粗细预设', mod.getOptionsBarHTML().indexOf('eraser-thin') < 0);
check('框选模式属性面板无大小滑块', mod.getPropertyPanelHTML().indexOf('data-module-prop="width"') < 0);
mod.setDrawMode('brush');
check('涂抹模式属性面板有大小滑块', mod.getPropertyPanelHTML().indexOf('data-module-prop="width"') >= 0);
check('属性面板含选区下拉', mod.getPropertyPanelHTML().indexOf('data-module-prop="drawMode"') >= 0);

mod.setDrawMode('rect');
const snap = canvas.getObjects()[1];
fire('down', 25, 25, 1);
fire('move', 45, 45, 1);
fire('up', 45, 45, 0);
await sleep(150);
check('框选过程中可切模式且不残留辅助框', canvas.getObjects().every(o => !o.excludeFromHistory));
check('擦除后仍在同一图层原位', canvas.getObjects()[1] !== snap || canvas.getObjects().length === 2);

return { checks };
})();
