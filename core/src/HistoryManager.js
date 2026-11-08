import eventBus from './EventBus.js';
import {
  getPreference,
  getJSONPreference,
  setJSONPreference,
  removePreference,
} from './utils/preferences.js';
import { diffSnapshots } from './utils/historyDiff.js';

/** 历史记录在本机的持久化键 */
export const HISTORY_RECORDS_KEY = 'image-toolbox-history-records';
/** 持久化结构版本：v2 按文件分槽位，旧版的扁平数组不再读取 */
const HISTORY_STORE_VERSION = 2;
/** 单个文件最多保留的历史存档条数 */
const MAX_ARCHIVED_RECORDS = 77;
/** 本机最多保留多少个文件的历史（更早的文件槽位按最后编辑时间淘汰） */
const MAX_FILES = 7;
/** 持久化写入防抖，避免连续画笔操作时高频写本地存储 */
const PERSIST_DEBOUNCE_MS = 1200;
/** 历史缩略图的最大宽度与压缩质量 */
const THUMBNAIL_MAX_WIDTH = 96;
const THUMBNAIL_QUALITY = 0.5;
/** 写入失败（本地存储配额有限）时的降级保留策略：文件数 × 每文件条数 */
const PERSIST_FALLBACK_LIMITS = [
  { files: 7, records: 77 },
  { files: 7, records: 47 },
  { files: 3, records: 47 },
  { files: 3, records: 20 },
];

/**
 * 快照比较时忽略的交互属性。
 * 它们会随工具切换（激活/停用模块）变化，但不影响画面内容，
 * 不能算作「历史变化」——否则切一次工具就多一条空记录。
 */
const HISTORY_IGNORED_KEYS = new Set([
  'selectable',
  'evented',
  'hasControls',
  'hasBorders',
  'lockMovementX',
  'lockMovementY',
  'lockRotation',
  'lockScalingX',
  'lockScalingY',
  'hoverCursor',
  'paintFirst',
  'strokeUniform',
  'objectCaching',
  'cornerColor',
  'cornerSize',
  'cornerStyle',
  'transparentCorners',
  'borderColor',
  'perPixelTargetFind',
]);

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
 * 历史记录与当前文件绑定：setFileKey 切换文件时清空内存中的撤销栈与时间线，
 * 并载入该文件自己的历史存档；换文件后不会看到上一个文件的记录。
 *
 * 跨会话：条目摘要（标签/时间/缩略图/参数变更）按文件分槽位写入本机偏好存储，
 * 再次打开同一文件时可查看；快照本身不持久化，因此历史存档只可查看、不可恢复。
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
    /** 当前文件标识（由 setFileKey 绑定；未绑定时归入 unknown） */
    this._fileKey = null;
    /** 当前文件的历史存档（只读） */
    this._archived = [];
    /** 本机全部文件的历史槽位 { [fileKey]: { updatedAt, records } } */
    this._store = this._loadStore();

    this._seq = 0;
    this._persistTimer = null;
    // 最近一次「状态未变化」的操作名：多数工具在动手前 saveState，
    // 此时快照还是上一步的结果，标签要留到下一次真正入栈时使用。
    this._pendingLabel = null;
    // 跳转/撤销/重做后指向时间线里的目标条目：期间的画布事件（flush/saveState）
    // 是恢复动作的回声，不应产生新记录；用户做出新操作后即恢复记账。
    this._navigationEntryId = null;
  }

  /**
   * 绑定当前编辑的文件（历史记录跟随文件）。
   *
   * key 变化时：先把上一个文件的记录写回它的槽位，再清空内存中的撤销栈、
   * 时间线与待定标签，最后载入新文件自己的历史存档。同一个文件重复加载
   * （key 相同）不清空，用户不会因为再次选择同一张图片而丢掉本次历史。
   *
   * @param {string} fileKey
   * @returns {boolean} 是否发生了文件切换
   */
  setFileKey(fileKey) {
    const key = fileKey || 'unknown';
    if (key === this._fileKey) return false;

    // 只把本次会话新增的记录写回上一个文件；单纯读取历史不应改写槽位
    if (this._fileKey && this._timeline.length > 0) {
      this._persistNow();
    }

    this._fileKey = key;
    this._archived = this._getFileRecords(key);
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._pendingLabel = null;
    this._navigationEntryId = null;
    this._notify();
    return true;
  }

  /**
   * 保存当前画布状态（操作前调用，用于撤销）
   *
   * 撤销栈保持「操作前快照」的旧语义；时间线只记录**上一步操作完成后的
   * 画布状态**（多数工具在动手前 saveState，此时画布正是上一步的结果），
   * 所以历史面板里点击某条记录，恢复的是该操作完成后的画面。
   *
   * @param {string} [label] - 记录标签（显示在历史面板上的操作名）
   * @returns {boolean} 是否产生了新的撤销快照或时间线记录
   */
  saveState(label = '编辑') {
    if (!this._enabled || this._isRestoring) return false;
    if (!this._cm.canvas) return false;

    const json = this._cm.toJSON();
    if (!json) return false;

    // ── 撤销栈：保持旧语义，存「操作前快照」 ──
    const lastUndo = this.undoStack[this.undoStack.length - 1];
    const undoChanged = !(lastUndo && this._isSameSnapshot(lastUndo, json));

    if (undoChanged) {
      this.undoStack.push(json);
      if (this.undoStack.length > this.maxSteps) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }

    // ── 时间线：记录「上一步操作完成后的画布状态」 ──
    // 刚做完跳转/撤销时，画布状态本就来自时间线里的某条记录，不重复入账；
    // 直到用户做出新的操作（画布发生变化）才恢复记账。
    let recordChanged = false;
    if (this._consumeNavigation(json)) {
      this._currentId = this._navigationEntryId;
    } else {
      recordChanged = this._appendTimelineIfChanged(json, label);
    }

    // 本次操作名留给「操作完成」时使用；若上一步没有产生画布变化（点击空白等），
    // 旧的操作名随之作废。
    this._pendingLabel = typeof label === 'string' && label ? label : null;

    if (undoChanged || recordChanged) {
      this._notify();
      this._schedulePersist();
    }
    return undoChanged || recordChanged;
  }

  /**
   * 消费「跳转标记」：跳转/撤销后画布状态来自时间线，期间的 flush/saveState
   * 不应把它当成新操作再次入账。
   * @param {object} json 当前画布快照
   * @returns {boolean} true = 当前状态就是跳转目标（消费了标记，跳过记账）
   */
  _consumeNavigation(json) {
    if (!this._navigationEntryId) return false;

    const navEntry = this._timeline.find((entry) => entry.id === this._navigationEntryId);
    if (navEntry?.json && this._isSameSnapshot(navEntry.json, json)) {
      return true;
    }

    // 画布已经变化：用户开始新的操作，恢复记账
    this._navigationEntryId = null;
    return false;
  }

  /**
   * 操作完成时调用（松开鼠标、拖拽结束、文字退出编辑等）：
   * 把当前画布状态作为「该操作完成后的结果」补进时间线。
   *
   * 与 saveState 的分工：
   *   - saveState 负责撤销栈（操作前快照）与「上一步操作后」的落定；
   *   - flush 负责最后一次操作——它没有后续 saveState，需要在这里补记录，
   *     否则用户刚完成的那一步不会出现在历史面板里。
   *
   * flush 不修改撤销栈：撤销所需的操作前快照已由工具在动手前 saveState 入栈。
   *
   * @param {string} [label] - 操作名（未传入时沿用待定标签）
   * @returns {boolean} 是否新增了记录
   */
  flush(label = null) {
    if (!this._enabled || this._isRestoring) return false;
    if (!this._cm.canvas) return false;

    const json = this._cm.toJSON();
    if (!json) return false;

    // 跳转/撤销后的回声：画布状态本就来自时间线，不产生新记录
    if (this._navigationEntryId) {
      const navEntry = this._timeline.find((entry) => entry.id === this._navigationEntryId);
      const navSame = !!(navEntry?.json && this._isSameSnapshot(navEntry.json, json));
      console.warn('[HistoryManager] flush nav check id=', this._navigationEntryId, 'same=', navSame);
      if (!navSame && navEntry?.json) {
        const strip = (value) => JSON.stringify(value, (key, val) => (HISTORY_IGNORED_KEYS.has(key) ? undefined : val));
        const a = strip(navEntry.json);
        const b = strip(json);
        let i = 0;
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        console.warn('[HistoryManager] nav diff at', i, 'A=', a.slice(Math.max(0, i - 60), i + 80), 'B=', b.slice(Math.max(0, i - 60), i + 80));
      }
      if (navSame) {
        this._currentId = this._navigationEntryId;
        this._pendingLabel = null;
        this._notify();
        return false;
      }
      this._navigationEntryId = null;
    }

    const lastRecord = this._timeline[this._timeline.length - 1];
    if (lastRecord?.json && this._isSameSnapshot(lastRecord.json, json)) {
      // 没有实际变化（点击空白、切工具等），不制造空记录
      return false;
    }

    const entryLabel = this._pendingLabel || label || '编辑';
    this._pushTimelineEntry(entryLabel, json, lastRecord?.json || null);
    this._pendingLabel = null;
    this._navigationEntryId = null;

    this._notify();
    this._schedulePersist();
    return true;
  }

  /**
   * 时间线记账：当前状态与最后一条不同时追加一条记录。
   * @param {object} json
   * @param {string} label
   * @returns {boolean} 是否新增了记录
   */
  _appendTimelineIfChanged(json, label) {
    const lastRecord = this._timeline[this._timeline.length - 1];
    if (lastRecord?.json && this._isSameSnapshot(lastRecord.json, json)) {
      return false;
    }

    const entryLabel = this._pendingLabel || label;
    this._pushTimelineEntry(entryLabel, json, lastRecord?.json || null);
    return true;
  }

  /**
   * 向时间线追加一条记录并维护快照上限。
   * @param {string} label
   * @param {object} json
   * @param {object|null} previousJson
   * @returns {object}
   */
  _pushTimelineEntry(label, json, previousJson) {
    const entry = {
      id: `c-${Date.now()}-${++this._seq}`,
      at: Date.now(),
      label: typeof label === 'string' && label ? label : '编辑',
      thumbnail: this._cm.toThumbnailDataURL?.(THUMBNAIL_MAX_WIDTH, THUMBNAIL_QUALITY) || null,
      changes: previousJson ? diffSnapshots(previousJson, json) : { items: [] },
      json,
    };

    this._timeline.push(entry);
    this._trimSnapshots();

    // 当前画布就是刚记录的这条
    this._currentId = entry.id;
    return entry;
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
      this._navigationEntryId = this._currentId;
      this._pendingLabel = null;
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
      this._navigationEntryId = this._currentId;
      this._pendingLabel = null;
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
      this._navigationEntryId = this._currentId;
      this._pendingLabel = null;
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
      changes: entry.changes || null,
      restorable: !!entry.json,
      archived: !entry.json,
      current: entry.id === this._currentId,
    }));

    const archivedRecords = this._archived.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
      changes: entry.changes || null,
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
   * 重置当前文件的编辑历史（重新加载同一文件 / 导入工程时调用）。
   * 先把当前记录并入该文件的存档，再清空时间线；该文件的历史存档仍可查看。
   * 与 clear() 的区别是**不清空**当前文件的历史存档。
   */
  reset() {
    this._persistNow();
    this._archived = this._getFileRecords(this._fileKey);
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._pendingLabel = null;
    this._navigationEntryId = null;
    this._notify();
  }

  /**
   * 清空当前文件的全部历史（含本机存档），由历史面板的「清空」按钮调用。
   * 其它文件的历史槽位不受影响。
   */
  clear() {
    this._cancelPersistTimer();
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._pendingLabel = null;
    this._navigationEntryId = null;
    this._archived = [];

    const key = this._fileKey;
    if (key && this._store.files[key]) {
      delete this._store.files[key];
      this._writeStore(this._store);
    } else if (!key) {
      removePreference(HISTORY_RECORDS_KEY);
    }

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

  /**
   * 读取本机历史存储（v2：按文件分槽位）。
   * 旧版是扁平数组、不区分文件，与「历史跟随文件」不兼容，直接忽略
   * （不删除旧数据，避免误伤；下次写入会覆盖为新结构）。
   * @returns {{version:number, files:Object}}
   */
  _loadStore() {
    const raw = getJSONPreference(HISTORY_RECORDS_KEY, null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && raw.version === HISTORY_STORE_VERSION
      && raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files)) {
      return { version: HISTORY_STORE_VERSION, files: raw.files };
    }
    return { version: HISTORY_STORE_VERSION, files: {} };
  }

  /**
   * 取某个文件的历史存档。
   * @param {string|null} fileKey
   * @returns {Array}
   */
  _getFileRecords(fileKey) {
    if (!fileKey) return [];

    const slot = this._store.files[fileKey];
    if (!slot || !Array.isArray(slot.records)) return [];

    return slot.records
      .map(normalizeRecord)
      .filter((record) => record !== null)
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_ARCHIVED_RECORDS);
  }

  /**
   * 写入本机历史存储；配额不足时按降级策略缩减文件数与每文件条数。
   * @param {object} store
   * @returns {boolean}
   */
  _writeStore(store) {
    for (const limit of PERSIST_FALLBACK_LIMITS) {
      const payload = truncateStore(store, limit);
      if (setJSONPreference(HISTORY_RECORDS_KEY, payload)) {
        return true;
      }
      // 没有持久化层（如 Node 测试环境）时 setPreference 会写内存并返回 false；
      // 能读回就说明本次写入已生效，继续降级只会白丢数据。
      if (getPreference(HISTORY_RECORDS_KEY) !== null) {
        return false;
      }
    }
    return false;
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
   * 把「当前文件的历史存档 + 本次会话记录」写入该文件的槽位。
   * 失败（配额满等）时逐步减少保留条数重试，仍失败则静默放弃——
   * 历史记录丢持久化不应影响编辑本身。
   * @returns {boolean} 是否写入成功
   */
  _persistNow() {
    this._cancelPersistTimer();

    // 没有显式绑定文件（纯测试或异常路径）时归入 unknown，避免记录丢失
    if (!this._fileKey) this._fileKey = 'unknown';

    const sessionRecords = this._timeline.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
      changes: entry.changes || null,
    }));

    const merged = [...this._archived, ...sessionRecords]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_ARCHIVED_RECORDS);

    if (merged.length === 0) {
      // 没有可写内容时不要创建空槽位（否则读取历史会把文件重新排序，挤掉别的文件）
      delete this._store.files[this._fileKey];
      return this._writeStore(this._store);
    }

    this._store.files[this._fileKey] = {
      updatedAt: Date.now(),
      records: merged,
    };

    return this._writeStore(this._store);
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
    //
    // 交互属性（selectable / evented / 锁定 / 控制点样式等）会随工具切换变化，
    // 但它们不影响画面，也不该产生「历史记录」或「参数变更」；比较时剔除，
    // 否则每次切工具都会多出一条空记录。
    return JSON.stringify(json, (key, value) => {
      if (HISTORY_IGNORED_KEYS.has(key)) return undefined;

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

/**
 * 校验一条从本机存档读回的历史记录。
 * @param {*} record
 * @returns {object|null}
 */
function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!Number.isFinite(record.at) || typeof record.id !== 'string') return null;

  return {
    id: record.id,
    at: record.at,
    label: typeof record.label === 'string' && record.label ? record.label : '编辑',
    thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : null,
    changes: normalizeChanges(record.changes),
  };
}

/**
 * 按保留策略裁剪存储：只保留最近 N 个文件，每个文件最多保留 M 条记录。
 * @param {{version:number, files:Object}} store
 * @param {{files:number, records:number}} limit
 * @returns {{version:number, files:Object}}
 */
function truncateStore(store, limit) {
  const keys = Object.keys(store.files);
  keys.sort((a, b) => (store.files[a]?.updatedAt || 0) - (store.files[b]?.updatedAt || 0));

  const files = {};
  for (const key of keys.slice(-limit.files)) {
    const slot = store.files[key];
    const records = Array.isArray(slot?.records) ? slot.records : [];
    files[key] = {
      updatedAt: slot?.updatedAt || 0,
      records: records.slice(-limit.records),
    };
  }

  return { version: HISTORY_STORE_VERSION, files };
}

/**
 * 校验从本机存档读回的变更数据。结构不对就当没有——
 * 历史展示可以降级，但不能因为一条脏数据让面板渲染报错。
 * @param {*} changes
 * @returns {{items: Array}|null}
 */
function normalizeChanges(changes) {
  if (!changes || !Array.isArray(changes.items)) return null;

  const items = changes.items
    .filter((item) => item && typeof item === 'object' && typeof item.kind === 'string')
    .map((item) => ({
      kind: item.kind,
      layer: typeof item.layer === 'string' ? item.layer : '',
      changes: Array.isArray(item.changes)
        ? item.changes
          .filter((change) => change && typeof change.label === 'string')
          .map((change) => ({
            label: change.label,
            from: String(change.from ?? ''),
            to: String(change.to ?? ''),
          }))
        : [],
    }));

  return items.length > 0 ? { items } : null;
}

export default HistoryManager;
