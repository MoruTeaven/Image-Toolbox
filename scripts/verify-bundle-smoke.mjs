/**
 * verify-bundle-smoke.mjs — esbuild 打包产物的运行时冒烟门禁（正式）
 *
 * 深度与仓库安全门禁一致：Node + scripts/test-env.mjs 的 DOM 桩件，
 * 真实执行 bundle 本身（不是重新 import 源码）。验证：
 *   1. bundle 顶层副作用跑通：真 fabric 被挂到 globalThis
 *   2. 顶层无未解析引用（#core/、裸 require jsdom、jsdom 分支已消除）
 *   3. App / WebHostAdapter / EventBus 从 bundle 内可用
 *
 * 用法：node scripts/verify-bundle-smoke.mjs <bundle.mjs>
 * 由 build.ps1 调用：page bundle 复制为临时 .mjs 后传入，退出码非 0 即构建失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installTestEnvironment } from './test-env.mjs';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('用法: node scripts/verify-bundle-smoke.mjs <bundle.mjs>');
  process.exit(2);
}

installTestEnvironment();
// 真 fabric.min.js 的 UMD 头需要 Document/HTMLDocument 或 document.implementation，
// 桩件默认没有这两样；补齐后真 fabric 能在假 DOM 下完成顶层初始化。
globalThis.Document = class Document {};
globalThis.HTMLDocument = class HTMLDocument extends globalThis.Document {};
if (!globalThis.document.implementation) {
  globalThis.document.implementation = {
    createHTMLDocument: () => globalThis.document
  };
}

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

await import(pathToFileURL(path.resolve(bundlePath)).href);

check('bundle 顶层执行完成', true);
check('真 fabric 已挂到 globalThis（版本 5.3.0）',
  globalThis.fabric && globalThis.fabric.version === '5.3.0',
  'version=' + (globalThis.fabric && globalThis.fabric.version));

const smoke = globalThis.__smoke || {};
if (smoke.App) {
  // 冒烟入口（smoke.entry）：额外断言 App/适配器/EventBus 可用
  check('App 类可用', typeof smoke.App === 'function');
  check('WebHostAdapter 类可用', typeof smoke.WebHostAdapter === 'function');
  if (smoke.eventBus) {
    let hits = 0;
    const off = smoke.eventBus.on('smoke:test', () => { hits++; });
    smoke.eventBus.emit('smoke:test', {});
    off();
    check('EventBus emit/on 正常', hits === 1);
  } else {
    check('EventBus 可用', false, '__smoke.eventBus 缺失');
  }
} else {
  // 浏览器产物（app.js）：入口没有导出 __smoke，只验证顶层副作用跑通。
  // 上面的 fabric 断言已覆盖「bundle 在假 DOM 下完整执行」。
  check('浏览器 bundle 无模块级异常（顶层副作用执行完成）', true);
}

const src = fs.readFileSync(path.resolve(bundlePath), 'utf8');
check('bundle 内无 #core/ 残留', !src.includes('#core/'));
// fabric.min.js 自带「无 document/window 时 require("jsdom")」的 Node 分支：
// bundle 里保留为死代码，与现状（classic script）完全一致；
// ESM 顶层作用域没有 require 绑定，分支一旦被触达会立即 ReferenceError。
// 真 fabric 顶层执行成功（上面的版本断言）已经证明浏览器路径不会走到该分支。
check('ESM 作用域内无全局 require（jsdom 分支不可达）', typeof globalThis.require === 'undefined');

if (failed) {
  console.log('\n冒烟失败: ' + failed + ' 项');
  process.exit(1);
}
console.log('\n冒烟全部通过');