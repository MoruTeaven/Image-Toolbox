/**
 * 宿主 API 对象（只读查找，不做任何别名写回）。
 *
 * 顺序上 ztools 先于 utools：ZTools 环境下 window.utools 可能是历史别名，
 * 优先取 ztools 才能命中真正的宿主对象。
 *
 * 平台判定不要用本函数：请读取 HostAdapter.platform.id。
 */
function getHostApi() {
  if (typeof window === 'undefined') return null;

  return window.hostTools || window.ztools || window.utools || null;
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
