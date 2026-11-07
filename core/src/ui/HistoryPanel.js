import { eventBus } from '../index.js';
import { escapeHTML, escapeAttr } from '../utils/helpers.js';

/** 清空按钮的二次确认窗口 */
const CLEAR_CONFIRM_MS = 3000;
/** 刷新节流：连续编辑时避免每条记录都同步重绘整张列表 */
const REFRESH_THROTTLE_MS = 40;

/**
 * 历史记录面板
 *
 * 按时间顺序展示全部历史记录（历史存档 + 本次会话），当前步骤高亮；
 * 点击本次会话中仍保留快照的记录可直接回到该步骤。
 * 记录由 HistoryManager 自动写入本机，面板只负责展示与清空。
 */
class HistoryPanel {
  /**
   * @param {HTMLElement} containerEl
   * @param {HistoryManager} historyManager
   */
  constructor(containerEl, historyManager) {
    this._el = containerEl;
    this._hm = historyManager;
    this._unsubscribers = [];
    this._refreshTimer = null;
    this._clearConfirmTimer = null;
    this._pendingClear = false;

    this._renderShell();
    this._bindEvents();
    this._refresh();
  }

  _renderShell() {
    this._el.innerHTML = `
      <div class="panel panel--history">
        <div class="panel__header">
          <span class="panel__title">历史</span>
          <div class="history-panel__actions">
            <span class="history-panel__count" id="history-count">0</span>
            <button class="history-panel__clear" id="history-clear" type="button" title="清空历史记录" aria-label="清空历史记录">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="14" height="14">
                <path d="M3 6h18"/>
                <path d="M8 6V4.5A1.5 1.5 0 019.5 3h5A1.5 1.5 0 0116 4.5V6"/>
                <path d="M5.5 6l1 13.2A1.8 1.8 0 008.3 21h7.4a1.8 1.8 0 001.8-1.8L18.5 6"/>
                <path d="M10 10.5v6M14 10.5v6"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="panel__body panel__body--history" id="history-body">
          <ul class="history-list" id="history-list"></ul>
          <div class="history-empty" id="history-empty" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" width="22" height="22">
              <circle cx="12" cy="12" r="9"/>
              <path d="M12 7v5l3.5 2"/>
            </svg>
            <span>暂无历史记录</span>
          </div>
        </div>
        <div class="history-panel__footer" id="history-footer">记录自动保存在本机</div>
      </div>
    `;
  }

  _bindEvents() {
    this._el.addEventListener('click', (e) => {
      const clearBtn = e.target.closest('#history-clear');
      if (clearBtn) {
        this._handleClearClick();
        return;
      }

      const item = e.target.closest('.history-item');
      if (!item) return;

      if (item.classList.contains('history-item--archived')) {
        eventBus.emit('toast:show', { message: '该记录来自上次会话，仅可查看', type: 'error' });
        return;
      }

      const id = item.dataset.historyId;
      if (id) {
        this._hm.goTo(id);
      }
    });

    this._unsubscribers.push(
      eventBus.on('history:changed', () => this._scheduleRefresh()),
      eventBus.on('image:loaded', () => this._scheduleRefresh())
    );
  }

  _handleClearClick() {
    const btn = this._el.querySelector('#history-clear');
    if (!btn) return;

    if (!this._pendingClear) {
      this._pendingClear = true;
      btn.classList.add('is-confirming');
      btn.title = '再次点击确认清空';
      this._clearConfirmTimer = setTimeout(() => {
        this._pendingClear = false;
        btn.classList.remove('is-confirming');
        btn.title = '清空历史记录';
      }, CLEAR_CONFIRM_MS);
      return;
    }

    clearTimeout(this._clearConfirmTimer);
    this._clearConfirmTimer = null;
    this._pendingClear = false;
    btn.classList.remove('is-confirming');
    btn.title = '清空历史记录';

    this._hm.clear();
    eventBus.emit('toast:show', { message: '历史记录已清空', type: 'success' });
  }

  _scheduleRefresh() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._refresh();
    }, REFRESH_THROTTLE_MS);
  }

  _refresh() {
    const listEl = this._el.querySelector('#history-list');
    const emptyEl = this._el.querySelector('#history-empty');
    const countEl = this._el.querySelector('#history-count');
    if (!listEl) return;

    const records = this._hm.getRecords?.() || [];

    if (countEl) countEl.textContent = String(records.length);
    if (emptyEl) emptyEl.hidden = records.length > 0;

    const currentIndex = records.findIndex((record) => record.current);
    let sessionNo = 0;

    const html = records.map((record, index) => {
      if (!record.archived) sessionNo += 1;

      const classes = ['history-item'];
      if (record.current) classes.push('history-item--current');
      if (record.archived) classes.push('history-item--archived');
      if (currentIndex !== -1 && index > currentIndex && !record.archived) {
        classes.push('history-item--future');
      }

      const thumb = record.thumbnail
        ? `<img class="history-item__thumb" src="${escapeAttr(record.thumbnail)}" alt="" loading="lazy" draggable="false" />`
        : `<span class="history-item__thumb history-item__thumb--empty"></span>`;

      const indexLabel = record.archived ? '上次' : String(sessionNo);
      const time = this._formatTime(record.at);
      const hint = record.archived ? '来自上次会话，仅可查看' : '点击回到这一步';

      return `
        <li class="${classes.join(' ')}" data-history-id="${escapeAttr(record.id)}" title="${escapeAttr(`${record.label} · ${hint}`)}">
          <span class="history-item__index">${indexLabel}</span>
          ${thumb}
          <span class="history-item__meta">
            <span class="history-item__label">${escapeHTML(record.label)}</span>
            <span class="history-item__time">${time}</span>
          </span>
        </li>
      `;
    }).join('');

    listEl.innerHTML = html;

    // 让当前步骤始终可见（列表可能很长）
    const currentEl = listEl.querySelector('.history-item--current');
    currentEl?.scrollIntoView?.({ block: 'nearest' });
  }

  _formatTime(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (value) => String(value).padStart(2, '0');
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();

    return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
  }

  destroy() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._clearConfirmTimer) {
      clearTimeout(this._clearConfirmTimer);
      this._clearConfirmTimer = null;
    }
    this._unsubscribers.forEach((unsubscribe) => unsubscribe());
    this._unsubscribers = [];
  }
}

export default HistoryPanel;
