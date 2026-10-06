/**
 * DomPort — 非 UI 层访问宿主文档与环境能力的唯一入口
 *
 * 为什么需要它
 * ------------
 * `core/` 的非 UI 层（app / CanvasManager / modules / identity / utils）过去
 * 直接书写 `document`、`window`、`localStorage`，这与 AGENTS.md §3 声明的
 * 「core/ 不直接访问 DOM/window」相矛盾：core 实际变成了「浏览器应用 +
 * HostAdapter 垫片」。本模块把这些访问收敛到一个可注入的端口后面：
 *
 *   - 非 UI 层只持有 `getDomPort()` 返回的端口对象，不再出现浏览器全局标识符；
 *   - 装配处（App）用 `createBrowserDomPort()` 注入真实实现；
 *   - 测试可注入纯内存实现，无需 DOM 桩件即可跑通核心逻辑。
 *
 * 边界
 * ----
 * UI 层（`core/src/ui/`）的职责就是渲染界面，它操作自己创建的 DOM 属正当行为，
 * 不走本端口。本端口只服务「非 UI 层因架构需要而不得不碰宿主环境」的场景：
 * 挂载点查找、全局事件、环境偏好存储、MediaQuery 等。
 *
 * 设计约定
 * --------
 * - 所有方法在实现缺失时必须安全降级（返回 null / no-op），不得抛错；
 * - 端口是「能力面」而非「全局对象的转发」：不暴露 `document` 本身，
 *   避免调用方绕开边界再次直接操作 DOM。
 */

let _port = null;

/**
 * @typedef {object} DomPort
 * @property {(id: string) => object|null} getElementById 按 id 取元素
 * @property {(selector: string) => object|null} querySelector 取单个元素
 * @property {() => object|null} getBody 取 document.body
 * @property {() => object|null} getDocumentElement 取 document.documentElement
 * @property {() => object|null} getActiveElement 取当前聚焦元素
 * @property {(tag: string) => object|null} createElement 创建元素
 * @property {(type: string, handler: Function, options?: object) => void} onDocument 绑定文档级事件
 * @property {(type: string, handler: Function) => void} offDocument 解绑文档级事件
 * @property {(el: object|null, type: string, handler: Function, options?: object) => void} onElement 绑定元素事件
 * @property {(el: object|null, type: string, handler: Function) => void} offElement 解绑元素事件
 * @property {(media: string) => object|null} matchMedia 查询媒体条件
 * @property {() => number} getViewportWidth 视口宽度
 * @property {() => number} getViewportHeight 视口高度
 * @property {(url: string) => boolean} openExternalWindow 新窗口打开链接
 * @property {() => object|null} getStorage 键值存储（getItem/setItem/removeItem）
 * @property {() => object|null} getNavigator 宿主导航能力（clipboard 等）
 * @property {() => object|null} getHostGlobal 宿主全局对象（hostTools/ztools/utools 所在的那个对象）
 * @property {() => object|null} getBridgedApi contextBridge 暴露的窄接口集合
 * @property {(type: string, handler: Function, options?: object) => void} onWindow 绑定窗口级事件
 * @property {(type: string, handler: Function) => void} offWindow 解绑窗口级事件
 * @property {((handler: Function) => object|null)} createResizeObserver 创建尺寸观察者
 */

/**
 * 注入 DomPort 实现。由装配处（App）在启动时调用一次。
 * @param {DomPort} port
 */
export function setDomPort(port) {
  _port = port || null;
}

/**
 * 取出当前 DomPort。未注入时返回 null —— 调用方必须能容忍这一情形，
 * 因为 Node 侧的纯逻辑测试不需要（也不应该）真的去访问 DOM。
 * @returns {DomPort|null}
 */
export function getDomPort() {
  return _port;
}

/**
 * 清空端口（测试用）。
 */
export function resetDomPort() {
  _port = null;
}

const _safeDoc = () => (typeof document !== 'undefined' ? document : null);
const _safeWin = () => (typeof window !== 'undefined' ? window : null);

/**
 * 浏览器环境下的默认实现。在非浏览器环境返回一个全部降级的空端口，
 * 使 core 在 Node 里也能被 import 而不炸。
 * @returns {DomPort}
 */
export function createBrowserDomPort() {
  const doc = _safeDoc();
  const win = _safeWin();

  if (!doc && !win) {
    return _createNullDomPort();
  }

  return {
    getElementById: (id) => doc?.getElementById?.(id) ?? null,
    querySelector: (selector) => doc?.querySelector?.(selector) ?? null,
    getBody: () => doc?.body ?? null,
    getDocumentElement: () => doc?.documentElement ?? null,
    getActiveElement: () => doc?.activeElement ?? null,
    createElement: (tag) => doc?.createElement?.(tag) ?? null,

    onDocument: (type, handler, options) => doc?.addEventListener?.(type, handler, options),
    offDocument: (type, handler) => doc?.removeEventListener?.(type, handler),
    onElement: (el, type, handler, options) => el?.addEventListener?.(type, handler, options),
    offElement: (el, type, handler) => el?.removeEventListener?.(type, handler),

    matchMedia: (media) => win?.matchMedia?.(media) ?? null,
    getViewportWidth: () => win?.innerWidth ?? 0,
    getViewportHeight: () => win?.innerHeight ?? 0,
    openExternalWindow: (url) => {
      if (!win?.open) return false;
      win.open(url, '_blank', 'noopener,noreferrer');
      return true;
    },

    // 存储能力优先走宿主适配器（见 HostAdapter.storage），本端口只提供
    // 浏览器侧的原始键值存储作为底层兜底。
    getStorage: () => (typeof localStorage !== 'undefined' ? localStorage : null),
    getNavigator: () => win?.navigator ?? (typeof navigator !== 'undefined' ? navigator : null),

    // 宿主全局与桥接窄接口。core 内只允许 utils/host.js 的 getHostApi()/
    // getBridgedApi() 使用它们 —— 那两处是仓库里仅存的宿主全局探测点。
    getHostGlobal: () => win ?? null,
    getBridgedApi: () => win?.__imageToolboxApi ?? null,

    onWindow: (type, handler, options) => win?.addEventListener?.(type, handler, options),
    offWindow: (type, handler) => win?.removeEventListener?.(type, handler),
    createResizeObserver: (handler) => {
      if (typeof ResizeObserver !== 'function') return null;
      const observer = new ResizeObserver(handler);
      return {
        observe: (target) => observer.observe(target),
        disconnect: () => observer.disconnect(),
      };
    },
  };
}

/**
 * 全降级端口：非浏览器环境下使用，所有能力返回 null / no-op。
 * @returns {DomPort}
 */
export function _createNullDomPort() {
  const noop = () => {};
  return {
    getElementById: () => null,
    querySelector: () => null,
    getBody: () => null,
    getDocumentElement: () => null,
    getActiveElement: () => null,
    createElement: () => null,
    onDocument: noop,
    offDocument: noop,
    onElement: noop,
    offElement: noop,
    matchMedia: () => null,
    getViewportWidth: () => 0,
    getViewportHeight: () => 0,
    openExternalWindow: () => false,
    getStorage: () => null,
    getNavigator: () => null,
    getHostGlobal: () => null,
    getBridgedApi: () => null,
    onWindow: noop,
    offWindow: noop,
    createResizeObserver: () => null,
  };
}
