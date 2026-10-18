/**
 * scripts/verify-web-e2e.mjs
 *
 * Web 端产物端到端实测：真起静态服务器 + 真用无头浏览器加载页面，然后从 DOM
 * 里读出应用是否真的挂载起来了。
 *
 * 为什么不用 scripts/verify-web-deploy.ps1：那个脚本的文件编码是坏的——
 * 它按 UTF-8 无 BOM 保存中文，而 Windows PowerShell 5.1 按 ANSI(GBK) 解码，
 * 于是 "存在资源 404" 变成 "瀛樺湭璧勬簮 404"，整个脚本连解析都过不去。
 * 修那个脚本要动它的编码，那是另一件事；这里先用 Node 把同一件事做出来，
 * 至少让"产物到底能不能跑"有一个能执行的答案。
 *
 * 与 scripts/verify-web-root-load.mjs 的分工：
 *   verify-web-root-load.mjs - 静态：从磁盘复算首屏请求，有 404 即失败。
 *   verify-web-e2e.mjs      - 动态：真浏览器加载，JS 真的跑过，看 DOM 结果。
 * 前者抓"资源缺失"，后者抓"资源都在但脚本跑挂了"——两类失败互不覆盖。
 *
 * 用法：node scripts/verify-web-e2e.mjs [dist/web 路径]
 * 退出码 0 = 页面真的挂载了；非 0 = 有失败项。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distWeb = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist/web');

if (!fs.existsSync(path.join(distWeb, 'index.html'))) {
  console.error(`FAIL  ${path.join(distWeb, 'index.html')} 不存在，先执行 pnpm build`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const requests = [];
const notFound = [];

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(distWeb, rel);
      // 站点根外的路径一律拒绝：dist/web 就是站点根。
      if (!file.startsWith(distWeb + path.sep) && file !== distWeb) {
        requests.push(`403 ${urlPath}`);
        res.writeHead(403).end('x');
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          requests.push(`404 ${urlPath}`);
          notFound.push(urlPath);
          res.writeHead(404).end('x');
          return;
        }
        requests.push(`200 ${urlPath}`);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const failures = [];
const pass = (name) => console.log(`  ✓ ${name}`);

const server = await startServer();
const port = server.address().port;
const browser = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgtb-e2e-profile-'));
const domFile = path.join(os.tmpdir(), `imgtb-e2e-dom-${process.pid}.html`);

try {
  if (!browser) {
    console.error('FAIL  找不到 Edge，无法做浏览器实测（可用 EDGE_PATH 指定路径）');
    process.exitCode = 1;
  } else {
    const browserArgs = [
      // --headless=new, NOT --headless: on current Edge builds the old headless
      // mode never exits (it leaves orphaned msedge processes behind and blocks
      // the caller forever), while --headless=new dumps the DOM and exits 0.
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      // Import side channels that only produce stderr noise.
      '--disable-features=ImportBrowserDataFiles',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=15000',
      '--dump-dom',
      `http://127.0.0.1:${port}/`
    ];

    // A hard wall-clock bound: if Edge hangs for any other reason the script
    // must still terminate and report a failure, not block the caller.
    const dom = await new Promise((resolve, reject) => {
      const child = spawn(browser, browserArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      let bytes = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('浏览器 90 秒内未退出（headless 挂起）'));
      }, 90000);
      child.stdout.on('data', (c) => { bytes += c.length; chunks.push(c); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString('utf8');
        if (bytes === 0) {
          reject(new Error(`浏览器未产出 DOM（exit ${code}）`));
          return;
        }
        resolve(out);
      });
    });

    fs.writeFileSync(domFile, dom, 'utf8');

    // 1. 资源加载：除 favicon 外不得有 404。
    const misses = notFound.filter((p) => p !== '/favicon.ico');
    if (misses.length > 0) {
      console.error(`FAIL  页面请求了不存在的资源（部署后必然加载失败）：${misses.join(', ')}`);
      process.exitCode = 1;
    } else {
      pass(`首屏请求全部命中（${requests.length} 个请求，0 个 404）`);
    }

    // 2. 两件套真的被请求了——不只是磁盘上存在。
    for (const required of ['/app.js', '/index.css']) {
      const hit = requests.includes(`200 ${required}`);
      if (!hit) {
        console.error(`FAIL  ${required} 未被以 200 请求，说明页面没有引用它`);
        process.exitCode = 1;
      } else {
        pass(`${required} 已 200 命中`);
      }
    }

    // 3. 应用真的挂载了：脚本跑过才会在 DOM 里留这些痕迹。
    const probes = [
      { name: '应用容器已挂载', pattern: 'id="app"' },
      { name: '工具栏由脚本生成', pattern: 'toolbar__btn' },
      { name: '欢迎区已渲染', pattern: 'welcome__text' }
    ];
    for (const probe of probes) {
      if (dom.includes(probe.pattern)) {
        pass(probe.name);
      } else {
        console.error(`FAIL  ${probe.name}（DOM 中未出现 ${probe.pattern}）`);
        process.exitCode = 1;
      }
    }

    // 4. 不该出现的东西。
    if (/core\/src\//.test(dom)) {
      console.error('FAIL  DOM 里出现 ../core/src/ 重写指纹');
      process.exitCode = 1;
    }
    if (dom.includes('#core/')) {
      console.error('FAIL  DOM 里残留未解析的 #core/ 别名');
      process.exitCode = 1;
    }
    if (dom.includes('\uFFFD')) {
      console.error('FAIL  DOM 里出现 U+FFFD 替换字符（编码损坏）');
      process.exitCode = 1;
    }
    console.log(`  · DOM ${dom.length} 字节`);
  }
} catch (error) {
  console.error(`FAIL  浏览器实测异常：${error.message}`);
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(domFile, { force: true });
}

if (process.exitCode) {
  console.error('端到端实测失败');
} else {
  console.log('端到端实测通过：无头浏览器加载 dist/web/，应用真实挂载');
}
process.exit(process.exitCode ?? 0);
