/**
 * 橡皮擦「框选」模式 —— 真实浏览器像素级验证驱动脚本。
 *
 * 验证目标（这些是 Node 桩件级验证覆盖不到的真实浏览器行为）：
 *   - fabric.Rect 实际渲染
 *   - canvas.getPointer 的视口坐标换算
 *   - destination-out fillRect 后 alpha 是否真的归零
 *   - 撤销恢复
 *
 * 实现方式：
 *   起本地静态服务托管 dist/web，把断言脚本注入页面，
 *   由页面在真实浏览器里执行断言后把结果 POST 回本进程。
 *
 * 为什么不走 CDP（重要背景）：
 *   本机 Windows 进程沙箱会阻断 Chromium 的 mojo 命名管道，Edge/Chrome 启动即
 *   FATAL mojo/public/cpp/platform/platform_channel.cc:187 Check failed: 0x5。
 *   旧方案 tmp/browser-verify/cdp-runner.mjs 依赖 CDP，在该环境下根本起不来。
 *   本脚本改为「HTTP 回传」：不依赖任何调试协议，只要浏览器能加载页面即可，
 *   因此 Firefox（非 Chromium，不受 mojo 限制）可直接跑通。
 *
 * 另一个踩过的坑：无头浏览器进程若异常残留会累积并耗尽资源，
 *   表现为「进程能起来但从不发起请求」。本脚本每次运行前会清理残留的
 *   无窗口浏览器进程（仅清理无 MainWindowTitle 的，不动用户正在用的浏览器）。
 *
 * 用法：
 *   .\build.ps1                              # 先构建 web 端
 *   node scripts/verify-eraser-rect-browser.mjs
 *
 * 退出码：0 全部通过 / 1 断言失败 / 2 环境或执行出错
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';

const SITE_ROOT = path.resolve(process.argv[2] || 'dist/web');
const PAGE_SCRIPT = path.resolve('scripts/browser-eraser-rect.page.js');
const WAIT_TIMEOUT_MS = Number(process.env.IMG_TOOLBOX_WAIT_MS || 90000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

/** 探测浏览器可执行文件：优先 Chromium 系，其次 Firefox */
function findBrowser() {
  if (process.env.IMG_TOOLBOX_BROWSER) {
    const exe = process.env.IMG_TOOLBOX_BROWSER;
    return { exe, kind: /firefox/i.test(exe) ? 'firefox' : 'chromium' };
  }
  const chromium = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of chromium) { if (fs.existsSync(p)) { return { exe: p, kind: 'chromium' }; } }
  const firefox = [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
  ];
  for (const p of firefox) { if (fs.existsSync(p)) { return { exe: p, kind: 'firefox' }; } }
  return null;
}

/** 清理无窗口的残留浏览器进程（用户正在用的有窗口，不会被清理） */
function killStaleBrowsers() {
  if (process.platform !== 'win32') { return Promise.resolve(0); }
  const names = ['firefox', 'msedge', 'chrome'];
  const ps = 'Get-Process $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | Stop-Process -Force -ErrorAction SilentlyContinue; ' +
    '(Get-Process $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | Measure-Object).Count';
  return Promise.all(names.map(name => new Promise(res => {
    execFile('powershell', ['-NoProfile', '-Command', ps.replace(/\$name/g, name)],
      { windowsHide: true }, (e, stdout) => {
        if (e) { res(0); return; }
        const n = parseInt(String(stdout).trim(), 10);
        res(isNaN(n) ? 0 : n);
      });
  }))).then(list => list.reduce((a, b) => a + b, 0));
}

function startServer(html) {
  return new Promise((res, rej) => {
    const srv = http.createServer((req, r) => {
      if (req.url === '/report' && req.method === 'POST') {
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => { r.writeHead(200); r.end('ok'); srv._report(b); });
        return;
      }
      const rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/' || rel === '/index.html') {
        r.writeHead(200, { 'Content-Type': TYPES['.html'] });
        r.end(html);
        return;
      }
      const file = path.join(SITE_ROOT, rel);
      if (!file.startsWith(SITE_ROOT)) { r.writeHead(403); r.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { r.writeHead(404); r.end('not found'); return; }
        r.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        r.end(buf);
      });
    });
    srv._report = () => {};
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

async function main() {
  if (!fs.existsSync(SITE_ROOT)) {
    console.error('找不到站点根：' + SITE_ROOT);
    console.error('请先执行 .\build.ps1 构建 web 端，或显式传入站点根路径。');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(PAGE_SCRIPT)) {
    console.error('找不到页面断言脚本：' + PAGE_SCRIPT);
    process.exitCode = 2;
    return;
  }
  const browser = findBrowser();
  if (!browser) {
    console.error('未找到可用浏览器（Edge / Chrome / Firefox）；可用 IMG_TOOLBOX_BROWSER 指定路径');
    process.exitCode = 2;
    return;
  }

  const stale = await killStaleBrowsers();
  if (stale > 0) { console.log('已清理残留无窗口浏览器进程：' + stale + ' 个'); }
  console.log('浏览器：' + browser.exe + '（' + browser.kind + '）');

  // 把断言脚本注入页面：等应用初始化后执行，结果 POST 回 /report
  const pageScript = fs.readFileSync(PAGE_SCRIPT, 'utf8');
  const idxHtml = fs.readFileSync(path.join(SITE_ROOT, 'index.html'), 'utf8');
  const injected = idxHtml.replace('</body>', '<script>' +
    'window.addEventListener("load", async () => {' +
    '  await new Promise(r => setTimeout(r, 2500));' +
    '  let result;' +
    '  try {' +
    '    result = await eval(' + JSON.stringify(pageScript) + ');' +
    '  } catch (e) {' +
    '    result = { error: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 900) };' +
    '  }' +
    '  try { await fetch("/report", { method: "POST", body: JSON.stringify(result) }); } catch (e) {}' +
    '});' +
    '<\/script></body>');

  const { srv, port } = await startServer(injected);
  console.log('静态服务：http://127.0.0.1:' + port + '/');

  const reportPromise = new Promise(r => { srv._report = r; });
  const base = path.join(os.tmpdir(), 'eraser-verify-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  const profile = path.join(base, 'profile');

  const args = browser.kind === 'firefox'
    ? ['--headless', '-profile', profile, '--new-instance', 'http://127.0.0.1:' + port + '/']
    : ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--user-data-dir=' + profile, 'http://127.0.0.1:' + port + '/'];

  const logFile = path.join(base, 'browser.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(browser.exe, args, { stdio: ['ignore', fd, fd], windowsHide: true });

  try {
    const result = await Promise.race([
      reportPromise,
      new Promise(r => setTimeout(() => r('__TIMEOUT__'), WAIT_TIMEOUT_MS))
    ]);

    if (result === '__TIMEOUT__') {
      console.error('\n等待页面回传超时（' + WAIT_TIMEOUT_MS + 'ms）。');
      console.error('浏览器可能未能加载页面。常见原因：残留的无头浏览器进程耗尽资源，');
      console.error('或本机进程沙箱阻断了浏览器 IPC（Chromium 会 FATAL platform_channel.cc 0x5）。');
      console.error('建议改用 Firefox：IMG_TOOLBOX_BROWSER="C:\\Program Files\\Mozilla Firefox\\firefox.exe"');
      process.exitCode = 2;
      return;
    }

    const out = JSON.parse(result);
    if (out.error) {
      console.error('页面内断言脚本抛错：' + out.error);
      if (out.stack) { console.error(out.stack); }
      process.exitCode = 2;
      return;
    }
    const checks = out.checks || [];
    for (const c of checks) {
      console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    }
    const failed = checks.filter(c => !c.pass);
    console.log('\n合计 ' + checks.length + ' 项断言，失败 ' + failed.length + ' 项');
    console.log(failed.length ? 'FAIL' : 'ALL PASS');
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('验证出错：', err && err.message ? err.message : err);
    process.exitCode = 2;
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    fs.closeSync(fd);
    srv.close();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

await main();
