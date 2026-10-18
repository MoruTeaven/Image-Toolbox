/**
 * canvas 级 clipPath 的共享换入换出会话。
 *
 * 背景（真实发生过的事故，不是假想）：
 * 裁剪/打码模块进入时需要把画布级 clipPath 临时摘掉，否则交互辅助图形会被一起
 * 裁掉。MosaicModule 和 CropModule 各自实现了一份摘除/恢复逻辑，各自缓存
 *   this._detachedCanvasClipPath   // 被摘掉的画布级 clipPath
 *   this._clipPathDetached
 *   this._objectClipPathBackups     // 被临时挂上 clipPath 的对象及其原值
 * 两份逻辑操作的是同一份画布级全局状态，各自的备份会互相覆盖：恢复时把对方的
 * 临时 clipPath 当成原始值写回，导致图层被永久裁掉——而且因为模块各自维护状态，
 * 漏调一次恢复不会立刻报错，损坏要等到后续某次操作才显形。
 *
 * 因此这里把「换入换出」收敛成唯一的会话对象：状态只有一份，参与者显式登记，
 * 恢复只能由持有会话的那一方完成。
 *
 * 用法：
 *   const session = acquireClipPathSession(canvas, {
 *     exclude: [this._selectionRect, this._brushPreview, ...],  // 不参与临时挂载的辅助对象
 *     onRender: () => this._requestRender(),
 *   });
 *   // ... 期间画布级 clipPath 被摘除，对象级临时挂上等价 clipPath
 *   session.withCanvasClipPath(() => { ... });  // 暂存原值并跑一段，再自动还原
 *   session.release();                          // 归还：恢复对象级原值 + 写回画布级 clipPath
 *
 * 不变量（由 scripts/verify-clip-path-session.mjs 守护）：
 *   1. release() 后 canvas.clipPath 必须回到 acquire 时的同一实例（不是等价副本）；
 *   2. release() 后每个参与对象的 clipPath 必须回到它自己的原值，互不污染；
 *   3. 嵌套持有同一 canvas 的第二个会话不得破坏第一个的备份；
 *   4. acquire 后未 release 就再次 acquire，必须能检测到（残留持有者）而不是静默覆盖；
 *   5. release 幂等：重复 release 不得把 clipPath 写成 null。
 */

/**
 * 判断一个对象是否应排除在「临时挂载」之外（辅助图形，本来就不该被裁）。
 * @param {object} obj fabric 对象
 * @param {Array<object>} exclude 需要排除的辅助对象列表
 * @returns {boolean}
 */
function isExcluded(obj, exclude) {
  return Array.isArray(exclude) && exclude.indexOf(obj) !== -1;
}

/**
 * 取得一个画布上的 clipPath 会话；同一画布同时只允许一个活跃会话。
 *
 * @param {object} canvas fabric.Canvas（或具备 clipPath / getObjects / requestRenderAll 的对象）
 * @param {{exclude?: Array<object>, onRender?: function}} [options]
 * @returns {{canvas: object, release: function, withCanvasClipPath: function, isHeld: function}}
 */
export function acquireClipPathSession(canvas, options = {}) {
  if (!canvas) {
    throw new Error('acquireClipPathSession: canvas is required');
  }
  // 同一画布的并发会话正是「备份互相覆盖」的成因，必须显式拒绝而不是静默接管。
  if (canvas.__clipPathSession) {
    throw new Error('acquireClipPathSession: 该画布上已有一个未释放的 clipPath 会话（残留持有者）');
  }

  const exclude = options.exclude || [];
  const onRender = typeof options.onRender === 'function' ? options.onRender : null;

  /** @type {Array<{obj: object, clipPath: object|null}>|null} */
  let objectBackups = null;
  /** 被摘掉的画布级 clipPath 原实例 */
  let detachedCanvasClipPath = null;
  let held = false;

  const requestRender = () => {
    if (onRender) { onRender(); return; }
    if (typeof canvas.requestRenderAll === 'function') canvas.requestRenderAll();
  };

  /**
   * 给所有参与对象临时挂上等价 clipPath，先备份各自原值。
   * 辅助对象不参与——它们本来就不该被裁。
   */
  const applyTemporaryObjectClipPaths = (sourceClipPath) => {
    if (!sourceClipPath) return;
    // 先清掉可能的残留，再建立本次备份：保证失败时也能回到已知状态。
    clearTemporaryObjectClipPaths(false);

    objectBackups = canvas.getObjects()
      .filter((obj) => !isExcluded(obj, exclude))
      .map((obj) => ({ obj, clipPath: obj.clipPath || null }));

    for (const { obj } of objectBackups) {
      obj.set('clipPath', sourceClipPath);
      obj.dirty = true;
    }
  };

  /** 把每个参与对象写回它自己的原值。逐个写回，不整批替换。 */
  const clearTemporaryObjectClipPaths = (render = true) => {
    if (!objectBackups) return;
    for (const { obj, clipPath } of objectBackups) {
      obj.set('clipPath', clipPath || null);
    }
    objectBackups = null;
    if (render) requestRender();
  };

  /** 摘掉画布级 clipPath，只做一次；重复调用是幂等的。 */
  const detachCanvasClipPath = () => {
    if (held) return;
    if (!canvas.clipPath) return;
    detachedCanvasClipPath = canvas.clipPath;
    canvas.clipPath = null;
    applyTemporaryObjectClipPaths(detachedCanvasClipPath);
    held = true;
    requestRender();
  };

  /** 写回画布级 clipPath。必须是同一个实例，否则说明备份被覆盖过。 */
  const restoreCanvasClipPath = () => {
    if (detachedCanvasClipPath) {
      canvas.clipPath = detachedCanvasClipPath;
      detachedCanvasClipPath = null;
    }
    held = false;
  };

  /**
   * 暂存当前画布级 clipPath、跑一段回调、再把画布级 clipPath 还原。
   * 用于「这段代码需要看到未裁剪的画布」而不想手动配对摘除/恢复。
   */
  const withCanvasClipPath = (fn) => {
    const previous = canvas.clipPath;
    clearTemporaryObjectClipPaths(false);
    if (detachedCanvasClipPath) {
      canvas.clipPath = detachedCanvasClipPath;
    }
    try {
      return fn();
    } finally {
      canvas.clipPath = previous;
      if (detachedCanvasClipPath) {
        applyTemporaryObjectClipPaths(detachedCanvasClipPath);
      }
      requestRender();
    }
  };

  const release = () => {
    if (!canvas.__clipPathSession || canvas.__clipPathSession !== session) {
      // 已经被释放，或本会话早已失效：不再动画布。
      return;
    }
    clearTemporaryObjectClipPaths(false);
    restoreCanvasClipPath();
    canvas.__clipPathSession = null;
    requestRender();
  };

  const session = {
    canvas,
    release,
    withCanvasClipPath,
    isHeld: () => held,
    /** 供调用方读取当前被摘掉的画布级 clipPath（等价于旧的 _detachedCanvasClipPath） */
    getDetached: () => detachedCanvasClipPath,
    detach: detachCanvasClipPath,
  };

  canvas.__clipPathSession = session;
  return session;
}

/**
 * 显式释放：调用方漏调 release 也不该留下残留持有者。
 * @param {object} canvas
 */
export function releaseClipPathSession(canvas) {
  if (canvas && canvas.__clipPathSession) {
    canvas.__clipPathSession.release();
  }
}
