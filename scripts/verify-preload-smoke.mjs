/**
 * verify-preload-smoke.mjs — preload bundle 运行时冒烟门禁（build.ps1 调用，Electron 端）
 *
 * 为什么需要它：node --check 只证明语法，页面 bundle 的 smoke 不经过 preload。
 * "commonjs-variable-in-esm" 这一类缺陷（type:module 包内的 CJS 文件被按 ESM
 * 解析，module.exports 被当成全局赋值）产出的 bundle 语法完全合法，运行时
 * initPlatformPreload 却是 undefined——只有真机进插件才会炸。本门禁在伪造的
 * electron + window 环境里真正 require() 产物，断言桥接链路跑通。
 *
 * Usage: node scripts/verify-preload-smoke.mjs <dist/<platform>/preload.js 的绝对路径>
 * Exit:  0 通过；1 失败；2 用法错误
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Module from 'node:module';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const target = process.argv[2];
if (!target || !path.isAbsolute(target)) {
  console.error('用法: node scripts/verify-preload-smoke.mjs <preload.js 绝对路径>');
  process.exit(2);
}

// electron 替身：preloadHelpers require('electron') 只为拿 contextBridge /
// clipboard / nativeImage / ipcRenderer，与 verify-security-hardening 同形态。
const bridge = [];
const noop = () => {};
const stubElectron = {
  clipboard: { writeImage: noop, readImage: () => ({ isEmpty: () => true }), writeText: noop, readText: () => '' },
  nativeImage: {
    createFromBuffer: () => ({ toDataURL: () => 'data:,' }),
    createFromPath: () => ({ toDataURL: () => 'data:,' })
  },
  contextBridge: { exposeInMainWorld: (key, value) => { bridge.push({ key, type: typeof value }); } },
  ipcRenderer: { on: noop, once: noop, off: noop, send: noop, sendSync: () => ({}), invoke: async () => ({}) },
  shell: { openExternal: () => Promise.resolve() }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return stubElectron;
  return origLoad.call(this, request, ...rest);
};

// 最小宿主环境：DOM/window 桩件复用 test-env；hostTools 是 apiKeys 的第一优先级。
const { installTestEnvironment } = await import(pathToFileURL(path.join(root, 'scripts', 'test-env.mjs')).href);
installTestEnvironment();
globalThis.window = globalThis.window || {};
globalThis.window.hostTools = { showOpenDialog: () => null, showSaveDialog: () => null };
if (typeof globalThis.window.open !== 'function') globalThis.window.open = () => null;
// 真实 uTools 的 contextIsolation 恒为关（见 commit 88aaeb1），关时 _exposeApisToPage
// 静默返回；这里刻意设 true 迫使桥接分支真执行——只有这样才能断言
// initPlatformPreload 链路真的跑通，而不是被"窗口未定义"守卫静默跳过。
process.contextIsolated = true;

let loadError = null;
try {
  requireCjs(target);
} catch (e) {
  loadError = e;
}
Module._load = origLoad;

if (loadError) {
  console.error('FAIL: require() preload 产物抛出异常 — ' + loadError.message);
  if (loadError.stack) { console.error(loadError.stack.split('\n').slice(0, 6).join('\n')); }
  process.exit(1);
}
if (bridge.length === 0) {
  console.error('FAIL: require() 成功但 exposeInMainWorld 一次都没被调用 —');
  console.error('      initPlatformPreload 没有真正执行（常见根因：CJS/ESM interop 空壳，');
  console.error('      检查 esbuild 是否报 commonjs-variable-in-esm 类警告）。');
  process.exit(1);
}
const names = bridge.map((b) => b.key + ':' + b.type).join(', ');
console.log('OK: preload 冒烟通过，真实宿主桥接了 ' + bridge.length + ' 个 API → ' + names);
