/**
 * WebHostAdapter
 * Web 浏览器平台宿主适配器，继承 BaseHostAdapter。
 *
 * 与 uTools/ZTools 不同，Web 平台：
 * - 没有 Electron preload 环境，不依赖 window.showOpenImageDialog 等原生 API
 * - 文件操作通过浏览器原生 <input type="file"> / <a download> 实现
 * - 剪贴板通过 navigator.clipboard API 实现
 * - 存储使用 localStorage
 * - 无窗口控制能力（noop）
 * - 无系统字体扫描能力（降级到内置字体列表）
 */

import BaseHostAdapter from '../../../../../core/src/adapters/BaseHostAdapter.js';

const DEFAULT_HOST_NAME = 'Web';

class WebHostAdapter extends BaseHostAdapter {
  constructor() {
    super();

    // Web 平台运行在浏览器中
    this.platform.runtime = 'browser';

    // 清除继承的原生文件对话框方法，使 ExportModule 走 saveImage 分支
    this.showSaveImageDialog = null;
    this.writeImageFile = null;
  }

  get platformId() {
    return 'web';
  }

  getDefaultHostName() {
    return DEFAULT_HOST_NAME;
  }

  getHostApiPriority() {
    return [];
  }

  getAppVersionPriority() {
    return [];
  }

  getHostDisplayName() {
    return DEFAULT_HOST_NAME;
  }

  normalizeUser() {
    // Web 平台无宿主用户概念
    return null;
  }

  getRawUser() {
    return null;
  }

  getContactUrl() {
    return 'https://github.com';
  }

  /**
   * 选择图片文件 — 使用浏览器原生 file input
   * 返回 Promise<string|null>（dataURL）
   */
  pickImage() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif,image/svg+xml';
      input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        this.readImageFile(file).then(resolve).catch(() => resolve(null));
      };
      // 用户取消选择时触发（延时以区分点击和取消）
      const handleClick = () => {
        setTimeout(() => {
          if (!input.value) resolve(null);
        }, 500);
      };
      input.addEventListener('click', handleClick);
      input.click();
    });
  }

  /**
   * 读取图片文件为 dataURL
   * @param {File|Blob|string} file - File 对象（Web 平台不支持文件路径）
   * @returns {Promise<string|null>}
   */
  readImageFile(file) {
    if (!file) return Promise.resolve(null);
    if (typeof file === 'string') return Promise.resolve(null);

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * 保存图片 — 触发浏览器下载
   */
  saveImage(data, suggestedName = 'edited.png') {
    if (!data || typeof document === 'undefined') return false;

    try {
      const link = document.createElement('a');
      link.href = data;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return true;
    } catch (e) {
      console.warn('[WebHostAdapter] 浏览器下载失败:', e);
      return false;
    }
  }

  /**
   * 复制图片到剪贴板 — 使用 navigator.clipboard API
   */
  async copyImage(data) {
    if (!data) return false;

    try {
      const response = await fetch(data);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      return true;
    } catch (e) {
      console.warn('[WebHostAdapter] 复制图片到剪贴板失败:', e);
      return false;
    }
  }

  /**
   * 获取系统字体 — Web 平台无法扫描系统字体，返回空数组降级到内置列表
   */
  getSystemFonts() {
    return [];
  }

  /**
   * 异步获取系统字体
   */
  getSystemFontsAsync() {
    return Promise.resolve([]);
  }

  /**
   * 打开外部链接 — 使用 window.open
   */
  openHostExternal(url) {
    if (!url) return false;
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    return false;
  }

  /**
   * 显示通知 — 使用 Web Notifications API（需用户授权）
   */
  showNotification(message, type) {
    // Web 平台使用 Toast 代替系统通知
    // Toast 由 App 层的 eventBus 处理，这里无需额外操作
  }

  /**
   * 插件进入回调 — Web 平台无生命周期事件，直接 noop
   */
  onPluginEnter() {
    return () => {};
  }

  /**
   * 插件退出回调 — Web 平台无生命周期事件，直接 noop
   */
  onPluginOut() {
    return () => {};
  }
}

export default WebHostAdapter;
