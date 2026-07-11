/**
 * 图片工具箱 — uTools 平台入口
 * 仅负责引入 HostAdapter 并启动共享 App
 */
import App from '../../../core/src/app/App.js';
import UtoolsHostAdapter from './adapters/host/UtoolsHostAdapter.js';

// ═══ 启动应用 ═══
window.addEventListener('DOMContentLoaded', () => {
  const app = new App(UtoolsHostAdapter);
  window.__imageToolboxApp = app;
  window.addEventListener('beforeunload', () => app.destroy(), { once: true });
});
