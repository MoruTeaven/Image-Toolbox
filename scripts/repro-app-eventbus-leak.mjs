/**
 * 复现 / 验证：App.destroy() 的 EventBus 监听泄漏
 *
 * 用最小 DOM / Fabric 桩件（scripts/test-env.mjs）加载 core 源码，
 * 重复 new App(StubAdapter) + destroy()，统计 EventBus 中残留的回调数量。
 *
 * 用法：
 *   node scripts/repro-app-eventbus-leak.mjs
 *
 * 退出码非 0 表示存在残留订阅。
 */

import {
  installTestEnvironment,
  countEventBusListeners,
  countToastListenersFired,
} from './test-env.mjs';

const { documentStub } = installTestEnvironment();

const { default: eventBus } = await import('../core/src/EventBus.js');
const { default: App } = await import('../core/src/app/App.js');
const { default: StubAdapter } = await import('./stub-host-adapter.mjs');

eventBus.clear();
const baseline = countEventBusListeners(eventBus);
console.log(`[基线] EventBus 订阅总数: ${baseline.total}（清空后）`);

const MAX_ROUNDS = 3;
const totals = [];
const canvasListeners = [];
const destroyedCanvasListeners = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const app = new App(StubAdapter);
  const afterInit = countEventBusListeners(eventBus);
  totals.push(afterInit.total);

  // 统计画布上的 Fabric 监听
  const canvas = app.canvasManager?.canvas;
  const canvasCount = canvas?.listenerCount?.() ?? 0;
  canvasListeners.push(canvasCount);

  const inflight = app._externalSourceTimer !== null;
  const fallbackInflight = app._externalSourceFallbackTimer !== null;
  app.destroy();
  destroyedCanvasListeners.push(canvas?.listenerCount?.() ?? 0);

  const afterDestroy = countEventBusListeners(eventBus);

  console.log(
    `[第 ${round} 轮] new App → 订阅 ${afterInit.total} 个（画布监听 ${canvasCount} 个，` +
    `外部图片源定时器存活=${inflight}/${fallbackInflight}）→ destroy → 残留 ${afterDestroy.total} 个`
  );
  if (afterDestroy.total > 0) {
    const leftovers = Object.entries(afterDestroy.perEvent)
      .filter(([, n]) => n > 0)
      .map(([e, n]) => `${e}×${n}`)
      .join(', ');
    console.log(`          残留明细: ${leftovers}`);
  }
}

// ── 断言 ──
const failures = [];
const final = countEventBusListeners(eventBus);

// 关键不变量：健在的实例持有订阅是正常的，泄漏表现为「重复 new App() 后每轮线性累加」。
// 修复前实测：第 1 轮 68 → 第 2 轮 84 → 第 3 轮 100（每轮 +16，正是 App.js 的订阅数）。
const leakage = totals[MAX_ROUNDS - 1] - totals[MAX_ROUNDS - 2];
if (leakage > 0) {
  failures.push(
    `重复 new App() 导致每轮净增 ${leakage} 个订阅` +
    `（第 1 轮 ${totals[0]} → 第 ${MAX_ROUNDS} 轮 ${totals[MAX_ROUNDS - 1]}）`
  );
}
if (final.total > baseline.total) {
  failures.push(`destroy() 后仍有 ${final.total} 个 EventBus 订阅未解绑`);
}
if (canvasListeners.some(n => n === 0)) {
  failures.push('画布 Fabric 监听未注册，桩件可能未覆盖 CanvasManager._bindEvents');
}
if (destroyedCanvasListeners.some(n => n > 0)) {
  failures.push(`destroy() 后画布仍残留 Fabric 监听: ${destroyedCanvasListeners.join(', ')}`);
}

// destroy 后不应再响应任何事件：探针自身应恰好收到 1 次
const responded = countToastListenersFired(eventBus);
if (responded !== 1) {
  failures.push(`destroy() 后 toast:show 响应数异常：期望仅探针自身 1 次，实际 ${responded} 次`);
}

console.log('');
console.log(`[结果] destroy() 后 EventBus 残留订阅: ${final.total}`);
console.log(`[结果] document 上的残留监听器: ${documentStub.listenerCount()}`);
console.log(
  `[结果] 画布监听数（每轮初始化 / 销毁后）: ` +
  `${canvasListeners.join(', ')} / ${destroyedCanvasListeners.join(', ')}`
);
console.log(`[结果] 每轮 new App() 净增订阅: ${leakage}`);

if (failures.length > 0) {
  console.error('');
  console.error('❌ 检测到 EventBus 监听泄漏:');
  for (const f of failures) { console.error(`   - ${f}`); }
  process.exitCode = 1;
} else {
  console.log('');
  console.log('✅ 通过：重复 new App() + destroy() 后无残留订阅，事件响应不重复');
}
