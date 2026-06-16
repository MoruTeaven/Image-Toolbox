import HostAdapter from '../../core/interfaces/HostAdapter.js';

/**
 * UtoolsHostAdapter — uTools / ZTools 宿主能力适配器
 *
 * 封装 preload.js 暴露的 window.* API 和 uTools 宿主 API，
 * 同时提供浏览器降级方案。
 */
export default class UtoolsHostAdapter extends HostAdapter {
  constructor() {
    super();
    this._api = null;
    this._listeners = [];
    this._initApi();
  }

  // ── 初始化 ──

  _initApi() {
    if (typeof window === 'undefined') return;

    this._api = window.hostTools || window.utools || window.ztools || null;

    if (this._api && window.hostTools !== this._api) {
      window.hostTools = this._api;
    }
  }

  _tryCall(method, ...args) {
    try {
      if (this._api && typeof this._api[method] === 'function') {
        return this._api[method](...args);
      }
    } catch (e) {
      console.warn(`[HostAdapter] ${method} 调用失败:`, e);
    }
    return undefined;
  }

  // ── HostAdapter 实现 ──

  getHostName() {
    const name = this._tryCall('getAppName');
    if (name) return String(name);

    if (typeof window !== 'undefined') {
      if (window.ztools) return 'ZTools';
      if (window.utools) return 'uTools';
    }

    return 'browser';
  }

  async getHostUser() {
    if (typeof window !== 'undefined') {
      try {
        if (typeof window.getHostUser === 'function') return window.getHostUser();
        if (typeof window.getUtoolsUser === 'function') return window.getUtoolsUser();
      } catch (e) {
        console.warn('[HostAdapter] 获取宿主用户信息失败:', e);
      }
    }

    const user = this._tryCall('getUser');
    return user || null;
  }

  async readImageFile(filePath) {
    if (typeof window !== 'undefined' && typeof window.readImageFile === 'function') {
      return window.readImageFile(filePath);
    }
    throw new Error('readImageFile 不可用');
  }

  async saveImage(data, suggestedName = 'edited') {
    // 优先使用宿主 API
    if (typeof window !== 'undefined' && typeof window.showSaveImageDialog === 'function') {
      const filePath = window.showSaveImageDialog(suggestedName);
      if (!filePath) return false;

      if (typeof window.writeImageFile === 'function') {
        return !!window.writeImageFile(filePath, data);
      }
    }

    // 降级：浏览器下载
    if (typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = typeof data === 'string' ? data : URL.createObjectURL(data);
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    }

    return false;
  }

  async copyImage(data) {
    // 优先使用宿主 API
    if (typeof window !== 'undefined' && typeof window.copyImageToClipboard === 'function') {
      window.copyImageToClipboard(typeof data === 'string' ? data : data);
      return true;
    }

    // 降级：Clipboard API
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        let blob;
        if (typeof data === 'string') {
          blob = await (await fetch(data)).blob();
        } else if (data instanceof Blob) {
          blob = data;
        } else {
          return false;
        }

        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
        return true;
      } catch (e) {
        console.warn('[HostAdapter] 剪贴板写入失败:', e);
      }
    }

    return false;
  }

  async pickImage() {
    if (typeof window !== 'undefined' && typeof window.showOpenImageDialog === 'function') {
      const result = window.showOpenImageDialog();
      if (result && result.length > 0) {
        const filePath = Array.isArray(result) ? result[0] : result;
        return this.readImageFile(filePath);
      }
    }

    // 降级：file input
    if (typeof document !== 'undefined') {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif,image/svg+xml';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) { resolve(null); return; }

          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        };
        input.click();
      });
    }

    return null;
  }

  async getSystemFonts() {
    if (typeof window !== 'undefined' && typeof window.getSystemFonts === 'function') {
      return window.getSystemFonts();
    }
    return [];
  }

  async getStorageItem(key) {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
    return null;
  }

  async setStorageItem(key, value) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  }

  async openExternal(url) {
    return this._tryCall('shellOpenExternal', url) || false;
  }

  setWindowHeight(height) {
    this._tryCall('setExpendHeight', height);
  }

  onPluginEnter(callback) {
    if (this._api && typeof this._api.onPluginEnter === 'function') {
      this._api.onPluginEnter(callback);
      return () => {};
    }

    // 无宿主时返回空取消函数
    return () => {};
  }
}
