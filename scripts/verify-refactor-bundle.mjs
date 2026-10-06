/**
 * 临时验证：重构后的三端 bundle 能否在 DOM 桩件下真实执行并实例化 App。
 *
 * 用途：core 浏览器 API 收敛后，验证 App 经 EditorShell + ports/ 的初始化路径
 * 在打包产物里仍然走通（这是本次重构最容易破坏的地方：端口未注入会让
 * getMountPoints() 全返回 null，UI 组件构造失败）。
 *
 * 用法: node scripts/verify-refactor-bundle.mjs <bundle.js>
 * 验证完即删。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installTestEnvironment } from './test-env.mjs';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('用法: node scripts/verify-refactor-bundle.mjs <bundle.js>');
  process.exit(2);
}

installTestEnvironment();

globalThis.Document = class Document {};
globalThis.HTMLDocument = class HTMLDocument extends globalThis.Document {};
if (!globalThis.document.implementation) {
  globalThis.document.implementation = { createHTMLDocument: () => globalThis.document };
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

try {
  await import(pathToFileURL(path.resolve(bundlePath)).href);
  check('bundle 顶层执行完成', true);
} catch (e) {
  console.error('bundle 执行抛错:', e);
  process.exit(1);
}

check('fabric 已挂到 globalThis (5.3.0)',
  globalThis.fabric && globalThis.fabric.version === '5.3.0',
  'version=' + globalThis.fabric?.version);
check('JSZip 已挂到 globalThis', typeof globalThis.JSZip === 'function');

// 端口层是否可用（收敛后的关键接缝）
const domPortMod = await import('../core/src/ports/DomPort.js');
check('DomPort 导出 createBrowserDomPort', typeof domPortMod.createBrowserDomPort === 'function');
const port = domPortMod.createBrowserDomPort();
check('桩件环境下 DomPort 非空', !!port);
check('DomPort.getElementById 可用', typeof port.getElementById === 'function');
check('DomPort 能取到 fabric-canvas 挂载点', !!port.getElementById('fabric-canvas'));
check('DomPort.getStorage 可用', !!port.getStorage());

const canvasPort = await import('../core/src/ports/CanvasPort.js');
check('CanvasPort.createCanvas 可用', typeof canvasPort.createCanvas === 'function');

// App 能否实例化（走 EditorShell + ports 的完整初始化路径）
// 注意：App 构造函数接收的是 HostAdapter **类**（内部自行 new），不是实例。
const { default: App } = await import('../core/src/app/App.js');
const { default: WebHostAdapter } = await import('../clients/web/src/adapters/host/WebHostAdapter.js');

let app = null;
try {
  app = new App(WebHostAdapter);
  check('App 实例化成功（EditorShell + ports 初始化路径）', true);
} catch (e) {
  check('App 实例化成功（EditorShell + ports 初始化路径）', false, e.message);
}

if (app) {
  check('canvasManager 已建立', !!app.canvasManager);
  check('toolManager 已建立', !!app.toolManager);
  check('toolbar 已建立', !!app.toolbar);
  check('statusBar 已建立', !!app.statusBar);

  const { default: eventBus } = await import('../core/src/EventBus.js');
  const before = app.canvasManager?.canvas ? 1 : 0;
  try {
    app.destroy();
    check('App.destroy() 无异常', true);
  } catch (e) {
    check('App.destroy() 无异常', false, e.message);
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
