/**
 * 真实浏览器探针：加载 dist/web，激活画笔，模拟 mousemove，读取 Fabric
 * 画布里预览对象的真实状态（visible / left / top）。
 * 仅诊断用，不作为门禁。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distWeb = path.join(ROOT, 'dist/web');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 静态服务器 ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(distWeb, rel);
  if (!file.startsWith(distWeb + path.sep)) { res.writeHead(403).end('x'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('x'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ── CDP 客户端 ──
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else if (msg.method) this.events.push(msg);
    });
  }
  sendRaw(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify(msg)); });
  }
  send(method, params = {}) { return this.sendRaw(method, params); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
    return r.result?.result?.value;
  }
}

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'imgtb-probe-'));
const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=0`, `--user-data-dir=${profile}`,
  `--window-size=1200,900`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
child.stderr.on('data', (c) => { stderr += c.toString(); });

try {
  // 等待 DevToolsActivePort
  let wsPort = null;
  for (let i = 0; i < 100; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { wsPort = fs.readFileSync(f, 'utf8').split('\n')[0]; break; }
    await sleep(100);
  }
  if (!wsPort) throw new Error('无法取得 CDP 端口: ' + stderr.slice(-500));

  const version = await (await fetch(`http://127.0.0.1:${wsPort}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new CDP(ws);

  // 建 target 并连接
  const { result: { targetId } } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // flatten 模式下 sessionId 必须放在 CDP 消息顶层，不能混在 params 里。
  const send = (method, params = {}) => cdp.sendRaw(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (process.env.PROBE_DEBUG) console.log('[DEBUG eval raw]', JSON.stringify(r).slice(0, 600));
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
    if (r.error) return { error: JSON.stringify(r.error) };
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // 给真实设备视口，避免 headless 下 rect 为 0
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(5000);

  // 诊断：页面到底发生了什么
  const diag1 = await evaluate(`JSON.stringify({ ready: document.readyState, url: location.href, bodyLen: document.body?.innerHTML?.length, hasToolbar: document.body?.innerHTML?.includes('toolbar__btn'), hasApp: typeof window.__imageToolboxApp })`);
  console.log('页面诊断:', diag1);
  const consoleErrs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  if (consoleErrs.length) console.log('页面异常:', consoleErrs.slice(-5).join('\n'));

  // 1. 应用是否挂载
  const mounted = await evaluate(`typeof window.__imageToolboxApp !== 'undefined'`);
  console.log('应用挂载:', mounted);
  if (mounted !== true) throw new Error('应用未挂载，无法继续');

  // 1.5 加载一张测试图片让画布真正显示（欢迎页状态下画布容器是隐藏的）
  // 用 1x1 红色 PNG 的 dataURL
  const testPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const loadResult = await evaluate(`
    (async () => {
      const app = window.__imageToolboxApp;
      try {
        await app.canvasManager.loadImage('${testPng}');
        // 关闭欢迎层（若存在）
        const welcome = document.getElementById('welcome');
        if (welcome) welcome.style.display = 'none';
        return { ok: true, objects: app.canvasManager.canvas.getObjects().length };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()
  `);
  console.log('加载图片:', JSON.stringify(loadResult));
  await sleep(1000);

  // 2. 激活画笔
  const activated = await evaluate(`
    (() => {
      const app = window.__imageToolboxApp;
      app.toolManager.activateTool('brush');
      const m = app.toolManager.getCurrentModule();
      return { tool: app.toolManager.getCurrentTool(), name: m?.constructor?.name, hasCanvas: !!app.canvasManager.canvas };
    })()
  `);
  console.log('激活画笔:', JSON.stringify(activated));

  // 3. 找到 upperCanvasEl 位置，模拟真实 mousemove
  const rect = await evaluate(`
    (() => {
      const c = window.__imageToolboxApp.canvasManager.canvas;
      const r = c.upperCanvasEl.getBoundingClientRect();
      const disp = getComputedStyle(c.upperCanvasEl).display;
      return { x: r.left, y: r.top, w: r.width, h: r.height, display: disp, hasUpper: !!c.upperCanvasEl };
    })()
  `);
  console.log('画布位置:', JSON.stringify(rect));

  // 4. headless 下 rect 为 0，CDP 坐标点击落不到画布上。直接派发原生
  //    mousemove/mouseenter 到 upperCanvasEl，验证监听器与 _showCursorAt 逻辑。
  const dispatch = await evaluate(`
    (() => {
      const c = window.__imageToolboxApp.canvasManager.canvas;
      const el = c.upperCanvasEl;
      // 让 calcOffset 拿到正确偏移（headless 下 rect 为 0，手动补一个）
      el.getBoundingClientRect = () => ({ left: 100, top: 100, width: 800, height: 600, right: 900, bottom: 700 });
      el.dispatchEvent(new MouseEvent('mouseenter', { clientX: 200, clientY: 200, bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: 245, clientY: 230, bubbles: true }));
      return true;
    })()
  `);
  console.log('派发鼠标事件:', dispatch);
  await sleep(200);

  // 5. 读取真实预览状态
  const state = await evaluate(`
    (() => {
      const app = window.__imageToolboxApp;
      const m = app.toolManager.getCurrentModule();
      const p = m._cursorPreview;
      return {
        tool: app.toolManager.getCurrentTool(),
        hasPreview: !!p,
        visible: p?.visible,
        left: p?.left,
        top: p?.top,
        inCanvas: p ? app.canvasManager.canvas.getObjects().includes(p) : false,
        lastPointer: m._lastPointer,
      };
    })()
  `);
  console.log('光标真实状态:', JSON.stringify(state));

  // 6. 再移动一次，看 left/top 是否跟随
  await evaluate(`
    (() => {
      const el = window.__imageToolboxApp.canvasManager.canvas.upperCanvasEl;
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: 305, clientY: 280, bubbles: true }));
    })()
  `);
  await sleep(200);
  const state2 = await evaluate(`
    (() => {
      const m = window.__imageToolboxApp.toolManager.getCurrentModule();
      const p = m._cursorPreview;
      return { visible: p?.visible, left: p?.left, top: p?.top, lastPointer: m._lastPointer };
    })()
  `);
  console.log('再次移动后:', JSON.stringify(state2));

  // 7. 像素级验证：读取光标中心 (305,280) 附近，看是否真的画出了红色圆圈
  const pixels = await evaluate(`
    (() => {
      const c = window.__imageToolboxApp.canvasManager.canvas;
      const lower = c.lowerCanvasEl;
      const ctx = lower.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      // fabric retina scaling：内部画布按 dpr 放大
      const scale = c.getRetinaScaling ? c.getRetinaScaling() : dpr;
      const px = Math.round(305 * scale), py = Math.round(280 * scale);
      const region = (x, y) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      const center = region(px, py);
      const ring = region(px + Math.round(5 * scale), py); // 外圈描边位置
      const far = region(px + Math.round(60 * scale), py); // 远处背景
      return { scale, center, ring, far };
    })()
  `);
  console.log('像素验证:', JSON.stringify(pixels));

  // 8. 关键场景：绘制过程中（鼠标按下拖动）——这才是「跟随画笔移动」的核心。
  //    逐帧记录 _showCursorAt 收到的坐标，定位到底哪一步没更新。
  await evaluate(`
    (() => {
      const m = window.__imageToolboxApp.toolManager.getCurrentModule();
      window.__probeLog = [];
      const orig = m._showCursorAt.bind(m);
      m._showCursorAt = (p) => { window.__probeLog.push({p: {x:p?.x, y:p?.y}}); return orig(p); };
    })()
  `);
  const drawing = await evaluate(`
    (() => {
      const el = window.__imageToolboxApp.canvasManager.canvas.upperCanvasEl;
      const m = window.__imageToolboxApp.toolManager.getCurrentModule();
      const mk = (type, x, y, buttons) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true });
      el.dispatchEvent(mk('mousedown', 200, 200, 1));
      el.dispatchEvent(mk('mousemove', 240, 230, 1));
      const afterFirst = { log: window.__probeLog.slice(), left: m._cursorPreview?.left, top: m._cursorPreview?.top };
      el.dispatchEvent(mk('mousemove', 300, 280, 1));
      const afterSecond = { log: window.__probeLog.slice(), left: m._cursorPreview?.left, top: m._cursorPreview?.top };
      return { afterFirst, afterSecond, drawing: window.__imageToolboxApp.canvasManager.canvas._isCurrentlyDrawing };
    })()
  `);
  console.log('绘制中光标(逐帧):', JSON.stringify(drawing));
  await sleep(200);
  const drawPixels = await evaluate(`
    (() => {
      const c = window.__imageToolboxApp.canvasManager.canvas;
      const ctx = c.lowerCanvasEl.getContext('2d');
      const d = ctx.getImageData(300, 280, 1, 1).data;
      return { lowerCenter: [d[0], d[1], d[2], d[3]] };
    })()
  `);
  console.log('绘制中像素:', JSON.stringify(drawPixels));

  // ── 断言：真实浏览器里光标必须真的可见且跟随，尤其绘制过程中 ──
  const assert = (name, ok, detail = '') => {
    if (ok) { console.log(`  ✓ ${name}`); }
    else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); process.exitCode = 1; }
  };
  assert('光标对象已创建且可见', state?.hasPreview === true && state?.visible === true);
  assert('普通移动后光标跟随到最新位置', state2?.left === 305 && state2?.top === 280,
    `left=${state2?.left}, top=${state2?.top}`);
  assert('光标在画布上真实画出像素（非透明）', Array.isArray(pixels?.center) && pixels.center[3] > 0,
    `center=${JSON.stringify(pixels?.center)}`);
  assert('绘制中拖动时光标跟随（不卡旧值）',
    drawing?.afterSecond?.left === 300 && drawing?.afterSecond?.top === 280,
    `left=${drawing?.afterSecond?.left}, top=${drawing?.afterSecond?.top}`);
  assert('绘制中光标真实画在画布上（非透明）',
    Array.isArray(drawPixels?.lowerCenter) && drawPixels.lowerCenter[3] > 0,
    `lowerCenter=${JSON.stringify(drawPixels?.lowerCenter)}`);
  if (process.exitCode) {
    console.error('真实浏览器验证失败：画笔光标跟随仍有回归');
  } else {
    console.log('真实浏览器验证通过：光标静态可见、跟随更新、绘制中仍可见');
  }

} catch (e) {
  console.error('探针失败:', e.message);
  console.error(stderr.slice(-800));
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
  server.close();
  // Edge 关闭后短暂等待再删 profile，避免文件仍被占用
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 清理失败不影响诊断 */ }
}
