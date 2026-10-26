/**
 * 宿主 API 对象（只读查找，不做任何别名写回）。
 *
 * 顺序上 ztools 先于 utools：ZTools 环境下 window.utools 可能是历史别名，
 * 优先取 ztools 才能命中真正的宿主对象。
 *
 * 平台判定不要用本函数：请读取 HostAdapter.platform.id。
 *
 * ⚠️ 宿主若启用 contextIsolation，原始对象只存在于 preload 世界，
 * 页面侧读这里的宿主全局会拿到 null。依赖宿主能力的页面代码一律改走
 * preload 暴露的窄接口（见 getBridgedApi），不要依赖本函数。
 *
 * 边界说明（core 浏览器 API 收敛）：本模块是**唯一**允许读取宿主全局的
 * 遗留探测点，且所有访问都收在 DomPort 之后。新代码不得依赖它 ——
 * 宿主能力应经 HostAdapter 能力域取得。此处保留仅为兼容 uTools / ZTools
 * 强制关闭 contextIsolation 的现状。
 */

import { getDomPort } from '../ports/DomPort.js';

/**
 * 取宿主全局对象（hostTools / ztools / utools）。
 * @returns {object|null}
 */
export function getHostApi() {
  const win = getDomPort()?.getHostGlobal?.();
  if (!win) return null;

  return win.hostTools || win.ztools || win.utools || null;
}

/**
 * 通过 contextBridge 暴露的窄接口集合（contextIsolation 开启时的唯一入口）。
 * @returns {object|null}
 */
export function getBridgedApi() {
  return getDomPort()?.getBridgedApi?.() ?? null;
}

/**
 * 读取宿主系统是否处于深色配色。
 * @returns {boolean|null} 未知时返回 null，由调用方决定回退策略
 */
export function isHostDarkColors() {
  const api = getHostApi();

  try {
    if (api && typeof api.isDarkColors === 'function') return !!api.isDarkColors();
  } catch (e) {
    console.warn('[Host] 读取宿主系统颜色失败:', e);
  }

  return null;
}
