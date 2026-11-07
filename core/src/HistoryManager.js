import eventBus from './EventBus.js';
import {
  getJSONPreference,
  setJSONPreference,
  removePreference,
} from './utils/preferences.js';

/** 历史记录在本机的持久化键 */
export const HISTORY_RECORDS_KEY = 'image-toolbox-history-records';
/** 历史存档最多保留的条数（缩略图很小，200 条约数百 KB） */
const MAX_ARCHIVED_RECORDS = 200;
/** 持久化写入防抖，避免连续画笔操作时高频写本地存储 */
const PERSIST_DEBOUNCE_MS = 1200;
/** 历史缩略图的最大宽度与压缩质量 */
const THUMBNAIL_MAX_WIDTH = 96;
const THUMBNAIL_QUALITY = 0.5;
/** 写入失败时的降级保留条数（本地存储配额有限） */
const PERSIST_FALLBACK_LIMITS = [MAX_ARCHIVED_RECORDS, 100, 47, 20];

/**
 * 历史记录管理器 — 撤销/重做 + 可查看的完整时间线
 *
 * 撤销/重做沿用原有的「修改前存档」栈语义（undoStack / redoStack），
 * 行为与历史版本完全一致；在此之上额外维护一条 `_timeline`，
 * 记录每次入栈的操作标签、时间与缩略图，供历史面板展示与跳转：
 *
 *   undoStack: [ ...修改前的快照 ]  ← undo 时弹出，画布回到该快照
 *   _timeline: [ ...全部快照条目 ]   ← 只增不减，用于「查看所有历史记录」
 *
 * 快照体积大（每个都含图片 base64），因此只有最近 maxSteps 步保留可恢复的
 * 快照；更早的条目仍留在时间线上，只保留标签/时间/缩略图，面板里标记为
 * 「仅可查看」。这样「查看所有历史记录」与内存占用可以兼得。
 *
 * 跨会话：条目摘要（标签/时间/缩略图）写入本机偏好存储，重开后可查看；
 * 快照本身不持久化，因此历史存档只可查看、不可恢复。
 */
class HistoryManager {
  /**
   * @param {CanvasManager} canvasManager
   * @param {number} [maxSteps] - 最多保留多少个可恢复快照
   */
  constructor(canvasManager, maxSteps = 30) {
    this._cm = canvasManager;
    this.undoStack = [];
    this.redoStack = [];
    this.maxSteps = maxSteps;
    this._enabled = true;
    this._isRestoring = false; // 防止恢复时触发保存

    /** 本次编辑会话的完整时间线（快照 + 标签 + 缩略图） */
    this._timeline = [];
    /** 当前画布状态对应的条目 id（用于面板高亮），无对应条目时为 null */
    this._currentId = null;
    /** 上次会话留存的历史存档（只读） */
    this._archived = this._loadArchived();

    this._seq = 0;
    this._persistTimer = null;
  }

  /**
   * 保存当前画布状态
   * @param {string} [label] - 记录标签（显示在历史面板上的操作名）
   * @returns {boolean} 是否真正入栈（状态未变化时返回 false）
   */
  saveState(label = '编辑') {
    if (!this._enabled || this._isRestoring) return false;
    if (!this._cm.canvas) return false;

    const json = this._cm.toJSON();
    if (!json) return false;

    const last = this.undoStack[this.undoStack.length - 1];
    if (last && this._isSameSnapshot(last, json)) return false;

    this.undoStack.push(json);

    // 限制栈大小
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }

    // 新操作清空重做栈
    this.redoStack = [];

    this._timeline.push({
      id: `c-${Date.now()}-${++this._seq}`,
      at: Date.now(),
      label: typeof label === 'string' && label ? label : '编辑',
      thumbnail: this._cm.toThumbnailDataURL?.(THUMBNAIL_MAX_WIDTH, THUMBNAIL_QUALITY) || null,
      json,
    });
    this._trimSnapshots();

    // 当前画布就是刚入栈的快照
    this._currentId = this._timeline[this._timeline.length - 1].id;

    this._notify();
    this._schedulePersist();
    return true;
  }

  /**
   * 撤销
   */
  async undo() {
    if (!this.canUndo()) return;
    if (this._isRestoring) return; // 防止恢复期间重复触发

    this._isRestoring = true;

    const currentJson = this._cm.toJSON();
    let prevJson = this.undoStack.pop();

    while (prevJson && currentJson && this._isSameSnapshot(prevJson, currentJson) && this.undoStack.length > 0) {
      prevJson = this.undoStack.pop();
    }

    if (!prevJson || (currentJson && this._isSameSnapshot(prevJson, currentJson))) {
      this._isRestoring = false;
      this._notify();
      return;
    }

    if (currentJson) {
      this.redoStack.push(currentJson);
    }

    try {
      await this._restoreState(prevJson);
      this._currentId = this._findEntryIdBySnapshot(prevJson);
    } catch (err) {
      console.error('[HistoryManager] undo 失败:', err);
    } finally {
      this._isRestoring = false;
      this._notify();
    }
  }

  /**
   * 重做
   */
  async redo() {
    if (!this.canRedo()) return;
    if (this._isRestoring) return; // 防止恢复期间重复触发

    this._isRestoring = true;

    // 保存当前状态到撤销栈
    const currentJson = this._cm.toJSON();
    if (currentJson) {
      this.undoStack.push(currentJson);
    }

    // 恢复下一个状态
    const nextJson = this.redoStack.pop();
    try {
      await this._restoreState(nextJson);
      this._currentId = this._findEntryIdBySnapshot(nextJson);
    } catch (err) {
      console.error('[HistoryManager] redo 失败:', err);
    } finally {
      this._isRestoring = false;
      this._notify();
    }
  }

  /**
   * 跳转到指定历史记录（历史面板点击）
   * 跳转后重建撤销/重做栈，使随后的撤销、重做沿时间线继续工作。
   * @param {string} id - 记录 id
   * @returns {Promise<boolean>} 是否恢复成功
   */
  async goTo(id) {
    if (this._isRestoring) return false;

    const index = this._timeline.findIndex((entry) => entry.id === id);
    if (index === -1) return false;

    const entry = this._timeline[index];
    if (!entry.json) return false;

    this._isRestoring = true;
    try {
      await this._restoreState(entry.json);

      // 撤销栈 = 目标之前的快照（最近 maxSteps 个），栈顶是目标的前一步
      this.undoStack = this._timeline
        .slice(0, index)
        .filter((item) => item.json)
        .map((item) => item.json)
        .slice(-this.maxSteps);

      // 重做栈 = 目标之后的快照，倒序入栈使栈顶是下一条
      this.redoStack = this._timeline
        .slice(index + 1)
        .filter((item) => item.json)
        .map((item) => item.json)
        .reverse();

      this._currentId = entry.id;
      return true;
    } catch (err) {
      console.error('[HistoryManager] 跳转历史记录失败:', err);
      return false;
    } finally {
      this._isRestoring = false;
      this._notify();
    }
  }

  /**
   * 是否可撤销
   * @returns {boolean}
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * 是否可重做
   * @returns {boolean}
   */
  canRedo() {
    return this.redoStack.length > 0;
  }

  /**
   * 取出时间线上的全部记录（存档在前、本次会话在后，按时间升序）
   * @returns {Array<{id:string, at:number, label:string, thumbnail:string|null, restorable:boolean, archived:boolean, current:boolean}>}
   */
  getRecords() {
    const sessionRecords = this._timeline.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
      restorable: !!entry.json,
      archived: !entry.json,
      current: entry.id === this._currentId,
    }));

    const archivedRecords = this._archived.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
      restorable: false,
      archived: true,
      current: false,
    }));

    return [...archivedRecords, ...sessionRecords].sort((a, b) => a.at - b.at);
  }

  /**
   * 记录总数（本次会话 + 历史存档）
   * @returns {number}
   */
  getRecordCount() {
    return this._timeline.length + this._archived.length;
  }

  /**
   * 重置本次编辑的历史（加载新图片 / 导入工程时调用）。
   * 先把当前记录并入本机存档，避免「打开新图 → 之前的记录消失」；
   * 与 clear() 的区别是**不清空**历史存档。
   */
  reset() {
    this._persistNow();
    this._archived = this._loadArchived();
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._notify();
  }

  /**
   * 清空全部历史（含本机存档），由历史面板的「清空」按钮调用
   */
  clear() {
    this._cancelPersistTimer();
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._archived = [];
    removePreference(HISTORY_RECORDS_KEY);
    this._notify();
  }

  /**
   * 启用/禁用历史记录
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  /**
   * 停止定时器并把待写入的记录落盘（组件销毁时调用）
   */
  destroy() {
    this._persistNow();
  }

  // ── 内部方法 ──

  async _restoreState(json) {
    return this._cm.fromJSON(json);
  }

  /**
   * 按快照内容反查时间线条目 id（用于撤销/重做后高亮当前步骤）
   * @param {object} json
   * @returns {string|null}
   */
  _findEntryIdBySnapshot(json) {
    if (!json) return null;

    for (let i = this._timeline.length - 1; i >= 0; i--) {
      const entry = this._timeline[i];
      if (entry.json && this._isSameSnapshot(entry.json, json)) return entry.id;
    }
    return null;
  }

  /**
   * 只保留最近 maxSteps 个可恢复快照；更早的条目释放 json，但保留在时间线上
   */
  _trimSnapshots() {
    const limit = Math.max(1, this.maxSteps);
    let snapshotCount = this._timeline.reduce((count, entry) => count + (entry.json ? 1 : 0), 0);

    for (let i = 0; i < this._timeline.length && snapshotCount > limit; i++) {
      const entry = this._timeline[i];
      if (!entry.json) continue;
      entry.json = null;
      snapshotCount -= 1;
    }
  }

  _notify() {
    eventBus.emit('history:changed', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoCount: this.undoStack.length,
      recordCount: this.getRecordCount(),
    });
  }

  _loadArchived() {
    const raw = getJSONPreference(HISTORY_RECORDS_KEY, null);
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((entry) => entry && Number.isFinite(entry.at) && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        at: entry.at,
        label: typeof entry.label === 'string' && entry.label ? entry.label : '编辑',
        thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : null,
      }))
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_ARCHIVED_RECORDS);
  }

  _schedulePersist() {
    this._cancelPersistTimer();
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  _cancelPersistTimer() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
  }

  /**
   * 把「历史存档 + 本次会话记录」写入本机。
   * 失败（配额满等）时逐步减少保留条数重试，仍失败则静默放弃——
   * 历史记录丢持久化不应影响编辑本身。
   * @returns {boolean} 是否写入成功
   */
  _persistNow() {
    this._cancelPersistTimer();

    const sessionRecords = this._timeline.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
    }));

    const merged = [...this._archived, ...sessionRecords].sort((a, b) => a.at - b.at);

    for (const limit of PERSIST_FALLBACK_LIMITS) {
      if (setJSONPreference(HISTORY_RECORDS_KEY, merged.slice(-limit))) {
        return true;
      }
    }
    return false;
  }

  _isSameSnapshot(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;

    try {
      // 用轻量级签名对比，过滤掉图片对象的大体积 src（base64），
      // 避免对大图做深度序列化导致高频保存历史（自由绘制、拖拽等）时卡顿。
      // src 被替换为「长度:首段:中段:尾段」的内容指纹，仍可识别图片是否被替换。
      return this._snapshotSignature(a) === this._snapshotSignature(b);
    } catch (err) {
      return false;
    }
  }

  _snapshotSignature(json) {
    // 使用更强的内容指纹：首尾各 32 字符 + 长度 + 中间 16 字符，
    // 显著降低碰撞概率，同时仍然避免对大图做完整序列化。
    return JSON.stringify(json, (key, value) => {
      if (key === 'src' && typeof value === 'string' && value.length > 64) {
        const len = value.length;
        const head = value.slice(0, 32);
        const tail = value.slice(-32);
        const mid = value.slice(Math.floor(len / 2) - 8, Math.floor(len / 2) + 8);
        return `${len}:${head}:${mid}:${tail}`;
      }
      return value;
    });
  }
}

export default HistoryManager;
