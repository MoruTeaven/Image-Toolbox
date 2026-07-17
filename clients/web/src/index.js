/**
 * 图片工具箱 — Web 浏览器平台入口
 * 仅负责引入 HostAdapter 并启动共享 App
 *
 * 与 uTools/ZTools 不同，Web 平台：
 * - 不需要 preload.js（无 Electron 环境）
 * - 不需要 plugin.json（非插件形态）
 * - 支持 URL 参数导入图片（?img=<url>）
 */
import App from '../../../core/src/app/App.js';
import WebHostAdapter from './adapters/host/WebHostAdapter.js';

// ═══ URL 参数图片导入 ═══
// 支持 ?img=<url> 从 URL 加载图片
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const imgSrc = params.get('img');
  if (imgSrc) {
    window.__imageSource = imgSrc;
  }
}

// ═══ 启动应用 ═══
window.addEventListener('DOMContentLoaded', () => {
  const app = new App(WebHostAdapter);
  window.__imageToolboxApp = app;
  window.addEventListener('beforeunload', () => app.destroy(), { once: true });
});
