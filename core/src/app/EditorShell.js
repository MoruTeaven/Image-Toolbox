/**
 * EditorShell — App 的界面装配与浏览器事件适配层
 *
 * 存在的理由
 * ----------
 * App 过去一手包办了 UI 组件构造（11 处 getElementById）、全局事件绑定
 * （drag/drop/paste/keydown/wheel）、Toast 渲染（createElement + innerHTML）、
 * 面板显隐（classList 操作）以及偏好读写（localStorage）。这让 App 这个
 * 「应用编排器」同时扮演了视图层，也是 core 无法脱离浏览器运行的直接原因
 * （见 AGENTS.md §3）。
 *
 * 本模块把「界面」这一侧的全部知识集中到这里：
 *   - 需要哪些元素 id、长什么样、怎么显隐；
 *   - 哪些浏览器事件要绑、绑到哪儿、如何翻译成 EventBus 事件；
 *   - Toast 的 DOM 结构。
 *
 * App 只与它交互，拿到的是语义化结果（如 onZoomIn、showToast），
 * 不再出现 document / window。
 *
 * 设计取舍：没有把这些直接搬进 `ui/` 组件，是因为装配顺序与跨组件协调
 * （先建画布 → 再建面板 → 最后绑全局事件）属于应用启动流程；而绑定全局
 * 事件需要同时操纵多个组件。集中在 Shell 里比散进各组件更不易失配。
 */

import { getDomPort } from '../ports/DomPort.js';

/** 界面元素 id 清单 —— 与各端 index.html 的约定，集中一处便于核对 */
export const ELEMENT_IDS = {
  TOOLBAR: 'toolbar',
  OPTIONS_BAR: 'optionsbar',
  PANEL_AREA: 'panel-area',
  PROPERTY_PANEL: 'property-panel',
  LAYER_PANEL: 'layer-panel',
  STATUS_BAR: 'statusbar',
  ACCOUNT_PAGE: 'account-page',
  APP_ROOT: 'app',
  WELCOME: 'welcome',
  WELCOME_BTN: 'welcome-btn',
  WELCOME_DROP: 'welcome-drop',
  CANVAS_CONTAINER: 'canvas-container',
  CANVAS_AREA: 'canvas-area',
  ZOOM_CONTROL: 'zoom-control',
  ZOOM_IN: 'zoom-in',
  ZOOM_OUT: 'zoom-out',
  ZOOM_VALUE: 'zoom-value',
};

const TOAST_ICONS = {
  success: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v4M8 11h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

class EditorShell {
  constructor() {
    this._bound = null;
  }

  // ── 元素查找 ──

  /** @param {string} id */
  el(id) {
    return getDomPort()?.getElementById?.(id) ?? null;
  }

  /** 取 SidePanelTabs 构造前就存在的静态挂载元素，一次性交给 App */
  getMountPoints() {
    return {
      toolbar: this.el(ELEMENT_IDS.TOOLBAR),
      optionsBar: this.el(ELEMENT_IDS.OPTIONS_BAR),
      sidePanel: this.el(ELEMENT_IDS.PANEL_AREA),
      statusBar: this.el(ELEMENT_IDS.STATUS_BAR),
      accountPage: this.el(ELEMENT_IDS.ACCOUNT_PAGE),
      appRoot: this.el(ELEMENT_IDS.APP_ROOT),
    };
  }

  /**
   * 取由 SidePanelTabs._render() 动态生成的面板挂载元素。
   * #property-panel / #layer-panel 不在初始 HTML 中，而是 SidePanelTabs
   * 构造时写入 DOM，因此必须在 SidePanelTabs 构造之后调用。
   */
  getPanelMountPoints() {
    return {
      propertyPanel: this.el(ELEMENT_IDS.PROPERTY_PANEL),
      layerPanel: this.el(ELEMENT_IDS.LAYER_PANEL),
    };
  }

  // ── 面板显隐 ──

  /**
   * 切换「欢迎页 ↔ 编辑区」的可见性。
   * @param {boolean} visible true = 显示编辑区（隐藏欢迎页）
   */
  setEditorVisible(visible) {
    const toggle = (id, hidden) => {
      const el = this.el(id);
      el?.classList?.toggle?.('hidden', hidden);
    };

    toggle(ELEMENT_IDS.WELCOME, visible);
    toggle(ELEMENT_IDS.CANVAS_CONTAINER, !visible);
    toggle(ELEMENT_IDS.ZOOM_CONTROL, !visible);
  }

  /**
   * 在 #app 上切换一个布局类。
   * @param {string} className
   * @param {boolean} on
   */
  toggleAppClass(className, on) {
    this.el(ELEMENT_IDS.APP_ROOT)?.classList?.toggle?.(className, !!on);
  }

  /**
   * 更新缩放百分比显示。
   * @param {number} zoomLevel
   */
  setZoomLabel(zoomLevel) {
    const label = this.el(ELEMENT_IDS.ZOOM_VALUE);
    if (label) {
      label.textContent = Math.round(zoomLevel * 100) + '%';
    }
  }

  /**
   * Fabric.js 未加载时的失败页。
   * @param {string} html
   */
  showFatalError(html) {
    const body = getDomPort()?.getBody?.();
    if (body) body.innerHTML = html;
  }

  // ── Toast ──

  /**
   * 显示一条 Toast。
   * @param {string} message
   * @param {'success'|'error'} [type]
   */
  showToast(message, type = 'success') {
    const port = getDomPort();
    const body = port?.getBody?.();
    if (!body) return;

    // 同时只保留一条，避免叠字
    const existing = port.querySelector?.('.toast');
    existing?.remove?.();

    const toast = port.createElement?.('div');
    if (!toast) return;

    toast.className = `toast toast--${type}`;
    toast.innerHTML = TOAST_ICONS[type] || '';

    const textEl = port.createElement?.('span');
    if (textEl) {
      textEl.textContent = message;
      toast.appendChild(textEl);
    }

    body.appendChild(toast);

    port.onElement?.(toast, 'animationend', () => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
  }

  // ── 全局事件绑定 ──

  /**
   * 绑定全局交互事件，把浏览器原生事件翻译成语义回调。
   *
   * @param {object} handlers
   * @param {(file: File) => void} handlers.onImageFile 拖拽/粘贴进来的图片文件
   * @param {(file: File) => void} handlers.onOraFile 拖拽/粘贴进来的 ORA 工程文件
   * @param {() => void} handlers.onPickImage 点击「选择图片」
   * @param {() => void} handlers.onZoomIn
   * @param {() => void} handlers.onZoomOut
   * @param {() => void} handlers.onZoomReset
   * @param {(e: KeyboardEvent) => void} handlers.onKeyDown 未被内部消化的按键
   * @param {(delta: number, pointer: object) => void} handlers.onWheelZoom
   * @returns {object} 解绑句柄，传给 unbindGlobalEvents
   */
  bindGlobalEvents(handlers) {
    const port = getDomPort();

    const isOra = (name) => String(name || '').toLowerCase().endsWith('.ora');

    const onDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      if (isOra(file.name)) {
        handlers.onOraFile?.(file);
        return;
      }
      if (file.type?.startsWith('image/')) {
        handlers.onImageFile?.(file);
      }
    };

    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type?.startsWith('image/')) {
          const file = item.getAsFile?.();
          if (file) handlers.onImageFile?.(file);
          break;
        }
      }
    };

    const onKeyDown = (e) => handlers.onKeyDown?.(e);

    const onWheel = (e) => {
      e.preventDefault();
      // 滚轮向上 = 放大，与原实现一致
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      handlers.onWheelZoom?.(delta, e);
    };

    // 欢迎页按钮：选择图片
    const welcomeBtn = this.el(ELEMENT_IDS.WELCOME_BTN);
    const onWelcomeClick = () => handlers.onPickImage?.();
    port?.onElement?.(welcomeBtn, 'click', onWelcomeClick);

    // 欢迎图标等价于按钮
    const welcomeDrop = this.el(ELEMENT_IDS.WELCOME_DROP);
    const onWelcomeDropClick = () => welcomeBtn?.click?.();
    port?.onElement?.(welcomeDrop, 'click', onWelcomeDropClick);

    // 缩放控件
    const zoomIn = this.el(ELEMENT_IDS.ZOOM_IN);
    const onZoomInClick = () => handlers.onZoomIn?.();
    port?.onElement?.(zoomIn, 'click', onZoomInClick);

    const zoomOut = this.el(ELEMENT_IDS.ZOOM_OUT);
    const onZoomOutClick = () => handlers.onZoomOut?.();
    port?.onElement?.(zoomOut, 'click', onZoomOutClick);

    const zoomValue = this.el(ELEMENT_IDS.ZOOM_VALUE);
    const onZoomValueClick = () => handlers.onZoomReset?.();
    port?.onElement?.(zoomValue, 'click', onZoomValueClick);

    // 文档级与画布区事件
    port?.onDocument?.('dragover', onDragOver);
    port?.onDocument?.('drop', onDrop);
    port?.onDocument?.('paste', onPaste);
    port?.onDocument?.('keydown', onKeyDown);

    const canvasArea = this.el(ELEMENT_IDS.CANVAS_AREA);
    port?.onElement?.(canvasArea, 'wheel', onWheel, { passive: false });

    this._bound = {
      onDragOver, onDrop, onPaste, onKeyDown, onWheel,
      onWelcomeClick, onWelcomeDropClick,
      onZoomInClick, onZoomOutClick, onZoomValueClick,
      welcomeBtn, welcomeDrop, zoomIn, zoomOut, zoomValue, canvasArea,
    };

    return this._bound;
  }

  /** 解绑 bindGlobalEvents 注册的全部监听器 */
  unbindGlobalEvents() {
    const b = this._bound;
    if (!b) return;

    const port = getDomPort();
    port?.offDocument?.('dragover', b.onDragOver);
    port?.offDocument?.('drop', b.onDrop);
    port?.offDocument?.('paste', b.onPaste);
    port?.offDocument?.('keydown', b.onKeyDown);

    port?.offElement?.(b.welcomeBtn, 'click', b.onWelcomeClick);
    port?.offElement?.(b.welcomeDrop, 'click', b.onWelcomeDropClick);
    port?.offElement?.(b.zoomIn, 'click', b.onZoomInClick);
    port?.offElement?.(b.zoomOut, 'click', b.onZoomOutClick);
    port?.offElement?.(b.zoomValue, 'click', b.onZoomValueClick);
    port?.offElement?.(b.canvasArea, 'wheel', b.onWheel);

    this._bound = null;
  }

  // ── 键盘辅助 ──

  /**
   * 当前焦点是否在文本输入控件里（用于放行快捷键给输入框）。
   * @returns {boolean}
   */
  isTextInputFocused() {
    const el = getDomPort()?.getActiveElement?.();
    if (!el) return false;

    const tagName = el.tagName?.toUpperCase?.();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  /**
   * 打开系统文件选择框（无宿主能力时的降级方案）。
   * @param {string} accept
   * @param {(file: File) => void} onPick
   * @returns {boolean} 是否成功创建了选择框
   */
  openFilePicker(accept, onPick) {
    const port = getDomPort();
    const input = port?.createElement?.('input');
    if (!input) return false;

    input.type = 'file';
    input.accept = accept;
    input.onchange = (e) => {
      const file = e.target?.files?.[0];
      if (file) onPick?.(file);
    };
    input.click?.();
    return true;
  }
}

export default EditorShell;
