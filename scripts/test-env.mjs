/**
 * 测试环境桩件 —— 供脚本在 Node 中加载 core 源码（无需构建、无需浏览器）。
 *
 * 提供最小可用的 document / window / localStorage / ResizeObserver / fabric 桩件，
 * 足以让 App + CanvasManager 走通初始化与销毁路径。
 *
 * 仅供 scripts/ 下的验证脚本使用，不参与构建，也不进入 dist/。
 */

export function installTestEnvironment() {
  const { documentStub } = installDom();
  const { canvasInstances } = installFabricStub();
  installBridgeStubs();
  return { documentStub, canvasInstances };
}
class StubClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach(n => this._set.add(n)); }
  remove(...names) { names.forEach(n => this._set.delete(n)); }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    if (on) { this._set.add(name); } else { this._set.delete(name); }
    return on;
  }
  contains(name) { return this._set.has(name); }
}

class StubElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new StubClassList();
    this._listeners = [];
    this.innerHTML = '';
    this.textContent = '';
    this.parentNode = null;
    this.isContentEditable = false;
    this.width = 0;
    this.height = 0;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  }

  addEventListener(type, fn) {
    this._listeners.push({ type, fn });
  }

  removeEventListener(type, fn) {
    const i = this._listeners.findIndex(l => l.type === type && l.fn === fn);
    if (i >= 0) { this._listeners.splice(i, 1); }
  }

  /** 测试辅助：同步派发事件，返回被调用的监听器数量 */
  dispatch(type, event = {}) {
    let called = 0;
    for (const l of [...this._listeners]) {
      if (l.type !== type) { continue; }
      called++;
      l.fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
    return called;
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); }
    child.parentNode = null;
    return child;
  }
  replaceWith() {}
  remove() { this.parentNode?.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute() {}
  getAttribute() { return null; }
  click() { this.dispatch('click'); }
  getContext() { return null; }
  toDataURL() { return 'data:image/png;base64,'; }
  focus() {}
  select() {}
}

const ELEMENT_IDS = [
  'fabric-canvas', 'canvas-area', 'toolbar', 'optionsbar', 'panel-area',
  'property-panel', 'layer-panel', 'statusbar', 'account-page', 'app',
  'welcome', 'welcome-btn', 'welcome-drop', 'canvas-container', 'zoom-control',
  'zoom-in', 'zoom-out', 'zoom-value', 'toast',
];

const registry = new Map();

function ensureElement(id) {
  if (!registry.has(id)) { registry.set(id, new StubElement('div', id)); }
  return registry.get(id);
}

export function installDom() {
  registry.clear();
  for (const id of ELEMENT_IDS) { ensureElement(id); }

  const body = new StubElement('body', 'body');
  const documentStub = {
    body,
    documentElement: new StubElement('html'),
    activeElement: body,
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => new StubElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => body.addEventListener(type, fn),
    removeEventListener: (type, fn) => body.removeEventListener(type, fn),
    listenerCount: () => body._listeners.length
  };

  const windowStub = {
    document: documentStub,
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: makeStorage(),
    location: { href: 'https://example.test/', protocol: 'https:', search: '' },
    navigator: { userAgent: 'node-stub', language: 'zh-CN' },
    __imageSource: null,
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.localStorage = windowStub.localStorage;
  // Node 22 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: windowStub.navigator,
    configurable: true,
    writable: true,
  });
  globalThis.getComputedStyle = windowStub.getComputedStyle;
  globalThis.matchMedia = windowStub.matchMedia;
  globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
  globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame;
  globalThis.DOMParser = class {
    parseFromString() { return { querySelector: () => null }; }
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.Image = class {
    constructor() { this.width = 100; this.height = 100; this.onload = null; this.onerror = null; }
    set src(_v) { setTimeout(() => this.onload?.(), 0); }
  };
  globalThis.Blob = globalThis.Blob || class {};
  globalThis.FileReader = class {
    readAsDataURL() { setTimeout(() => this.onload?.({ target: { result: 'data:image/png;base64,' } }), 0); }
  };
  return { documentStub, windowStub, body };
}

export function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; },
  };
}

/**
 * Fabric.js 桩件 —— 只为让 App/_bindGlobalEvents 走通，不实现绘制。
 * 用 Proxy 兜底所有未实现的成员，避免桩件随源码演进失效。
 */
export function installFabricStub() {
  const canvasInstances = [];

  class StubCanvas {
    constructor(elId, config = {}) {
      this.elId = elId;
      this.config = config;
      this._fabricListeners = new Map();
      this.objects = [];
      this.clipPath = null;
      this.viewportTransform = [1, 0, 0, 1, 0, 0];
      this.width = config.width || 800;
      this.height = config.height || 600;
      this.backgroundImage = null;
      this.disposed = false;
      this.wrapperEl = ensureElement('canvas-area');
      this.lowerCanvasEl = ensureElement('canvas-area');
      canvasInstances.push(this);
    }
    on(type, fn) {
      if (!this._fabricListeners.has(type)) { this._fabricListeners.set(type, []); }
      this._fabricListeners.get(type).push(fn);
    }
    off(type, fn) {
      if (!this._fabricListeners.has(type)) { return; }
      if (!fn) { this._fabricListeners.delete(type); return; }
      this._fabricListeners.set(
        type,
        this._fabricListeners.get(type).filter(f => f !== fn)
      );
    }
    /** 测试辅助：统计该画布上的活跃 Fabric 监听数量 */
    listenerCount() {
      let n = 0;
      for (const fns of this._fabricListeners.values()) { n += fns.length; }
      return n;
    }
    dispose() { this.disposed = true; this._fabricListeners.clear(); }
    add() {}
    remove() {}
    clear() {}
    renderAll() {}
    requestRenderAll() {}
    setDimensions() {}
    getPointer() { return { x: 0, y: 0 }; }
    getActiveObject() { return null; }
    getActiveObjects() { return []; }
    discardActiveObject() {}
    setActiveObject() {}
    getObjects() { return this.objects; }
    toJSON() { return { objects: [] }; }
    toDataURL() { return 'data:image/png;base64,'; }
    loadFromJSON(_json, cb) { cb?.(); }
    setViewportTransform() {}
    calcOffset() {}
    sendObjectToBack() {}
    bringObjectToFront() {}
  }

  const fabricStub = {
    Canvas: StubCanvas,
    Point: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
    Image: class {
      static fromURL(_url, cb) { cb?.(new fabricStub.Image(), false); }
      constructor() { this.type = 'image'; }
      set() {}
      setCoords() {}
    },
    Rect: class { constructor() { this.type = 'rect'; } set() {} setCoords() {} },
    __canvasInstances: canvasInstances,
  };

  // 未显式实现的成员一律返回可调用的空函数，保证桩件不会阻塞 App 初始化
  globalThis.fabric = new Proxy(fabricStub, {
    get(target, prop) {
      if (prop in target) { return target[prop]; }
      return function stub() {};
    }
  });

  return { fabric: globalThis.fabric, canvasInstances };
}

// ── 宿主适配器桩件 ────────────────────────────────────────

export function installBridgeStubs() {
  const calls = { toasts: [], exports: [], windowHeight: [] };
  globalThis.window.showOpenImageDialog = () => null;
  globalThis.window.readImageFile = () => null;
  globalThis.window.getImageSourceFromPluginPayload = () => null;
  return calls;
}

// ── 断言辅助 ──────────────────────────────────────────────

/** 统计 EventBus 中每个事件的订阅数量与总数 */
export function countEventBusListeners(eventBus) {
  let total = 0;
  const perEvent = {};
  for (const [event, listeners] of Object.entries(eventBus._events)) {
    perEvent[event] = listeners.length;
    total += listeners.length;
  }
  return { total, perEvent };
}

/**
 * 挂一个临时探针到 toast:show，返回只统计探针自身响应的次数。
 * 若返回 >1，说明 EventBus 中还有其他订阅者在响应该事件。
 */
export function countToastListenersFired(eventBus, payload) {
  let fired = 0;
  const probe = () => { fired++; };
  const off = eventBus.on('toast:show', probe);
  eventBus.emit('toast:show', payload || { message: 'probe', type: 'success' });
  off();
  return fired;
}


