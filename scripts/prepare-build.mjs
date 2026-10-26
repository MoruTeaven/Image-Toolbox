/**
 * prepare-build.mjs — esbuild 构建的暂存准备（由 build.ps1 调用）
 *
 * 为指定平台生成三样东西到 dist/.build/<platform>/：
 *   1. vendor/fabric.js —— classic-script 全局库的 ES 包装
 *   2. entry.js —— bundle 入口：两个 vendor 副作用导入 + 真实平台入口
 *      （clients/<platform>/src/index.js 原样引用，#core/ 由 esbuild 原生解析，
 *        不复制、不改写源码逻辑，避免原型期「手工搬 boot 代码」的漂移风险）
 *   3. index.html —— 页面改写：库 <script> 移除、style.css/入口指向打包产物
 *
 * 打包本身由 build.ps1 调 esbuild CLI 完成（见 build.ps1 的说明）。
 *
 * Usage: node scripts/prepare-build.mjs --platform <web|utools|ztools>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorSource, wrapFabric } from './lib/vendor-wrapper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const platform = (() => {
  const i = process.argv.indexOf('--platform');
  const value = i >= 0 ? process.argv[i + 1] : null;
  if (!['web', 'utools', 'ztools'].includes(value)) {
    console.error('用法: node scripts/prepare-build.mjs --platform <web|utools|ztools>');
    process.exit(2);
  }
  return value;
})();

const clientSrc = path.join(root, 'clients', platform, 'src');
// 暂存区落在系统临时目录，而不是 dist/ 下：
//   1. 它是构建中间物，不该出现在产物目录里被误当作交付内容；
//   2. dist/ 会被 build.ps1 清理，中间物混在里面既冗余又容易被删到一半；
//   3. 个别受限宿主对 dist 下旧文件有句柄锁，导致重建时 EPERM（本次踩到）。
// 需要排查中间物时用环境变量 IMG_TOOLBOX_BUILD_DIR 指定即可。
const buildDir = process.env.IMG_TOOLBOX_BUILD_DIR
  ? path.resolve(process.env.IMG_TOOLBOX_BUILD_DIR, platform)
  : path.join(os.tmpdir(), 'img-toolbox-build', platform);
const vendorDir = path.join(buildDir, 'vendor');

// 暂存区重置：优先整体删掉重建。个别宿主（受限沙箱 / 杀软句柄）会在
// unlink 上返回 EPERM，此时退化为「逐文件覆盖」，只要目录结构存在即可继续——
// 本脚本写入的文件是固定清单，覆盖语义与删除重建等价。
try {
  fs.rmSync(buildDir, { recursive: true, force: true });
} catch (err) {
  if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') { throw err; }
  console.warn(`prepare[${platform}]: 暂存区无法整体删除（${err.code}），改为逐文件覆盖`);
}
fs.mkdirSync(vendorDir, { recursive: true });

// 1. vendor 包装
const vendor = readVendorSource(root);
fs.writeFileSync(path.join(vendorDir, 'fabric.js'), wrapFabric(vendor.fabric), 'utf8');

// 2. bundle 入口。绝对路径用 posix 分隔符，Windows 反斜杠在字符串字面量里是转义符。
const realEntry = path.join(clientSrc, 'index.js');
if (!fs.existsSync(realEntry)) {
  console.error(`FAIL  平台入口不存在: ${realEntry}`);
  process.exit(1);
}
const entry = [
  '// 构建期生成：vendor 全局库先行加载（与页面原先的 <script> 顺序一致），',
  '// 再引入平台真实入口。逻辑零改动 —— 入口内容始终来自 clients/ 源码。',
  "import './vendor/fabric.js';",
  `import '${realEntry.split(path.sep).join('/')}';`,
  ''
].join('\n');
fs.writeFileSync(path.join(buildDir, 'entry.js'), entry, 'utf8');

// 3. 页面改写
let html = fs.readFileSync(path.join(clientSrc, 'index.html'), 'utf8');
const original = html;

html = html.replace(
  /<link rel="stylesheet" href="#core\/style\.css">/,
  '<link rel="stylesheet" href="./index.css">'
);
// 行尾必须容忍 CRLF：本仓库 HTML 是 CRLF，只写 \n 会让匹配静默失败
// （正则要求 </script> 紧跟 \n，而实际是 \r\n），而脚本仍以退出码 0 通过。
html = html.replace(/[ \t]*<script src="#core\/lib\/fabric\.min\.js"><\/script>[ \t]*\r?\n/g, '');
html = html.replace(/[ \t]*<script src="#core\/lib\/jszip\.min\.js"><\/script>[ \t]*\r?\n/g, '');
html = html.replace(
  '<script type="module" src="index.js"></script>',
  '<script type="module" src="./app.js"></script>'
);

// 断言：改写必须把全部 #core 引用与旧入口引用处理干净。
// 静默失配正是历史上 deploy 脚本逐条正则 patch 失效的同款事故（见 AGENTS.md），
// 因此这里逐条校验「源码里出现过、产物里不许再有」，缺一条即失败。
const problems = [];
if (original.includes('#core/style.css') && !html.includes('./index.css')) {
  problems.push('style.css 引用未被改写为 ./index.css');
}
for (const lib of ['fabric.min.js']) {
  if (original.includes(`#core/lib/${lib}`) && html.includes(lib)) {
    problems.push(`${lib} 的 <script> 未被移除`);
  }
}
if (/#core\//.test(html)) {
  problems.push('页面仍有 #core/ 残留');
}
if (original.includes('src="index.js"') && !html.includes('./app.js')) {
  problems.push('入口脚本未被改写为 ./app.js');
}
if (problems.length > 0) {
  console.error('FAIL  页面改写断言失败：');
  for (const p of problems) { console.error('  - ' + p); }
  process.exit(1);
}

fs.writeFileSync(path.join(buildDir, 'index.html'), html, 'utf8');

console.log(`prepare[${platform}]: entry.js + index.html + vendor wrappers -> ${path.relative(root, buildDir).split(path.sep).join('/')}`);
