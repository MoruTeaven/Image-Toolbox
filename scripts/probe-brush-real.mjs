/**
 * 真实 CDP 输入事件验证 DOM 覆盖层画笔光标：真实鼠标移动 + 真实滚轮缩放。
 * 检查：单个圆圈、跟随鼠标、缩放后仍跟随且仍可见。仅诊断用。
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

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
  }
  sendRaw(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify(msg)); });
  }
  send(method, params = {}) { return this.sendRaw(method, params); }
}

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'imgtb-real-'));
const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=0`, `--user-data-dir=${profile}`,
  `--window-size=1400,1000`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c.toString(); });

try {
  let wsPort = null;
  for (let i = 0; i < 100; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { wsPort = fs.readFileSync(f, 'utf8').split('\n')[0]; break; }
    await sleep(100);
  }
  if (!wsPort) throw new Error('无 CDP 端口: ' + stderr.slice(-300));
  const version = await (await fetch(`http://127.0.0.1:${wsPort}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new CDP(ws);
  const { result: { targetId } } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.sendRaw(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(5000);

  const mounted = await evaluate(`typeof window.__imageToolboxApp !== 'undefined'`);
  console.log('应用挂载:', mounted);
  if (mounted !== true) throw new Error('应用未挂载');

  const testPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  console.log('加载图片:', await evaluate(`
    (async () => { const a = window.__imageToolboxApp; try { await a.canvasManager.loadImage('${testPng}'); a.shell?.setEditorVisible?.(true); return 'ok'; } catch(e) { return String(e); } })()
  `));
  await sleep(500);
  await evaluate(`window.__imageToolboxApp.toolManager.activateTool('brush')`);
  await sleep(200);

  const stateExpr = `
    (() => {
      const m = window.__imageToolboxApp.toolManager.getCurrentModule();
      const els = document.querySelectorAll('[data-brush-cursor="1"]');
      const el = m._cursorEl;
      const cs = el ? getComputedStyle(el) : null;
      return {
        cursorEls: els.length,
        hasEl: !!el,
        display: cs?.display,
        left: el?.style?.left,
        top: el?.style?.top,
        w: cs?.width,
        borderColor: cs?.borderColor,
        lastClient: m._lastClientPoint,
        zoom: window.__imageToolboxApp.canvasManager.zoomLevel
      };
    })()
  `;

  // 真实鼠标移动
  const targetX = 500, targetY = 400;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY, button: 'none' });
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX + 30, y: targetY + 20, button: 'none' });
  await sleep(200);
  const before = await evaluate(stateExpr);
  console.log('缩放前:', JSON.stringify(before));

  // 真实滚轮缩放（鼠标静止）
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: targetX + 30, y: targetY + 20, deltaX: 0, deltaY: -120, button: 'none' });
    await sleep(150);
  }
  const afterZoom = await evaluate(stateExpr);
  console.log('缩放后(未移动鼠标):', JSON.stringify(afterZoom));

  // 缩放后再移动鼠标
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX + 100, y: targetY + 80, button: 'none' });
  await sleep(200);
  const afterMove = await evaluate(stateExpr);
  console.log('缩放后移动鼠标:', JSON.stringify(afterMove));

  // ── 断言 ──
  let failed = 0;
  const assert = (name, ok, detail = '') => {
    if (ok) { console.log(`  ✓ ${name}`); }
    else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
  };
  assert('画布上只有一个光圈元素', before?.cursorEls === 1, `cursorEls=${before?.cursorEls}`);
  assert('鼠标移动后光标显示并跟到鼠标位置',
    before?.display === 'block' && before?.lastClient?.clientX === targetX + 30 && before?.lastClient?.clientY === targetY + 20,
    JSON.stringify(before));
  assert('缩放后光标仍显示', afterZoom?.display === 'block', `display=${afterZoom?.display}`);
  assert('缩放后光圈仍只有一个', afterZoom?.cursorEls === 1, `cursorEls=${afterZoom?.cursorEls}`);
  assert('缩放后移动鼠标仍跟随',
    afterMove?.lastClient?.clientX === targetX + 100 && afterMove?.lastClient?.clientY === targetY + 80,
    JSON.stringify(afterMove));
  assert('缩放后光圈直径随缩放变大',
    parseFloat(afterZoom?.w) > parseFloat(before?.w), `before=${before?.w}, after=${afterZoom?.w}`);

  console.log(failed === 0 ? '\n真实浏览器验证通过' : `\n真实浏览器验证失败：${failed} 项`);
  if (failed) process.exitCode = 1;

} catch (e) {
  console.error('诊断失败:', e.message);
  console.error(stderr.slice(-500));
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
  server.close();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
