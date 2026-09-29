/**
 * esbuild 原型构建（一次性评估用，结论见 ESBUILD_EVALUATION.md）
 *
 * 目的：在不改动 build.ps1、不改动 core 源码的前提下验证
 *   1. esbuild 能否解析 #core/ subpath import（Node 原生 imports 别名）
 *   2. 能否把 web 端打成一个自包含 bundle
 *   3. fabric.min.js / jszip.min.js 这两个 <script> 全局依赖如何迁进 bundle
 *   4. 产物体积与 build.ps1 现状产物对比
 *
 * 运行：node scripts/proto-esbuild-web.mjs [--minify] [--keep-vendor]
 * 输出：dist-proto/web-esbuild/   （完全离线，无网络/CDN/node_modules 运行时依赖）
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapFabric, wrapJSZip } from './lib/proto-vendor-wrapper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const staging = path.join(root, 'dist-proto', '.staging');
const outRoot = path.join(root, 'dist-proto', 'web-esbuild');
const webSrc = path.join(root, 'clients', 'web', 'src');

const minify = process.argv.includes('--minify');
const keepVendor = process.argv.includes('--keep-vendor');

// ── 0. 重置暂存区 ──────────────────────────────────────────────
await fsp.rm(staging, { recursive: true, force: true });
await fsp.mkdir(staging, { recursive: true });

// ── 1. 把 classic-script 的全局库转成 ES 模块副作用导入 ─────────
//
// 源码里 fabric 由 <script src="...#core/lib/fabric.min.js"> 提供全局，
// jszip 同理（core/src/utils/ora.js 直接裸用 JSZip 标识符）。
// bundle 里没有 <script> 标签，必须把这两份 UMD/IIFE 文件包成模块。
// 难点见 scripts/lib/proto-vendor-wrapper.mjs 里的注释。
const vendorDir = path.join(staging, 'vendor');
await fsp.mkdir(vendorDir, { recursive: true });

await fsp.writeFile(path.join(vendorDir, 'fabric.js'), wrapFabric(FABRIC_SOURCE), 'utf8');
await fsp.writeFile(path.join(vendorDir, 'jszip.js'), wrapJSZip(JSZIP_SOURCE), 'utf8');

// ── 2. 入口模块 ────────────────────────────────────────────────
const entry = path.join(staging, 'entry.web.js');
await fsp.writeFile(
  entry,
  [
    "import './vendor/fabric.js';",
    "import './vendor/jszip.js';",
    "import App from '#core/app/App.js';",
    "import WebHostAdapter from '../../clients/web/src/adapters/host/WebHostAdapter.js';",
    "import { applyImageSourceParam } from '../../clients/web/src/imageSourceGuard.js';",
    '',
    '// —— 与原 clients/web/src/index.js 等价的启动逻辑 ——',
    "if (typeof window !== 'undefined') {",
    "  const params = new URLSearchParams(window.location.search);",
    "  const imgSrc = params.get('img');",
    '  if (imgSrc) { applyImageSourceParam(imgSrc); }',
    '}',
    '',
    "window.addEventListener('DOMContentLoaded', () => {",
    '  const app = new App(WebHostAdapter);',
    '  window.__imageToolboxApp = app;',
    "  window.addEventListener('beforeunload', () => app.destroy(), { once: true });",
    '});',
    ''
  ].join('\n'),
  'utf8'
);

// ── 3. 转换后的 index.html ────────────────────────────────────
//
// 去掉三个 <script src>（两个库 + index.js），只留打包后的入口脚本。
// build.ps1 的路径重写（#core/style.css 等）在这一步由 esbuild 的 loader 处理：
// 这里先把它们改写成相对源码的真实位置，再让 esbuild 打进来。
let html = fs.readFileSync(path.join(webSrc, 'index.html'), 'utf8');

// CSS 交给 esbuild 处理 -> 产出一份独立 css（见下方 cssBundleName / 额外 build）
html = html.replace(/\s*<link rel="stylesheet" href="#core\/style\.css">\s*\n/, '\n  <link rel="stylesheet" href="./index.css">\n');
// 两个全局库由 bundle 自带，删掉 <script>
html = html.replace(/\s*<script src="#core\/lib\/fabric\.min\.js"><\/script>\s*\n/, '\n');
html = html.replace(/\s*<script src="#core\/lib\/jszip\.min\.js"><\/script>\s*\n/, '\n');
// 入口脚本改为打包产物
html = html.replace('<script type="module" src="index.js"></script>', '<script type="module" src="app.js"></script>');

await fsp.writeFile(path.join(staging, 'index.html'), html, 'utf8');

// ── 4. esbuild 打包 ───────────────────────────────────────────
await fsp.rm(outRoot, { recursive: true, force: true });
await fsp.mkdir(outRoot, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile: path.join(outRoot, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100'],
  minify,
  sourcemap: true,
  // /*! */ 风格的第三方许可证头注释（fabric/JSZip）保留进产物，
  // 与 jszip-LICENSE.txt 随仓库分发的合规做法对齐。
  legalComments: 'inline',
  charset: 'utf8',
  logLevel: 'info',
  metafile: true,
  // 入口在 staging/ 下，需要能向上找仓库根的 package.json 解析 #core/ 别名；
  // esbuild 默认对 #core/* 走 Node 的 imports 解析，这里显式给一层保险。
  alias: {},
  loader: { '.png': 'dataurl', '.svg': 'dataurl' }
});

// ── 5. CSS 单独打一份（esbuild 不把 css 从 JS 入口里抽出来）─────
await build({
  entryPoints: [path.join(root, 'core', 'src', 'style.css')],
  outfile: path.join(outRoot, 'index.css'),
  bundle: true,
  minify,
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'file', '.woff': 'file' },
  logLevel: 'info',
  metafile: true
});

// ── 6. HTML 落到产物根 ────────────────────────────────────────
await fsp.copyFile(path.join(staging, 'index.html'), path.join(outRoot, 'index.html'));

// ── 7. 统计 ───────────────────────────────────────────────────
async function dirSize(dir) {
  let total = 0;
  const files = [];
  async function walk(d) {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else {
        const st = await fsp.stat(p);
        total += st.size;
        files.push({ rel: path.relative(dir, p).replace(/\\/g, '/'), size: st.size });
      }
    }
  }
  await walk(dir);
  files.sort((a, b) => b.size - a.size);
  return { total, files };
}

const size = await dirSize(outRoot);
console.log('');
console.log('esbuild proto output: dist-proto/web-esbuild/  (minify=' + minify + ')');
console.log('total: ' + (size.total / 1024).toFixed(1) + ' KB across ' + size.files.length + ' file(s)');
for (const f of size.files.slice(0, 12)) {
  console.log('  ' + (f.size / 1024).toFixed(1).padStart(9) + ' KB  ' + f.rel);
}

const inputs = Object.keys(result.metafile.inputs);
console.log('');
console.log('bundle inputs: ' + inputs.length + ' module(s)');
const aliasResolved = inputs.filter(i => i.includes('core/src'));
console.log('#core/ resolved into bundle: ' + aliasResolved.length + ' core module(s)');

if (!keepVendor) { await fsp.rm(staging, { recursive: true, force: true }); }
