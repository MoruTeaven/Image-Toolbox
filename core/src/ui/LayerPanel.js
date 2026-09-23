import { eventBus } from '../index.js';
import { escapeHTML, escapeAttr } from '../utils/helpers.js';

/**
 * 图层面板 UI 组件
 * 显示所有图层列表，支持显隐/锁定/选中/排序 + 右键菜单（复制/重命名/删除）
 */
class LayerPanel {
  /**
   * @param {HTMLElement} containerEl
   * @param {LayerManager} layerManager
   * @param {HistoryManager} [historyManager] - 用于复制/删除图层前先存档
   */
  constructor(containerEl, layerManager, historyManager = null) {
    this._el = containerEl;
    this._lm = layerManager;
    this._hm = historyManager;
    this._dragLayerId = null;
    this._dropPanelIndex = null;
    this._selectedLayerId = null;
    this._activeLayerIds = [];
    this._eventBusUnsubscribers = [];
    this._menuEl = null;        // 浮动右键菜单 DOM
    this._menuLayerId = null;   // 触发菜单的图层 ID（操作作用于该项，而非当前选中项）
    this._renamingLayerId = null; // 正在重命名的图层 ID
    this._menuVisible = false;  // 菜单是否已打开

    this._bindEvents();
    this._render();
  }

  _render() {
    this._el.innerHTML = `
      <div class="panel panel--layer">
        <div class="panel__header">
          <span class="panel__title">图层</span>
          <span class="panel__title" id="layer-count">0</span>
        </div>
        <div class="panel__body" id="layer-list-container">
          <ul class="layer-list" id="layer-list"></ul>
        </div>
        <div class="layer-actions">
          <button class="layer-actions__btn" id="layer-delete" title="删除图层">-</button>
          <button class="layer-actions__btn" id="layer-duplicate" title="复制图层">⧉</button>
          <button class="layer-actions__btn" id="layer-add" title="添加图层（选中工具点击画布）">+</button>
        </div>
      </div>
    `;

    // 懒创建全局右键菜单容器，避免与面板重绘相互影响
    if (!this._menuEl || !document.body.contains(this._menuEl)) {
      this._menuEl = document.createElement('div');
      this._menuEl.className = 'layer-context-menu';
      this._menuEl.style.display = 'none';
      document.body.appendChild(this._menuEl);
      this._bindMenuEvents();
    }

    this._refreshLayerList();
  }

  _bindEvents() {
    // Refresh the list when layers change.
    this._eventBusUnsubscribers.push(
      eventBus.on('layers:updated', () => {
        this._refreshLayerList();
      }),
      eventBus.on('canvas:objectAdded', (obj) => {
        this._lm.syncLayers();
        this._selectLayerByObject(obj);
      }),
      eventBus.on('canvas:objectRemoved', () => {
        this._lm.syncLayers();
      }),
      eventBus.on('canvas:objectModified', () => {
        this._lm.syncLayers();
      }),
      eventBus.on('canvas:objectMetadataChanged', () => {
        this._lm.syncLayers();
      }),
      eventBus.on('canvas:selectionCreated', () => this._selectLayerFromActiveObject()),
      eventBus.on('canvas:selectionUpdated', () => this._selectLayerFromActiveObject()),
      eventBus.on('canvas:selectionCleared', () => {
        this._activeLayerIds = [];
        this._refreshLayerList();
      }),
      eventBus.on('layer:selected', (meta) => {
        this._selectedLayerId = meta?.id ?? null;
        this._activeLayerIds = meta ? [meta.id] : [];
        this._refreshLayerList();
      }),
      eventBus.on('image:loaded', () => {
        this._selectedLayerId = null;
        this._activeLayerIds = [];
        this._refreshLayerList();
      }),
      eventBus.on('canvas:restored', () => {
        this._selectedLayerId = null;
        this._activeLayerIds = [];
        this._refreshLayerList();
      })
    );

    // 事件委托
    this._el.addEventListener('click', (e) => {
      const layerItem = e.target.closest('.layer-item');
      if (!layerItem) {
        // Check whether an action button was clicked.
        this._handleActionClick(e);
        return;
      }

      const layerId = parseInt(layerItem.dataset.layerId);
      if (isNaN(layerId)) return;

      // Toggle visibility.
      if (e.target.closest('.layer-item__visibility')) {
        this._lm.toggleVisibility(layerId);
        return;
      }

      // 锁定切换
      if (e.target.closest('.layer-item__lock')) {
        this._lm.toggleLock(layerId);
        return;
      }

      // 选中图层
      this._selectedLayerId = layerId;
      this._activeLayerIds = [];
      this._refreshLayerList();
      this._lm.selectLayer(layerId);
    });

    // 右键菜单事件绑定（contextmenu）
    this._el.addEventListener('contextmenu', (e) => {
      const layerItem = e.target.closest('.layer-item');
      if (!layerItem) return;

      const layerId = parseInt(layerItem.dataset.layerId);
      if (isNaN(layerId)) return;
      e.preventDefault();

      const meta = this._lm.getLayerById(layerId);
      if (meta) {
        this._showContextMenu(e.clientX, e.clientY, layerId);
      }
    });

    this._el.addEventListener('dragstart', (e) => this._handleDragStart(e));
    this._el.addEventListener('dragover', (e) => this._handleDragOver(e));
    this._el.addEventListener('drop', (e) => this._handleDrop(e));
    this._el.addEventListener('dragend', () => this._handleDragEnd());
    this._el.addEventListener('dragleave', (e) => {
      if (!this._el.contains(e.relatedTarget)) {
        this._clearDropIndicators(false);
      }
    });
  }

  _bindMenuEvents() {
    // 菜单项点击（事件委托，渲染时机在 _showContextMenu）
    this._menuEl.addEventListener('click', (e) => {
      const item = e.target.closest('.layer-context-menu__item');
      if (!item || item.classList.contains('layer-context-menu__item--disabled')) return;
      const action = item.dataset.action;
      const layerId = this._menuLayerId;
      this._hideMenu();
      if (layerId !== null) {
        this._handleMenuItemClick(action, layerId);
      }
    });

    // 全局关闭监听：菜单打开时注册，关闭时移除
    this._onDocMouseDown = (ev) => {
      if (this._menuEl && !this._menuEl.contains(ev.target)) {
        this._hideMenu();
      }
    };
    this._onDocKeyDown = (e) => {
      if (e.key === 'Escape' && this._menuVisible) {
        this._hideMenu();
      }
    };
    this._onDocScroll = () => this._hideMenu();
  }

  _showContextMenu(x, y, layerId) {
    const meta = this._lm.getLayerById(layerId);
    if (!meta) return;

    this._menuLayerId = layerId;
    const isBg = !!meta.isBackground;
    const canDelete = !isBg && !meta.locked;

    this._menuEl.innerHTML = `
      <div class="layer-context-menu__item ${isBg ? 'layer-context-menu__item--disabled' : ''}" data-action="duplicate" title="${isBg ? '背景图层不可复制' : '复制当前图层'}">复制图层</div>
      <div class="layer-context-menu__item" data-action="rename">重命名</div>
      <div class="layer-context-menu__item ${canDelete ? '' : 'layer-context-menu__item--disabled'}" data-action="delete" title="${isBg ? '背景图层不可删除' : (meta.locked ? '图层已锁定，请先解锁' : '删除当前图层')}">删除图层</div>
    `;
    this._menuEl.style.display = 'block';
    this._menuVisible = true;

    // 定位：贴靠鼠标，并限制在视口内
    const rect = this._menuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    this._menuEl.style.left = `${left}px`;
    this._menuEl.style.top = `${top}px`;

    document.addEventListener('mousedown', this._onDocMouseDown);
    document.addEventListener('keydown', this._onDocKeyDown);
    window.addEventListener('scroll', this._onDocScroll, true);
  }

  _hideMenu() {
    if (!this._menuEl) return;
    this._menuEl.style.display = 'none';
    this._menuLayerId = null;
    this._menuVisible = false;
    document.removeEventListener('mousedown', this._onDocMouseDown);
    document.removeEventListener('keydown', this._onDocKeyDown);
    window.removeEventListener('scroll', this._onDocScroll, true);
  }

  async _handleMenuItemClick(action, layerId) {
    const meta = this._lm.getLayerById(layerId);
    if (!meta) return;

    if (action === 'duplicate') {
      if (meta.isBackground) return;
      await this._duplicateLayer(layerId);
      return;
    }

    if (action === 'rename') {
      this._startRenaming(layerId);
      return;
    }

    if (action === 'delete') {
      if (meta.isBackground || meta.locked) return;
      this._hm?.saveState();
      this._lm.deleteLayer(layerId);
      this._selectedLayerId = null;
      this._activeLayerIds = [];
    }
  }

  /**
   * 复制图层（统一入口：先存档再变更，与工具栏删除按钮/快捷键行为一致）
   * @param {number} layerId
   */
  async _duplicateLayer(layerId) {
    const meta = this._lm.getLayerById(layerId);
    if (!meta || meta.isBackground) return;

    this._hm?.saveState();
    const newMeta = await this._lm.duplicateLayer(layerId);
    if (newMeta) {
      this._selectedLayerId = newMeta.id;
      this._activeLayerIds = [newMeta.id];
      this._refreshLayerList();
      this._lm.selectLayer(newMeta.id);
    }
  }

  /**
   * 内联重命名：把图层项名称切换为输入框
   * @param {number} layerId
   */
  _startRenaming(layerId) {
    const item = this._el.querySelector(`.layer-item[data-layer-id="${layerId}"]`);
    const nameEl = item?.querySelector('.layer-item__name');
    if (!nameEl) return;

    const meta = this._lm.getLayerById(layerId);
    if (!meta) return;

    // 避免重复进入编辑态
    if (this._renamingLayerId === layerId) return;
    this._renamingLayerId = layerId;

    const original = meta.name;
    nameEl.innerHTML = `<input class="layer-item__rename-input" type="text" value="${escapeAttr(original)}" maxlength="64" />`;
    const input = nameEl.querySelector('input');
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (next && next !== original) {
        this._lm.renameLayer(layerId, next);
      }
      this._renamingLayerId = null;
      this._refreshLayerList();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      this._renamingLayerId = null;
      this._refreshLayerList();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 阻止全局 Delete/快捷键误触发
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  _handleDragStart(e) {
    const layerItem = e.target.closest('.layer-item');
    if (!layerItem) return;

    const layerId = parseInt(layerItem.dataset.layerId);
    const layer = this._lm.getLayerById(layerId);
    if (!layer || layer.isBackground) {
      e.preventDefault();
      return;
    }

    this._dragLayerId = layerId;
    this._dropPanelIndex = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(layerId));
    layerItem.classList.add('layer-item--dragging');
  }

  _handleDragOver(e) {
    if (this._dragLayerId === null) return;

    const dropInfo = this._getDropInfo(e);
    if (!dropInfo) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    this._clearDropIndicators(false);
    this._dropPanelIndex = dropInfo.panelIndex;

    if (this._isNoopDrop(dropInfo.panelIndex)) return;

    dropInfo.item.classList.add(
      dropInfo.position === 'after' ? 'layer-item--drop-after' : 'layer-item--drop-before'
    );
  }

  _handleDrop(e) {
    if (this._dragLayerId === null) return;

    e.preventDefault();
    e.stopPropagation();

    const dropInfo = this._getDropInfo(e);
    const targetIndex = dropInfo ? dropInfo.panelIndex : this._dropPanelIndex;

    if (targetIndex !== null && !this._isNoopDrop(targetIndex)) {
      this._lm.reorderLayer(this._dragLayerId, targetIndex);
    }

    this._handleDragEnd();
  }

  _handleDragEnd() {
    this._dragLayerId = null;
    this._dropPanelIndex = null;
    this._clearDropIndicators();
  }

  _getDropInfo(e) {
    const item = e.target.closest('.layer-item');
    if (!item) return null;

    const targetLayerId = parseInt(item.dataset.layerId);
    const layers = this._lm.getLayers();
    const targetLayer = layers.find(l => l.id === targetLayerId);
    if (!targetLayer) return null;

    const overlayLayers = layers.filter(l => !l.isBackground);
    if (targetLayer.isBackground) {
      return {
        item,
        panelIndex: overlayLayers.length,
        position: 'before',
      };
    }

    const targetIndex = overlayLayers.findIndex(l => l.id === targetLayerId);
    if (targetIndex === -1) return null;

    const rect = item.getBoundingClientRect();
    const position = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';

    return {
      item,
      panelIndex: targetIndex + (position === 'after' ? 1 : 0),
      position,
    };
  }

  _isNoopDrop(panelIndex) {
    if (this._dragLayerId === null) return true;

    const overlayLayers = this._lm.getLayers().filter(l => !l.isBackground);
    const fromIndex = overlayLayers.findIndex(l => l.id === this._dragLayerId);
    if (fromIndex === -1) return true;

    let insertIndex = Math.max(0, Math.min(panelIndex, overlayLayers.length));
    if (fromIndex < insertIndex) insertIndex -= 1;
    return insertIndex === fromIndex;
  }

  _clearDropIndicators(includeDragging = true) {
    const selector = includeDragging
      ? '.layer-item--dragging, .layer-item--drop-before, .layer-item--drop-after'
      : '.layer-item--drop-before, .layer-item--drop-after';

    this._el.querySelectorAll(selector)
      .forEach(item => {
        item.classList.remove('layer-item--dragging', 'layer-item--drop-before', 'layer-item--drop-after');
      });
  }

  _handleActionClick(e) {
    const target = e.target;
    if (target.id === 'layer-delete') {
      const selected = this._getSelectedLayerId();
      if (selected !== null) {
        this._hm?.saveState();
        this._lm.deleteLayer(selected);
      }
      return;
    }

    if (target.id === 'layer-duplicate') {
      const selected = this._getSelectedLayerId();
      if (selected !== null) {
        this._duplicateLayer(selected);
      }
      return;
    }

    if (target.id === 'layer-add') {
      eventBus.emit('tool:requestChange', 'text');
    }
  }

  _getSelectedLayerId() {
    return this._selectedLayerId;
  }

  _selectLayerFromActiveObject() {
    const active = this._lm._cm?.getActiveObject();
    const layerIds = this._getSelectedLayerIds(active);
    this._activeLayerIds = layerIds;
    if (layerIds.length > 0) {
      this._selectedLayerId = layerIds[0];
    }
    this._refreshLayerList();
  }

  _selectLayerByObject(obj) {
    if (!obj || obj.excludeFromLayer) return;

    const meta = this._lm.getLayerByObject?.(obj) || this._lm._findMeta?.(obj);
    if (!meta) return;

    this._selectedLayerId = meta.id;
    this._activeLayerIds = [meta.id];
    this._refreshLayerList();
  }

  _getSelectedLayerIds(activeObj) {
    if (!activeObj) return [];

    const objects = activeObj.type === 'activeSelection' && typeof activeObj.getObjects === 'function'
      ? activeObj.getObjects()
      : [activeObj];

    return objects
      .map(obj => this._lm.getLayerByObject?.(obj) || this._lm._findMeta?.(obj))
      .filter(Boolean)
      .map(meta => meta.id);
  }

  _getSelectedLayerIdSet() {
    const ids = this._activeLayerIds;
    return ids.length > 0 ? new Set(ids) : new Set(this._selectedLayerId === null ? [] : [this._selectedLayerId]);
  }

  _ensureSelectedLayerExists(layers) {
    const layerIds = new Set(layers.map(layer => layer.id));
    this._activeLayerIds = this._activeLayerIds.filter(id => layerIds.has(id));

    if (this._selectedLayerId === null) return;
    if (!layerIds.has(this._selectedLayerId)) {
      this._selectedLayerId = null;
    }
  }

  _refreshLayerList() {
    // Prevent refresh -> syncLayers -> emit('layers:updated') -> refresh loops.
    if (this._refreshing) return;
    this._refreshing = true;

    const listEl = this._el.querySelector('#layer-list');
    const countEl = this._el.querySelector('#layer-count');
    if (!listEl) { this._refreshing = false; return; }

    this._lm.syncLayers();
    const layers = this._lm.getLayers();
    this._ensureSelectedLayerExists(layers);
    if (countEl) countEl.textContent = layers.length;

    const selectedLayerIds = this._getSelectedLayerIdSet();

    // 图标映射
    const typeIcons = {
      'i-text': 'T',
      'text': 'T',
      'textbox': 'T',
      'rect': '+',
      'circle': 'O',
      'image': '🖼',
      'group': '+',
      'path': '~',
      'triangle': '^',
    };

    let html = '';
    for (const layer of layers) {
      const isSelected = selectedLayerIds.has(layer.id);
      const isBg = layer.isBackground;

      // Use a custom icon for the background layer.
      const icon = isBg
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`
        : (typeIcons[layer.fabricObj.type] || '□');

      const eyeIcon = layer.visible
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

      // 背景图层锁定图标灰显
      const lockIconClass = isBg ? 'layer-item__lock--bg' : (layer.locked ? 'layer-item__lock--locked' : '');
      const lockIcon = layer.locked
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
      const layerName = this._escapeHTML(layer.name);
      const layerTitle = this._escapeAttr(layer.name);

      html += `
        <li class="layer-item ${isSelected ? 'layer-item--selected' : ''} ${isBg ? 'layer-item--background' : ''}" data-layer-id="${layer.id}" draggable="${!isBg}" aria-selected="${isSelected}">
          <span class="layer-item__visibility" title="${layer.visible ? '隐藏' : '显示'}">${eyeIcon}</span>
          <span class="layer-item__thumbnail">${icon}</span>
          <span class="layer-item__name" title="${layerTitle}">${layerName}</span>
          <span class="layer-item__lock ${lockIconClass}" title="${isBg ? '背景图层固定在底部' : (layer.locked ? '解锁' : '锁定')}">${lockIcon}</span>
        </li>
      `;
    }

    if (layers.length === 0) {
      html = '<div style="padding:16px 8px;text-align:center;color:var(--color-text-secondary);font-size:11px;">暂无图层</div>';
    }

    listEl.innerHTML = html;
    this._refreshing = false;
  }

  _escapeHTML(value) {
    return escapeHTML(value);
  }

  _escapeAttr(value) {
    return escapeAttr(value);
  }

  destroy() {
    this._hideMenu();
    this._menuEl?.remove();
    this._menuEl = null;
    this._eventBusUnsubscribers.forEach(unsub => unsub());
    this._eventBusUnsubscribers = [];
  }
}

export default LayerPanel;
