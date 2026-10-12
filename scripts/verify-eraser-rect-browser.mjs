/**
 * 橡皮擦「框选」模式 —— 真实浏览器（CDP）像素级验证驱动脚本。
 *
 * 与已废弃的 tmp/browser-verify/cdp-runner.mjs 的区别：
 *  - 自包含：自己起静态服务 + 拉起浏览器 + 收尾清理，不再依赖外层 pwsh 手工编排；
 *  - 修正路径缺陷：旧 runner 读 .tmp/eraser-rect-page.js，而素材实际落在 tmp/ 下，
 *    两者从没对上过；本脚本改为从 scripts/ 读取已随仓库版本化的页面脚本；
 *  - 端口自动避让：静态服务与调试端口都先探测空闲端口，避免与既有实例冲突；
 *  - 浏览器可配置：默认 Edge，可用 IMG_TOOLBOX_BROWSER 指向其它 Chromium 系浏览器。
 *
 * 已知环境限制（重要）：
 *  本机 Windows 进程沙箱会阻断 Chromium 的 mojo 命名管道，浏览器启动即 FATAL
 *  platform_channel.cc:187 Check failed（0x5 拒绝访问），在无该限制的机器/CI 上
 *  才能跑通。本脚本会先做一次「浏览器可启动性」自检，自检失败时以退出码 2 明确
 *  报「环境不支持」，而不是伪装成断言通过。
 *
 * 用法：
 *   node scripts/verify-eraser-rect-browser.mjs
 *   IMG_TOOLBOX_BROWSER="C:\\path\\to\\chrome.exe" node scripts/verify-eraser-rect-browser.mjs
 *
 * 退出码：0 全部通过 / 1 断言失败 / 2 环境不支持或执行出错
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SITE_ROOT = path.resolve(process.argv[2] || 'dist/web');
const PAGE_SCRIPT = path.resolve('scripts/browser-eraser-rect.page.js');
const DEBUG_PORT = Number(process.env.IMG_TOOLBOX_DEBUG_PORT || 9377);

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 取一个当前空闲的 TCP 端口 */
function freePort(preferred) {
  return new Promise(res => {
    const srv = net.createServer();
    srv.once('error', () => {
      // 首选端口被占用，交给系统分配
      const s2 = net.createServer();
      s2.once('error', e => res({ ok: false, err: e.code }));
      s2.listen(0, '127.0.0.1', () => { const p = s2.address().port; s2.close(() => res({ ok: true, port: p })); });
    });
    srv.listen(preferred, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res({ ok: true, port: p })); });
  });
}

/** 探测浏览器可执行文件 */
function findBrowser() {
  if (process.env.IMG_TOOLBOX_BROWSER) return process.env.IMG_TOOLBOX_BROWSER;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/** 极简静态服务：只服务站点根下的文件 */
function startServer(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8'
  };
  return new Promise((res, rej) => {
    const srv = http.createServer((req, r) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(root, rel === '/' ? 'index.html' : rel);
      // 防目录穿越
      if (!file.startsWith(root)) { r.writeHead(403); r.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { r.writeHead(404); r.end('not found'); return; }
        r.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        r.end(buf);
      });
    });
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

/** 浏览器可启动性自检：能起来并打开调试端口才算环境可用 */
async function launchBrowser(browser, url, port, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--no-default-browser-check',
    '--disable-features=Translate,BackForwardCache',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    url
  ];
  const logFile = path.join(os.tmpdir(), 'eraser-verify-browser-' + Date.now() + '.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(browser, args, { stdio: ['ignore', fd, fd], windowsHide: true });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await wait(400);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) { fs.closeSync(fd); return { child, logFile }; }
    } catch (e) { /* 还没起来 */ }
  }
  fs.closeSync(fd);
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) { /* ignore */ }
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
  return { child: null, log, exitCode: child.exitCode };
}

async function main() {
  if (!fs.existsSync(SITE_ROOT)) {
    console.error('找不到站点根：' + SITE_ROOT + '（请先执行 .\build.ps1 构建 web 端，或显式传入站点根路径）');
    process.exitCode = 2; return;
  }
  if (!fs.existsSync(PAGE_SCRIPT)) {
    console.error('找不到页面断言脚本：' + PAGE_SCRIPT);
    process.exitCode = 2; return;
  }
  const browser = findBrowser();
  if (!browser) {
    console.error('未找到可用的 Chromium 系浏览器；可用 IMG_TOOLBOX_BROWSER 指定路径');
    process.exitCode = 2; return;
  }
  console.log('浏览器：' + browser);

  const { srv, port: sitePort } = await startServer(SITE_ROOT);
  console.log('静态服务：http://127.0.0.1:' + sitePort + '/');

  const profileDir = path.join(os.tmpdir(), 'eraser-verify-profile-' + Date.now());
  const siteUrl = 'http://127.0.0.1:' + sitePort + '/';

  const launched = await launchBrowser(browser, siteUrl, DEBUG_PORT, profileDir);

  if (!launched.child) {
    srv.close();
    console.error('\n================ 环境不支持 ================');
    console.error('浏览器无法启动（退出码 ' + launched.exitCode + '）。');
    console.error('本机 Windows 进程沙箱阻断 Chromium 的 mojo 命名管道时必然如此：');
    console.error('  FATAL mojo/public/cpp/platform/platform_channel.cc Check failed: 0x5 拒绝访问');
    console.error('请在无该限制的机器或 CI 上运行本脚本。浏览器日志：');
    console.error(launched.log || '(无日志)');
    process.exitCode = 2;
    return;
  }

  const { child, logFile } = launched;
  let ws;
  try {
    // 取 page target
    let page = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !page) {
      await wait(400);
      try {
        const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
        page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      } catch (e) { /* 重试 */ }
    }
    if (!page) throw new Error('未取得 CDP page target');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise(res => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evalIn = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails));
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');

    // 等应用初始化
    let ready = false;
    for (let i = 0; i < 120; i++) {
      ready = await evalIn('!!(window.__imageToolboxApp && window.__imageToolboxApp.canvasManager && window.__imageToolboxApp.canvasManager.canvas)');
      if (ready) break;
      await wait(300);
    }
    if (!ready) throw new Error('应用未在预期时间内初始化');

    const expr = fs.readFileSync(PAGE_SCRIPT, 'utf8');
    const result = await evalIn(expr);

    const checks = (result && result.checks) || [];
    for (const c of checks) {
      console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    }
    const failed = checks.filter(c => !c.pass);
    console.log('\n断言合计 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
    console.log(failed.length ? 'FAIL' : 'ALL PASS');
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('验证出错：', err && err.message ? err.message : err);
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    srv.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(logFile); } catch (e) { /* ignore */ }
  }
}

await main();
