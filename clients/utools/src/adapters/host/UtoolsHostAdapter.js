/**
 * UtoolsHostAdapter
 * uTools/ZTools 平台宿主适配器
 * 实现 HostAdapter 接口，封装 uTools API
 */

export default class UtoolsHostAdapter {
  constructor() {
    this._isUTools = typeof utools !== 'undefined';
  }

  get isUTools() {
    return this._isUTools;
  }

  get name() {
    return 'utools';
  }

  setWindowHeight(height) {
    if (this._isUTools && utools?.setExpendHeight) {
      utools.setExpendHeight(height);
    }
  }

  setWindowWidth(width) {
    if (this._isUTools && utools?.setExpendWidth) {
      utools.setExpendWidth(width);
    }
  }

  setWindowTitle(title) {
    if (this._isUTools && utools?.setMainWindowTitle) {
      utools.setMainWindowTitle(title);
    }
  }

  onPluginEnter(callback) {
    if (this._isUTools && utools?.onPluginEnter) {
      utools.onPluginEnter(callback);
    }
  }

  onPluginOut(callback) {
    if (this._isUTools && utools?.onPluginOut) {
      utools.onPluginOut(callback);
    }
  }

  showOpenDialog(options) {
    if (this._isUTools && utools?.showOpenDialog) {
      return utools.showOpenDialog(options);
    }
    return null;
  }

  showSaveDialog(options) {
    if (this._isUTools && utools?.showSaveDialog) {
      return utools.showSaveDialog(options);
    }
    return null;
  }

  readFile(path) {
    if (typeof window !== 'undefined' && typeof window.readImageFile === 'function') {
      return window.readImageFile(path);
    }
    return null;
  }

  writeClipboard(dataURL) {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(dataURL);
    }
    return Promise.reject(new Error('Clipboard API not available'));
  }

  readClipboard() {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return navigator.clipboard.readText();
    }
    return Promise.reject(new Error('Clipboard API not available'));
  }

  showNotification(message, type) {
    if (this._isUTools && utools?.showNotification) {
      utools.showNotification(message, type);
    }
  }

  fetchLocalFile(path) {
    if (this._isUTools && utools?.fetchLocalFile) {
      return utools.fetchLocalFile(path);
    }
    return null;
  }

  getHostAppVersion() {
    if (this._isUTools && utools?.getVersion) {
      return utools.getVersion();
    }
    return 'unknown';
  }

  getHostName() {
    if (this._isUTools && utools?.getNickname) {
      return utools.getNickname();
    }
    return 'unknown';
  }

  getHostUser() {
    if (this._isUTools && utools?.getUserInfo) {
      return utools.getUserInfo();
    }
    return null;
  }

  openHostExternal(url) {
    if (this._isUTools && utools?.shellOpenExternal) {
      utools.shellOpenExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }
}

// 便捷导出函数（供 UI 直接调用）
export function getHostAppVersion() {
  if (typeof utools !== 'undefined' && utools.getVersion) {
    return utools.getVersion();
  }
  return 'unknown';
}

export function getHostName() {
  if (typeof utools !== 'undefined' && utools.getNickname) {
    return utools.getNickname();
  }
  return 'unknown';
}

export function getHostUser() {
  if (typeof utools !== 'undefined' && utools.getUserInfo) {
    return utools.getUserInfo();
  }
  return null;
}

export function openHostExternal(url) {
  if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
    utools.shellOpenExternal(url);
  } else {
    window.open(url, '_blank');
  }
}
