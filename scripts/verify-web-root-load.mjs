/**
 * verify-web-root-load.mjs — 以「站点根」为基准，静态复算 dist/web/index.html 的加载图。
 *
 * 浏览器加载 http://<host>/ 时：
 *   1. HTML 里的 src/href 按 <base> = "/" 解析；
 *   2. 入口 ES Module 的 import 说明符按该模块自身 URL 解析；
 *   3. 任何落回站点根之上的请求都会 404。
 * 本脚本不启动浏览器，只按这三条规则在磁盘上复算每个请求的最终路径并断言存在，
 * 因此可在无头浏览器不可用的环境（如受限沙箱）中作为构建后的验收依据。
 *
 * 与 build.ps1 的 Test-WebIndex 的区别：Test-WebIndex 是构建期门禁（故意保守，
 * 不跟随 import 里的 ../，以免误判磁盘布局）；本脚本是产物侧验收，严格按浏览器
 * 的 URL 解析规则复算，包括允许在站点根内部向上回退的路径。
 *
 * Usage: node scripts/verify-web-root-load.mjs [dist/web]
 */

import fs from 'node:fs';
import path from 'node:path';

const siteRoot = path.resolve(process.argv[2] ?? 'dist/web');
const entryPath = path.join(siteRoot, 'index.html');

if (!fs.existsSync(entryPath)) {
  console.error(`FAIL  找不到 ${entryPath}，请先执行 build.ps1`);
  process.exit(1);
}

/** 把 URL 路径解析成磁盘路径；返回 null 表示越出站点根。 */
function resolveUrlPath(urlPath) {
  const clean = urlPath.split('?')[0].split('#')[0];
  const relative = clean.replace(/^\/+/, '');
  const resolved = path.resolve(siteRoot, relative);
  const inside = path.relative(siteRoot, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return null;
  }
  return resolved;
}

/** 按浏览器规则解析一个模块说明符（相对自身 URL）。 */
function resolveSpecifier(fromFile, spec) {
  const fromUrl = '/' + path.relative(siteRoot, fromFile).split(path.sep).join('/');
  return new URL(spec, 'http://localhost' + fromUrl).pathname;
}

const problems = [];
const checked = [];
const requests = [];

// ── 1. HTML 引用 ──
const html = fs.readFileSync(entryPath, 'utf8');
const refs = [];
for (const m of html.matchAll(/(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
  refs.push(m[1] ?? m[2]);
}
for (const m of html.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)) {
  refs.push(m[1]);
}

const entryScripts = [];
for (const raw of refs) {
  const ref = (raw ?? '').trim();
  if (!ref) { continue; }
  if (/^(data:|https?:|mailto:|tel:|javascript:|blob:|\/\/|#)/i.test(ref)) { continue; }

  // 站点根页面：非绝对路径的引用同样以 "/" 为基准（与 build.ps1 生成的根页面一致）。
  const urlPath = ref.startsWith('/') ? ref : '/' + ref;
  const disk = resolveUrlPath(urlPath);
  requests.push(urlPath);

  if (disk === null) {
    problems.push(`HTML 引用越出站点根（浏览器会 404）：${ref}`);
    continue;
  }
  if (!fs.existsSync(disk)) {
    problems.push(`HTML 引用在磁盘上不存在（浏览器会 404）：${ref} -> ${urlPath}`);
    continue;
  }
  checked.push(urlPath);
  if (/\.js$/i.test(disk)) { entryScripts.push(disk); }
}

// ── 2. 递归跟随 ES Module 图 ──
const visited = new Set();
const queue = [...entryScripts];

while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file)) { continue; }
  visited.add(file);

  const source = fs.readFileSync(file, 'utf8');
  const specs = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.push(m[1]);
  }

  for (const spec of specs) {
    if (!spec.startsWith('.')) { continue; }  // 裸说明符不是本产物的文件
    const urlPath = resolveSpecifier(file, spec);
    const disk = resolveUrlPath(urlPath);
    requests.push(urlPath);

    const where = path.relative(siteRoot, file).split(path.sep).join('/');
    if (disk === null) {
      problems.push(`模块 import 越出站点根（浏览器会 404）：${spec}（来自 ${where}）`);
      continue;
    }
    if (!fs.existsSync(disk)) {
      problems.push(`模块 import 在磁盘上不存在（浏览器会 404）：${spec}（来自 ${where}）-> ${urlPath}`);
      continue;
    }
    checked.push(urlPath);
    queue.push(disk);
  }
}

// ── 3. 报告 ──
console.log(`站点根: ${siteRoot}`);
console.log(`入口脚本: ${entryScripts.map((f) => '/' + path.relative(siteRoot, f).split(path.sep).join('/')).join(', ')}`);
console.log(`首屏请求: ${requests.length} 个；磁盘确认存在: ${checked.length} 个；模块图: ${visited.size} 个脚本`);
console.log(`关键资源: ${checked.filter((p) => /style\.css|fabric\.min\.js|jszip\.min\.js/.test(p)).join(', ')}`);

if (problems.length > 0) {
  console.error(`\nFAIL  发现 ${problems.length} 个会 404 的请求：`);
  for (const p of problems) { console.error('  - ' + p); }
  process.exit(1);
}

console.log('\nOK  从站点根加载的全部请求都能在磁盘上命中，无 404。');
