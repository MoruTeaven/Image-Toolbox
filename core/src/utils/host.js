/**
 * 宿主 API 对象（只读查找，不做任何别名写回）。
 *
 * 顺序上 ztools 先于 utools：ZTools 环境下 window.utools 可能是历史别名，
 * 优先取 ztools 才能命中真正的宿主对象。
 *
 * 平台判定不要用本函数：请读取 HostAdapter.platform.id。
 *
 * ⚠️ 宿主若启用 contextIsolation，原始对象只存在于 preload 世界，
 * 页面侧读这里的 window.hostTools / window.utools 会拿到 null。
 * 依赖宿主能力的页面代码一律改走 preload 暴露的窄接口
 * （window.__imageToolboxApi 或直接 window.<能力名>），不要依赖本函数。
 *
 * uTools / ZTools 当前强制关闭 contextIsolation（插件无法通过 plugin.json 开启），
 * 本函数因此仍能取到对象 —— 但它只是遗留探测，新代码不得依赖。
 */
function getHostApi() {
  if (typeof window === 'undefined') return null;

  return window.hostTools || window.ztools || window.utools || null;
}

/**
 * 通过 contextBridge 暴露的窄接口集合（contextIsolation 开启时的唯一入口）。
 * @returns {object|null}
 */
export function getBridgedApi() {
  if (typeof window === 'undefined') return null;
  return window.__imageToolboxApi || null;
}

export function isHostDarkColors() {
  const api = getHostApi();

  try {
    if (api && typeof api.isDarkColors === 'function') return !!api.isDarkColors();
  } catch (e) {
    console.warn('[Host] 读取宿主系统颜色失败:', e);
  }

  return null;
}
