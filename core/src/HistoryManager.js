import eventBus from './EventBus.js';
import { diffSnapshots } from './utils/historyDiff.js';

/** 历史缩略图的最大宽度与压缩质量 */
const THUMBNAIL_MAX_WIDTH = 96;
const THUMBNAIL_QUALITY = 0.5;

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
  // 图层元数据：恢复（fromJSON）后 syncLayers 会按当前顺序重新自动命名，
  // 这些字段与画面无关，不能当成「变化」。
  '_layerName',
  '_layerNameAuto',
  '_layerBaseName',
  '_layerLocked',
  '_layerKind',
]);

/**
 * 历史记录管理器 — 撤销/重做 + 当前图片的时间线
 *
 * 历史记录只属于当前正在编辑的这张图：打开/导入新文件时全部清零，
 * 面板里不会出现之前图片的记录。
 *
 * 时间线只记录**操作完成后的画布状态**（多数工具在动手前 saveState，
 * 此时画布正是上一步的结果），所以点击某条记录，恢复的是该操作完成后的画面：
 *
 *   _timeline: [ 打开图片, 画笔, 文字, ... ]  ← 每条 = 那次操作完成后的快照
 *
 * 撤销/重做沿用「操作前存档」栈语义（undoStack / redoStack），行为与
 * 历史版本完全一致；跳转（历史面板点击）会按时间线重建撤销栈。
 *
 * 快照体积大（每个都含图片 base64），因此只有最近 maxSteps 步保留可恢复的
 * 快照；更早的条目仍留在时间线上，只保留标签/时间/缩略图/参数变更，
 * 面板里标记为「仅可查看」。
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

    /** 当前图片的完整时间线（快照 + 标签 + 缩略图 + 参数变更） */
    this._timeline = [];
    /** 当前画布状态对应的条目 id（用于面板高亮），无对应条目时为 null */
    this._currentId = null;

    this._seq = 0;
    // 最近一次「状态未变化」的操作名：多数工具在动手前 saveState，
    // 此时快照还是上一步的结果，标签要留到操作完成时使用。
    this._pendingLabel = null;
    // 跳转/撤销/重做后指向时间线里的目标条目：期间的画布事件（flush/saveState）
    // 是恢复动作的回声，不应产生新记录；用户做出新操作后即恢复记账。
    this._navigationEntryId = null;
  }

  /**
   * 保存当前画布状态（操作前调用，用于撤销）
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
    // 注意：这里不清空重做栈——「操作前存档」不代表新操作已经发生；
    // 重做栈在 flush 记录到真正的新操作时才清空，避免「跳回历史后
    // 只是存档、还没动手」就丢失重做能力。
    const lastUndo = this.undoStack[this.undoStack.length - 1];
    const undoChanged = !(lastUndo && this._isSameSnapshot(lastUndo, json));

    if (undoChanged) {
      this.undoStack.push(json);
      if (this.undoStack.length > this.maxSteps) {
        this.undoStack.shift();
      }
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
    }
    return undoChanged || recordChanged;
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
    if (this._consumeNavigation(json)) {
      this._currentId = this._navigationEntryId;
      this._pendingLabel = null;
      this._notify();
      return false;
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
    // 真正的新操作已完成：旧的重做路径失效
    this.redoStack = [];

    this._notify();
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
   * 取出当前图片时间线上的全部记录（按时间升序，最新在末尾）
   * @returns {Array<{id:string, at:number, label:string, thumbnail:string|null, changes:object|null, restorable:boolean, archived:boolean, current:boolean}>}
   */
  getRecords() {
    return this._timeline.map((entry) => ({
      id: entry.id,
      at: entry.at,
      label: entry.label,
      thumbnail: entry.thumbnail,
      changes: entry.changes || null,
      restorable: !!entry.json,
      archived: false,
      current: entry.id === this._currentId,
    }));
  }

  /**
   * 记录总数（当前图片）
   * @returns {number}
   */
  getRecordCount() {
    return this._timeline.length;
  }

  /**
   * 重置当前图片的历史（打开新图片 / 导入工程时调用）。
   * 历史记录只属于当前图片：换文件即清零，不展示之前的历史。
   */
  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._pendingLabel = null;
    this._navigationEntryId = null;
    this._notify();
  }

  /**
   * 清空当前图片的全部历史，由历史面板的「清空」按钮调用
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this._timeline = [];
    this._currentId = null;
    this._pendingLabel = null;
    this._navigationEntryId = null;
    this._notify();
  }

  /**
   * 启用/禁用历史记录
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  // ── 内部方法 ──

  async _restoreState(json) {
    return this._cm.fromJSON(json);
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

  _notify() {
    eventBus.emit('history:changed', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoCount: this.undoStack.length,
      recordCount: this.getRecordCount(),
    });
  }

  _isSameSnapshot(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;

    try {
      // 用轻量级签名对比，过滤掉图片对象的大体积 src（base64），
      // 避免对大图做深度序列化导致高频保存历史（自由绘制、拖拽等）时卡顿。
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
    //
    // 对象键先排序再序列化：恢复（fromJSON）后同一对象的属性插入顺序可能不同，
    // 属性顺序不影响画面，不应被当成「变化」。
    return JSON.stringify(sortSnapshotKeys(json), (key, value) => {
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
 * 递归把对象的键按字典序重排（数组顺序保持不变）。
 * Fabric 恢复（fromJSON）后同一对象的属性插入顺序可能改变，
 * 序列化字符串随之不同，但属性顺序不影响画面，不能当成「变化」。
 * @param {*} value
 * @returns {*}
 */
function sortSnapshotKeys(value) {
  if (Array.isArray(value)) return value.map(sortSnapshotKeys);

  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortSnapshotKeys(value[key]);
    }
    return sorted;
  }

  return value;
}

export default HistoryManager;
