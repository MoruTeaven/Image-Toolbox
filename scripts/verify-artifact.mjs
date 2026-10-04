/**
 * verify-artifact.mjs — esbuild metafile 断言（build.ps1 调用的构建门禁）
 *
 * metafile 是 esbuild 对「这次构建到底读进来什么、写出什么」的自述，比事后
 * 扫描产物字符串更可靠：意外把 node_modules、仓库外文件卷进 bundle，第一时间
 * 在这里失败，而不是等某个平台上真机才暴露。
 *
 * 断言：
 *   1. 每个非 external 的 input 必须落在 core/src、clients、scripts、
 *      根 package.json（#core/ 别名解析记录）或 --staging 目录内；
 *   2. kind 为 external-module 的 input 必须出现在 --allow-external 白名单；
 *   3. 每个 output 文件存在且非空。
 *
 * Usage: node scripts/verify-artifact.mjs <meta.json> [--staging <dir>] [--allow-external a,b] [--label text] [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const metaPath = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] && argv[i - 1].startsWith('--')));
if (!metaPath) {
  console.error('Usage: node scripts/verify-artifact.mjs <meta.json> [--staging <dir>] [--allow-external a,b] [--label text] [--verbose]');
  process.exit(2);
}
const label = flag('--label') || path.basename(metaPath);
const staging = flag('--staging');
const verbose = argv.includes('--verbose');
const allowExternal = new Set((flag('--allow-external') || '').split(',').map((s) => s.trim()).filter(Boolean));

let meta;
try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch (e) {
  console.error('FAIL  读不到 metafile: ' + metaPath + ' — ' + e.message);
  process.exit(1);
}
const metaDir = path.dirname(path.resolve(metaPath));

// metafile 里的相对路径基准：官方文档是 metafile 所在目录，历史版本是 cwd——两种都试，取存在的
function resolveMetaPath(p) {
  const byMeta = path.resolve(metaDir, p);
  if (fs.existsSync(byMeta)) { return byMeta; }
  return path.resolve(process.cwd(), p);
}

const allowedRoots = [
  path.join(root, 'core', 'src'),
  path.join(root, 'clients'),
  path.join(root, 'scripts')
];
if (staging) { allowedRoots.push(path.resolve(staging)); }

function isInside(abs, dir) {
  const rel = path.relative(dir, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isAllowedExternal(key) {
  // 白名单项命中形式：精确、前缀子路径（jsdom/lib/...）、文件名相等或结尾（node:fs、electron）
  for (const w of allowExternal) {
    if (key === w || key.startsWith(w + '/') || key.endsWith('/' + w) || path.basename(key) === w) { return true; }
  }
  return false;
}

const problems = [];
let inputCount = 0;
let externalCount = 0;
for (const [key, info] of Object.entries(meta.inputs || {})) {
  if (verbose) { console.log('  input[' + info.kind + '] ' + key); }
  // 根 package.json 会以 import-json 等形式出现在解析记录里——#core/ 别名生效的证明，放行
  if (path.resolve(resolveMetaPath(key)) === path.join(root, 'package.json')) { continue; }
  if (info.kind === 'external-module') {
    externalCount += 1;
    if (!isAllowedExternal(key)) {
      problems.push('意外的 external（白名单: ' + ([...allowExternal].join(', ') || '无') + '）: ' + key);
    }
    continue;
  }
  inputCount += 1;
  const abs = resolveMetaPath(key);
  if (!allowedRoots.some((dir) => isInside(abs, dir))) {
    problems.push('input 卷进了允许区域之外的文件: ' + key + ' -> ' + abs);
  }
}

for (const [key, out] of Object.entries(meta.outputs || {})) {
  const abs = resolveMetaPath(key);
  if (!fs.existsSync(abs)) {
    problems.push('metafile 声称产出但文件不存在: ' + key);
  } else if (out.bytes <= 0 || fs.statSync(abs).size === 0) {
    problems.push('产出文件为空: ' + key);
  }
}

console.log('[' + label + '] metafile: ' + inputCount + ' 个真实输入, ' + externalCount + ' 个 external, ' + Object.keys(meta.outputs || {}).length + ' 个输出');
if (problems.length > 0) {
  console.error('FAIL  打包范围断言失败：');
  for (const p of problems) { console.error('  - ' + p); }
  process.exit(1);
}
console.log('OK  [' + label + '] 打包输入全部来自项目源码/暂存区，external 仅白名单，产出非空。');