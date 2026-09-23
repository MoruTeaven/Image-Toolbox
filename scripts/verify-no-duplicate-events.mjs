/**
 * 验证：重复 new App() 后 destroy()，不应出现重复事件响应。
 *
 * repro-app-eventbus-leak.mjs 证明「订阅数量不增长」；
 * 本脚本证明「用户可见的重复响应消失」——导出、Toast 各只应触发一次。
 *
 * 用法：
 *   node scripts/verify-no-duplicate-events.mjs
 */

import { installTestEnvironment } from './test-env.mjs';

installTestEnvironment();

const { default: eventBus } = await import('../core/src/EventBus.js');
const { default: App } = await import('../core/src/app/App.js');
const { default: StubAdapter } = await import('./stub-host-adapter.mjs');

eventBus.clear();

// 统计 App._showToast 的实际调用次数（用户可见的 Toast）
let toastCount = 0;
const originalShowToast = App.prototype._showToast;
App.prototype._showToast = function patched(message, type) {
  toastCount++;
  return originalShowToast.call(this, message, type);
};

const failures = [];

// ── 场景 1：连续创建 3 个 App，只保留最后一个存活 ──

const apps = [];
for (let i = 0; i < 3; i++) {
  apps.push(new App(StubAdapter));
}
// 前两个模拟「插件退出」销毁，第三个保持存活（真实场景：换页/重进）
apps[0].destroy();
apps[1].destroy();

toastCount = 0;
eventBus.emit('toast:show', { message: '一次 Toast', type: 'success' });
console.log(`[场景 1] 2 个已销毁实例 + 1 个存活实例，emit toast:show → Toast 响应 ${toastCount} 次`);
if (toastCount !== 1) {
  failures.push(`toast:show 被响应 ${toastCount} 次（期望 1 次），存在重复 Toast`);
}

// ── 场景 2：全部销毁后不应有任何响应 ──

apps[2].destroy();

toastCount = 0;
eventBus.emit('toast:show', { message: '不应出现', type: 'success' });
console.log(`[场景 2] 全部 destroy() 后 emit toast:show → Toast 响应 ${toastCount} 次`);
if (toastCount !== 0) {
  failures.push(`全部销毁后 toast:show 仍被响应 ${toastCount} 次`);
}

// ── 场景 3：export:requested 不应触发重复导出 ──

eventBus.clear();
const exportCalls = [];
const appA = new App(StubAdapter);
const appB = new App(StubAdapter);
for (const app of [appA, appB]) {
  if (app.toolManager) {
    app.toolManager.export = async (target) => { exportCalls.push(target); };
  }
}
appA.destroy();

eventBus.emit('export:requested', 'clipboard');
await new Promise(r => setTimeout(r, 10));
console.log(`[场景 3] appA 已销毁、appB 存活，emit export:requested('clipboard') → 导出调用 ${exportCalls.length} 次`);
if (exportCalls.length !== 1) {
  failures.push(`export:requested 触发导出 ${exportCalls.length} 次（期望 1 次），存在重复导出`);
}

appB.destroy();

// ── 场景 4：真实入口路径（clients/web/src/index.js 的 DOMContentLoaded 启动方式）──

eventBus.clear();
toastCount = 0;

// 模拟 Web 端换页/重进：DOMContentLoaded 触发 → new App → beforeunload 销毁
const webBootstrap = async () => {
  const app = new App(StubAdapter);
  return app;
};
const firstLoad = await webBootstrap();
firstLoad.destroy();
const secondLoad = await webBootstrap();

eventBus.emit('toast:show', { message: '换页后', type: 'success' });
console.log(
  `[场景 4] Web 端换页（销毁旧实例 → 新建实例）后 emit toast:show → Toast 响应 ${toastCount} 次`
);
if (toastCount !== 1) {
  failures.push(`Web 端换页后 toast:show 响应 ${toastCount} 次（期望 1 次），旧实例未被解绑`);
}
secondLoad.destroy();

// ── 汇总 ──

App.prototype._showToast = originalShowToast;

console.log('');
if (failures.length > 0) {
  console.error('❌ 存在重复事件响应:');
  for (const f of failures) { console.error(`   - ${f}`); }
  process.exitCode = 1;
} else {
  console.log('✅ 通过：已销毁实例不再响应 toast:show / export:requested，无重复响应');
}
