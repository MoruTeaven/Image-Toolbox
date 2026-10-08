/**
 * App — 图片工具箱主入口
 * 跨平台共享的应用初始化逻辑。
 *
 * 各平台 index.js 只需传入 HostAdapter 构造函数即可复用。
 *
 * 架构边界（AGENTS.md §3）
 * -----------------------
 * 本文件**不得**出现 `document` / `window` / `navigator` / `localStorage`。
 * 界面装配与浏览器事件经 `EditorShell`，环境能力经 `ports/` 下的各端口。
 * 需要新增宿主能力时，先补端口再使用 —— 不要在编排层开洞。
 */

import {
  eventBus,
  CanvasManager,
  LayerManager,
  HistoryManager,
  ToolManager,
} from '../runtime/fabric.js';

import { exportORA, importORA } from '@img-toolbox/ora';
import { exportPSD, importPSD } from '@img-toolbox/psd';

import Toolbar from '../ui/Toolbar.js';
import OptionsBar from '../ui/OptionsBar.js';
import SidePanelTabs from '../ui/SidePanelTabs.js';
import PropertyPanel from '../ui/PropertyPanel.js';
import LayerPanel from '../ui/LayerPanel.js';
import StatusBar from '../ui/StatusBar.js';
import AccountPage, {
  EDITOR_BARS_LAYOUT_KEY,
  EDITOR_BARS_LAYOUTS,
  EDITOR_SIDE_PANEL_POSITION_KEY,
  EDITOR_SIDE_PANEL_POSITIONS,
  TOOLBAR_COLLAPSED_KEY,
  TOOLBAR_COLLAPSED,
} from '../ui/AccountPage.js';
import { initTheme } from '../utils/theme.js';

import EditorShell from './EditorShell.js';

import { createBrowserDomPort, setDomPort } from '../ports/DomPort.js';
import { setPreferenceHost, getPreference } from '../utils/preferences.js';
import { setClipboardHost } from '../ports/ClipboardPort.js';
import { setFontHost } from '../ports/FontPort.js';
import { setColorHost } from '../ports/ColorPort.js';

const IMAGE_ACCEPT = '.ora,.psd,.png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,image/*,application/zip';
const EDITOR_WINDOW_HEIGHT = 560;

class App {
  constructor(HostAdapter) {
    this.HostAdapter = HostAdapter;
    this.canvasManager = null;
    this.layerManager = null;
    this.historyManager = null;
    this.toolManager = null;

    this.shell = new EditorShell();

    this.toolbar = null;
    this.optionsBar = null;
    this.sidePanelTabs = null;
    this.propertyPanel = null;
    this.layerPanel = null;
    this.statusBar = null;
    this.accountPage = null;
    this.hostAdapter = null;
    this._destroyed = false;
    this._eventBusUnsubscribers = [];
    this._externalSourceTimer = null;
    this._externalSourceFallbackTimer = null;
    this._saveTimer = null;
    this._onPluginEnterCallback = null;

    this._init();
  }

  _init() {
    // 注入浏览器环境端口。这是 core 唯一一次「把真实浏览器接进来」的地方，
    // 之后所有非 UI 层都只与端口交互。
    setDomPort(createBrowserDomPort());

    // 确保 Fabric.js 已加载
    if (typeof fabric === 'undefined') {
      console.error('[App] Fabric.js 未加载，请检查 CDN');
      this.shell.showFatalError('<div class="loading">Fabric.js 加载失败，请检查网络连接</div>');
      return;
    }

    try {
      initTheme();
      this._applyEditorBarsLayout(this._getEditorBarsLayout());
      this._applyEditorSidePanelPosition(this._getEditorSidePanelPosition());
      this._applyToolbarCollapsed(this._getToolbarCollapsed());

      // 1. 初始化画布管理器
      this.canvasManager = new CanvasManager('fabric-canvas');
      this.canvasManager.init({
        width: 800,
        height: 600,
        backgroundColor: 'transparent',
        preserveObjectStacking: true,
        selection: true,
        stopContextMenu: true,
        fireRightClick: true,
      });

      // 2. 初始化图层管理器
      this.layerManager = new LayerManager(this.canvasManager);

      // 3. 初始化历史记录
      this.historyManager = new HistoryManager(this.canvasManager, 30);

      // 4. 初始化宿主适配器，并把能力域注入各端口
      this.hostAdapter = new this.HostAdapter();
      this._injectHostCapabilities(this.hostAdapter);

      // 5. 初始化工具管理器（注入 host adapter）
      this.toolManager = new ToolManager(this.canvasManager, this.historyManager, {
        host: this.hostAdapter,
      });

      // 6. 初始化 UI 组件 —— 挂载点由 shell 统一解析
      const mounts = this.shell.getMountPoints();

      this.toolbar = new Toolbar(mounts.toolbar, this.toolManager, this.hostAdapter);
      this.optionsBar = new OptionsBar(mounts.optionsBar, this.toolManager);
      // SidePanelTabs._render() 会动态写入 #property-panel / #layer-panel，
      // 这两个挂载点必须在它构造之后才能取到。
      this.sidePanelTabs = new SidePanelTabs(mounts.sidePanel, this.layerManager);
      const panelMounts = this.shell.getPanelMountPoints();
      this.propertyPanel = new PropertyPanel(
        panelMounts.propertyPanel,
        this.toolManager,
        this.canvasManager,
        this.layerManager
      );
      this.layerPanel = new LayerPanel(panelMounts.layerPanel, this.layerManager, this.historyManager);
      this.statusBar = new StatusBar(mounts.statusBar, this.canvasManager, this.layerManager);
      this.accountPage = new AccountPage(
        mounts.accountPage,
        mounts.appRoot,
        this.sidePanelTabs,
        this.hostAdapter
      );

      // 7. 绑定全局事件
      this._bindGlobalEvents();

      // 8. 默认激活选择工具
      this.toolManager.activateTool('select');

      // 9. 检查是否有外部传入的图片源
      this._checkExternalSource();

      console.log('[App] 图片工具箱初始化完成');
    } catch (err) {
      console.error('[App] 初始化失败:', err);
    }
  }

  /**
   * 把宿主能力域接到各端口上。
   *
   * 端口保留「注入优先」的设计，所以这里只做接线，不改变端口的降级语义：
   * 宿主没有实现某能力时，端口会自动继续往浏览器原生路径降级。
   * @param {object} host
   */
  _injectHostCapabilities(host) {
    setPreferenceHost(host);
    setClipboardHost(host);
    setFontHost(host);
    setColorHost(host);
  }

  _bindGlobalEvents() {
    // ═══ 全局交互事件（由 shell 翻译为语义回调）═══
    this.shell.bindGlobalEvents({
      onImageFile: (file) => this._loadImage(file),
      onOraFile: (file) => eventBus.emit('ora:import', file),
      onPsdFile: (file) => eventBus.emit('psd:import', file),

      onPickImage: () => this._handlePickImage(),

      onZoomIn: () => {
        this.canvasManager?.zoomIn();
        this._updateZoomLabel();
      },
      onZoomOut: () => {
        this.canvasManager?.zoomOut();
        this._updateZoomLabel();
      },
      onZoomReset: () => {
        this.canvasManager?.resetZoom();
        this._updateZoomLabel();
      },

      onWheelZoom: (delta) => {
        const canvas = this.canvasManager?.canvas;
        if (!canvas) return;
        this.canvasManager.zoomIn(delta);
        this._updateZoomLabel();
      },

      onKeyDown: (e) => this._handleKeyDown(e),
    });

    // ═══ EventBus 订阅 ═══
    //
    // EventBus 是模块级全局单例（EventBus.js），订阅不会随实例消亡。
    // 所有订阅的取消函数必须收进 _eventBusUnsubscribers，由 destroy() 统一解绑；
    // 否则每次 new App()（插件重复进入 / 热重载 / Web 换页）都会把闭包永久留在
    // 单例里，既泄漏整棵已销毁的对象树，又导致旧实例响应事件（重复导出/导入/Toast）。
    this._eventBusUnsubscribers.push(
      eventBus.on('canvas:zoomIn', () => {
        this.canvasManager?.zoomIn();
        this._updateZoomLabel();
      }),
      eventBus.on('canvas:zoomOut', () => {
        this.canvasManager?.zoomOut();
        this._updateZoomLabel();
      })
    );

    // ═══ 导出 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('export:requested', async (payload) => {
        // 兼容旧调用方式：字符串 'clipboard' 或 { type: 'file', format }
        const type = typeof payload === 'string' ? payload : payload?.type;
        if (type === 'clipboard') {
          await this.toolManager?.export('clipboard');
        } else {
          const exportModule = this.toolManager?.getModule('export');
          if (exportModule) {
            await exportModule.exportToFile(payload?.format);
          }
        }
      })
    );

    // ═══ 打开文件（从状态栏「打开」按钮）═══
    this._eventBusUnsubscribers.push(
      eventBus.on('file:open', async (source) => {
        if (source) {
          await this._loadImage(source);
          this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
        }
      })
    );

    // ═══ ORA 导出/导入 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('ora:export', async () => {
        if (!this.canvasManager?.originalImage) {
          eventBus.emit('toast:show', { message: '请先加载图片', type: 'error' });
          return;
        }
        await exportORA(this.canvasManager, this.layerManager, this.hostAdapter);
      }),

      eventBus.on('ora:import', async (file) => {
        if (file instanceof Blob) {
          this.shell.setEditorVisible(true);
          await importORA(file, this.canvasManager, this.layerManager, this.historyManager);
          this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
        }
      })
    );

    // ═══ PSD 导出/导入 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('psd:export', async () => {
        if (!this.canvasManager?.originalImage) {
          eventBus.emit('toast:show', { message: '请先加载图片', type: 'error' });
          return;
        }
        await exportPSD(this.canvasManager, this.layerManager, this.hostAdapter);
      }),

      eventBus.on('psd:import', async (file) => {
        if (file instanceof Blob) {
          this.shell.setEditorVisible(true);
          await importPSD(file, this.canvasManager, this.layerManager, this.historyManager);
          this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
        }
      })
    );

    // ═══ 撤销 / 重做 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('history:undo', () => {
        this.historyManager?.undo();
      }),
      eventBus.on('history:redo', () => {
        this.historyManager?.redo();
      })
    );

    // ═══ 编辑器布局偏好 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('sidePanel:layoutChanged', (layout) => {
        this.sidePanelTabs?.applyLayout(layout, false);
      }),

      eventBus.on('editorBars:layoutChanged', (layout) => {
        this._applyEditorBarsLayout(layout);
      }),

      eventBus.on('editorSidePanel:positionChanged', (position) => {
        this._applyEditorSidePanelPosition(position);
      }),

      eventBus.on('toolbar:collapsedChanged', (value) => {
        this._applyToolbarCollapsed(value);
      })
    );

    // ═══ 画布操作后自动保存历史 ═══
    this._eventBusUnsubscribers.push(
      eventBus.on('canvas:objectModified', (target) => {
        if (target?.excludeFromHistory) return;

        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
          this.historyManager?.saveState();
        }, 300);
      }),

      eventBus.on('layer:reorderWillChange', () => {
        this.historyManager?.saveState();
      }),

      // ═══ 工具自动切换 ═══
      eventBus.on('tool:requestChange', (toolName) => {
        this.toolManager?.activateTool(toolName);
      }),

      // ═══ Toast ═══
      eventBus.on('toast:show', ({ message, type }) => {
        this.shell.showToast(message, type);
      })
    );

    // ═══ 插件重复进入 ═══
    // preload.js 已在插件加载时注册了 onPluginEnter，把首次进入的图片 payload
    // 交给宿主适配器暂存，由此处的回调拾取。此处理后续进入的情况。
    this._onPluginEnterCallback = ({ code, type, payload, from }) => {
      console.log('[App] onPluginEnter:', { code, type, from, payload });
      if (code !== 'image-edit') return;

      // PSD/ORA 工程文件从文件路径直接导入，不走图片加载
      if (type === 'file' || type === 'files') {
        const files = Array.isArray(payload) ? payload : [payload];
        const fileInfo = files.find(item => item && item.path);
        if (fileInfo?.path) {
          const lower = String(fileInfo.path).toLowerCase();
          if (lower.endsWith('.psd') || lower.endsWith('.ora')) {
            this._importProjectFile(fileInfo.path, lower.endsWith('.psd') ? 'psd' : 'ora');
            this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
            return;
          }
        }
      }

      const source = this._getExternalImageSource(type, payload);
      console.log('[App] 外部图片源:', source ? 'ok' : 'empty', { type, from });

      if (source) {
        this._consumePendingSource(source);
        this._loadImage(source);
      } else if (type === 'img') {
        const fallbackSource = this._consumePendingSource();
        if (fallbackSource) this._loadImage(fallbackSource);
      }

      this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
    };
    this.hostAdapter?.lifecycle?.onEnter?.(this._onPluginEnterCallback);
  }

  /**
   * 处理「选择图片」：宿主 pickImage 优先，降级到浏览器文件选择框。
   */
  _handlePickImage() {
    const picked = this.hostAdapter?.file?.pickImage?.();
    if (picked) {
      this._loadImage(picked);
      return;
    }

    this.shell.openFilePicker(IMAGE_ACCEPT, (file) => {
      if (String(file.name).toLowerCase().endsWith('.ora')) {
        eventBus.emit('ora:import', file);
        return;
      }
      if (String(file.name).toLowerCase().endsWith('.psd')) {
        eventBus.emit('psd:import', file);
        return;
      }
      this._loadImage(file);
    });
  }

  /**
   * 处理快捷键。只处理编辑器自己关心的键，其余放行给输入控件。
   * @param {KeyboardEvent} e
   */
  _handleKeyDown(e) {
    // Ctrl+Z 撤销
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      this.historyManager?.undo();
      return;
    }

    // Ctrl+Shift+Z 或 Ctrl+Y 重做
    if ((e.ctrlKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && !e.shiftKey && e.key === 'y')) {
      e.preventDefault();
      this.historyManager?.redo();
      return;
    }

    // Delete 删除选中物件
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const active = this.canvasManager?.getActiveObject();
      if (active && active.isEditing) return;
      if (active && active.excludeFromHistory) return;
      this.historyManager?.saveState();
      this.canvasManager?.removeActiveObject();
      return;
    }

    // Ctrl+D（mac: Cmd+D）复制当前选中图层
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      const active = this.canvasManager?.getActiveObject();
      if (!active) return;
      if (active.isEditing) return;                  // 文字编辑中，不拦截
      if (active.excludeFromHistory) return;         // 裁剪框等辅助对象不可复制
      if (active.type === 'activeSelection') return; // 多选暂不支持整体复制

      const meta = this.layerManager?.getLayerByObject(active);
      if (!meta) return;

      e.preventDefault();
      this.historyManager?.saveState();
      this.layerManager.duplicateLayer(meta.id);
      return;
    }

    // 工具快捷键：在输入控件里打字时不抢键
    if (!e.ctrlKey && !e.metaKey) {
      if (this.shell.isTextInputFocused()) return;

      const active = this.canvasManager?.getActiveObject();
      if (active && active.isEditing) return;

      const key = e.key.toUpperCase();
      const tools = this.toolManager?.getTools() || [];
      const tool = tools.find(t => t.shortcut === key);
      if (tool) {
        e.preventDefault();
        this.toolManager?.activateTool(tool.name);
      }
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    if (this._externalSourceTimer) {
      clearTimeout(this._externalSourceTimer);
      this._externalSourceTimer = null;
    }

    if (this._externalSourceFallbackTimer) {
      clearTimeout(this._externalSourceFallbackTimer);
      this._externalSourceFallbackTimer = null;
    }

    // 解绑 EventBus 订阅。EventBus 是全局单例，不解绑会让本实例的闭包
    // 永久驻留（连带整棵对象树无法 GC），并在下次 new App() 后重复响应事件。
    this._eventBusUnsubscribers.forEach(unsub => unsub && unsub());
    this._eventBusUnsubscribers = [];

    // 移除全局事件监听器
    this.shell.unbindGlobalEvents();

    // 解绑宿主生命周期回调
    this._onPluginEnterCallback = null;

    [
      this.accountPage,
      this.toolbar,
      this.optionsBar,
      this.sidePanelTabs,
      this.propertyPanel,
      this.layerPanel,
      this.statusBar,
    ].forEach(component => component?.destroy?.());

    this.toolManager?.destroy?.();
    this.canvasManager?.destroy?.();
  }

  async _loadImage(source) {
    try {
      this.shell.setEditorVisible(true);

      await this.canvasManager.loadImage(source);
      this.canvasManager.fitToCanvas(40);

      this.layerManager.syncLayers();

      this.historyManager.clear();
      this.historyManager.saveState();

      this.hostAdapter?.window?.setHeight?.(EDITOR_WINDOW_HEIGHT);
    } catch (err) {
      console.error('[App] 图片加载失败:', err);
      this.shell.setEditorVisible(false);
      eventBus.emit('toast:show', { message: '图片加载失败，请重试', type: 'error' });
    }
  }

  /**
   * 导入 PSD/ORA 工程文件（从 onPluginEnter 的文件路径）
   * @param {string} filePath
   * @param {'psd'|'ora'} kind
   */
  _importProjectFile(filePath, kind) {
    const dataURL = this.hostAdapter?.file?.readImageFile?.(filePath);
    if (!dataURL) {
      eventBus.emit('toast:show', { message: '文件读取失败', type: 'error' });
      return;
    }
    const match = dataURL.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      eventBus.emit('toast:show', { message: '文件解析失败', type: 'error' });
      return;
    }
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: match[1] });
    if (blob.size === 0) {
      eventBus.emit('toast:show', { message: '文件为空', type: 'error' });
      return;
    }
    this.shell.setEditorVisible(true);
    eventBus.emit(`${kind}:import`, blob);
  }

  /**
   * 解析插件传入的外部图片源。
   * @param {string} type
   * @param {*} payload
   * @returns {string|null}
   */
  _getExternalImageSource(type, payload) {
    const bridged = this.hostAdapter?.getImageSourceFromPayload?.(type, payload);
    if (bridged) return bridged;

    if (type !== 'file' && type !== 'files') return null;

    const files = Array.isArray(payload) ? payload : [payload];
    const fileInfo = files.find(item => item && item.path);
    if (!fileInfo) return null;

    try {
      return this.hostAdapter?.file?.readImageFile?.(fileInfo.path) ?? null;
    } catch (e) {
      console.error('[App] 文件匹配读取失败:', e);
      return null;
    }
  }

  /**
   * 取走宿主适配器暂存的待加载图片源（取后即清，避免重复加载）。
   * @param {string} [expected] 传值时仅在匹配时消费
   * @returns {string|null}
   */
  _consumePendingSource(expected) {
    const pending = this.hostAdapter?.consumePendingImageSource?.();
    if (!pending) return null;

    if (expected !== undefined && pending !== expected) {
      // 不匹配：放回，交给下一次进入处理
      this.hostAdapter?.setPendingImageSource?.(pending);
      return null;
    }

    return pending;
  }

  _checkExternalSource() {
    // 使用事件驱动 + 轮询降级：先检查是否已有图片源，
    // 如果没有则设置一个更长的轮询窗口（10s），等待宿主回调写入。
    const check = () => {
      const source = this._consumePendingSource();
      if (source) {
        console.log('[App] _checkExternalSource 发现图片源，开始加载');
        this._loadImage(source);
        return;
      }
      // 继续等待，直到超时
      this._externalSourceTimer = setTimeout(check, 200);
    };

    // 先等 100ms 再开始检查，给宿主回调留出时间
    this._externalSourceTimer = setTimeout(check, 100);

    // 安全兜底：10 秒后清理定时器。
    // 必须保存句柄，否则 destroy() 后这个定时器仍会执行 10 秒（持有 this）。
    this._externalSourceFallbackTimer = setTimeout(() => {
      this._externalSourceFallbackTimer = null;
      if (this._externalSourceTimer) {
        clearTimeout(this._externalSourceTimer);
        this._externalSourceTimer = null;
        console.log('[App] _checkExternalSource 超时（10s），未发现外部图片源');
      }
    }, 10000);
  }

  _updateZoomLabel() {
    if (this.canvasManager) {
      this.shell.setZoomLabel(this.canvasManager.zoomLevel);
    }
  }

  _getEditorBarsLayout() {
    const saved = getPreference(EDITOR_BARS_LAYOUT_KEY);
    return Object.values(EDITOR_BARS_LAYOUTS).includes(saved) ? saved : EDITOR_BARS_LAYOUTS.PRESETS_TOP;
  }

  _applyEditorBarsLayout(layout) {
    const normalized = Object.values(EDITOR_BARS_LAYOUTS).includes(layout)
      ? layout
      : EDITOR_BARS_LAYOUTS.PRESETS_TOP;

    this.shell.toggleAppClass(
      'app--bars-swapped',
      normalized === EDITOR_BARS_LAYOUTS.STATUS_TOP
    );
  }

  _getEditorSidePanelPosition() {
    const saved = getPreference(EDITOR_SIDE_PANEL_POSITION_KEY);
    return Object.values(EDITOR_SIDE_PANEL_POSITIONS).includes(saved)
      ? saved
      : EDITOR_SIDE_PANEL_POSITIONS.RIGHT;
  }

  _applyEditorSidePanelPosition(position) {
    const normalized = Object.values(EDITOR_SIDE_PANEL_POSITIONS).includes(position)
      ? position
      : EDITOR_SIDE_PANEL_POSITIONS.RIGHT;

    this.shell.toggleAppClass(
      'app--panel-left',
      normalized === EDITOR_SIDE_PANEL_POSITIONS.LEFT
    );
  }

  _getToolbarCollapsed() {
    const saved = getPreference(TOOLBAR_COLLAPSED_KEY);
    return Object.values(TOOLBAR_COLLAPSED).includes(saved)
      ? saved
      : TOOLBAR_COLLAPSED.COLLAPSED;
  }

  _applyToolbarCollapsed(value) {
    const normalized = Object.values(TOOLBAR_COLLAPSED).includes(value)
      ? value
      : TOOLBAR_COLLAPSED.COLLAPSED;

    this.shell.toggleAppClass(
      'app--toolbar-expanded',
      normalized === TOOLBAR_COLLAPSED.EXPANDED
    );
  }
}

export default App;
