const { initPreload } = require('../../../core/src/preloadHelpers.js');

// ═══════════════════════════════════════════════════════════════
// ZTools 平台特定配置
// ═══════════════════════════════════════════════════════════════

const PLATFORM_NAME = 'ZTools';
const USER_FN_NAME = 'getZtoolsUser';

const platform = {
  getName: () => PLATFORM_NAME,
  getApiKeys: () => ['hostTools', 'ztools', 'utools'],
  getUserFnName: () => USER_FN_NAME,
  getContactUrl: () => 'https://qm.qq.com/q/xdx9hstuGA',
  onPluginEnter: (callback) => {
    const api = getHostTools();
    if (api && typeof api.onPluginEnter === 'function') {
      api.onPluginEnter(callback);
    }
    return () => {};
  },
  onPluginOut: (callback) => {
    const api = getHostTools();
    if (api && typeof api.onPluginOut === 'function') {
      api.onPluginOut(callback);
    }
    return () => {};
  },
  openExternal: (url) => {
    const api = getHostTools();
    if (api && typeof api.shellOpenExternal === 'function') {
      api.shellOpenExternal(url);
      return true;
    }
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    return false;
  },
};

// ═══════════════════════════════════════════════════════════════
// API 查找函数（ZTools 平台特定顺序）
// ═══════════════════════════════════════════════════════════════

const getHostTools = () => {
  if (typeof window === 'undefined') return null;

  const priorities = platform.getApiKeys();

  if (typeof window !== 'undefined') {
    for (const key of priorities) {
      if (window[key]) return window[key];
    }
  }

  if (typeof globalThis !== 'undefined') {
    for (const key of priorities) {
      if (globalThis[key]) return globalThis[key];
    }
  }

  return null;
};

const getHostAppVersion = () => {
  const api = getHostTools();
  if (api && typeof api.getAppVersion === 'function') return api.getAppVersion();
  if (api && typeof api.getVersion === 'function') return api.getVersion();
  if (api && typeof api.getPluginVersion === 'function') return api.getPluginVersion();
  return 'unknown';
};

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
  initPreload(platform);

  // 注册平台特定 API
  window.getHostAppVersion = getHostAppVersion;
  window.getHostName = () => PLATFORM_NAME;

  window[USER_FN_NAME] = () => {
    const api = getHostTools();
    if (!api) return null;
    try {
      if (typeof api.getUser === 'function') return api.getUser();
      if (typeof api.getUserInfo === 'function') return api.getUserInfo();
    } catch (e) {
      console.warn(`[${PLATFORM_NAME} preload] 获取宿主用户失败:`, e);
    }
    return null;
  };

  // ═══════════════════════════════════════════════════════════════
  // 在 preload 阶段注册 onPluginEnter
  //
  // uTools/zTools 通过功能指令（cmds）进入插件时，onPluginEnter 事件
  // 在 preload.js 执行后就会触发。如果此时没有注册回调，事件会丢失。
  // 因此必须在 preload 阶段就注册回调，将图片 payload 解析后暂存到
  // window.__imageSource，供 App._checkExternalSource() 拾取。
  // 同时保留 window.__pluginEnterAction 供 App.js 重新注册回调后使用。
  // ═══════════════════════════════════════════════════════════════

  window.__pluginEnterAction = null;

  const api = getHostTools();
  if (api && typeof api.onPluginEnter === 'function') {
    api.onPluginEnter((action) => {
      console.log(`[${PLATFORM_NAME} preload] onPluginEnter:`, action);

      // 保存最新的 enter action，供 App.js 重新注册后使用
      window.__pluginEnterAction = action;

      if (action.code === 'image-edit') {
        const source = window.getImageSourceFromPluginPayload
          ? window.getImageSourceFromPluginPayload(action.type, action.payload)
          : null;

        if (source) {
          window.__imageSource = source;
        } else if (action.type === 'img' && window.__imageSource) {
          // 已有图片源，保持不变
        }

        // 设置窗口高度
        if (api && typeof api.setExpendHeight === 'function') {
          api.setExpendHeight(560);
        }
      }
    });
  }
}
