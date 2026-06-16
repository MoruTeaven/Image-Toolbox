// ═══════════════════════════════════════════════════════
// @img-toolbox/core — 统一导出
// 平台无关的图片编辑引擎，零 DOM / utools / fabric 依赖
// ═══════════════════════════════════════════════════════

// ── 基础设施 ──
export { EventBus } from './EventBus.js';
export { default as EditorContext } from './EditorContext.js';

// ── 状态存储 ──
export { default as HistoryStore } from './HistoryStore.js';
export { default as LayerStore } from './LayerStore.js';
export { default as ToolRegistry } from './ToolRegistry.js';

// ── 接口 ──
export { default as HostAdapter } from './interfaces/HostAdapter.js';
export { default as EditorEngineAdapter } from './interfaces/EditorEngineAdapter.js';
