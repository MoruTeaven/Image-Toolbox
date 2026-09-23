/**
 * 保存失败提示回归测试
 *
 * 背景：ExportModule.exportToFile 在 host.saveImage 返回 false 时直接 return，
 * 既无 toast 也无报错。BaseHostAdapter.saveImage 在写入失败（权限不足、磁盘满、
 * 路径非法、writeImageFile 异常被 preload 吞掉）时返回裸 false，调用方无法区分
 * 「用户取消 / 平台无能力 / 真实写入失败」，导致写入失败被静默丢弃 ——
 * 用户点「保存」后界面毫无反应，误以为已保存而关闭窗口，直接丢失全部编辑成果。
 *
 * 本测试锁定两条不变量：
 *   1. 任何真实保存失败都必须产生 error toast（绝不静默）；
 *   2. 用户主动取消不得产生任何 toast，也不得被当作失败。
 *
 * 运行：node tests/save-failure-notification.test.cjs [项目根目录]
 * 依赖：仅 Node 内置模块（无需安装依赖）。
 * 前置：先执行 .\build.ps1（测试读取构建产物，与 tests/ztools-platform.test.cjs 一致）。
 */

const fs = require('fs');
const path = require('path');
const url = require('url');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail === undefined || detail === null ? '' : String(detail) });
};

const read = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8');

/** 最小画布替身：只需 toDataURL 返回一个可用的 dataURL */
const makeCanvasManager = () => {
  const canvas = {
    viewportTransform: [1, 0, 0, 1, 0, 0],
    backgroundColor: null,
    toDataURL: () => 'data:image/png;base64,AAAA',
    requestRenderAll: () => {},
  };
  return { canvas, refreshDynamicMosaics: () => {}, originalImage: null };
};

/** 跑一次 exportToFile 并收集 toast 事件 */
const runExport = async (ExportModule, eventBus, host) => {
  const captured = [];
  const off = eventBus.on('toast:show', (payload) => captured.push(payload));
  const mod = new ExportModule(makeCanvasManager(), null, {}, host);
  let returned = undefined;
  try {
    returned = await mod.exportToFile();
  } finally {
    off();
  }
  return { toasts: captured, returned };
};

const errorsOf = (toasts) => toasts.filter((t) => t.type === 'error');
const successesOf = (toasts) => toasts.filter((t) => t.type === 'success');

const run = async () => {
  const coreBase = 'dist/web/core/src';

  const { default: ExportModule } = await import(
    url.pathToFileURL(path.join(root, coreBase, 'modules/ExportModule.js')).href
  );
  const { default: eventBus } = await import(
    url.pathToFileURL(path.join(root, coreBase, 'EventBus.js')).href
  );
  const { SAVE_STATUS, createSaveResult, normalizeSaveResult } = await import(
    url.pathToFileURL(path.join(root, coreBase, 'adapters/BaseHostAdapter.js')).href
  );

  // ═══ 0. 结构化结果契约 ═══

  check('SAVE_STATUS 覆盖 成功/取消/不支持/失败 四种状态',
    SAVE_STATUS.SAVED === 'saved' && SAVE_STATUS.CANCELED === 'canceled'
    && SAVE_STATUS.UNSUPPORTED === 'unsupported' && SAVE_STATUS.FAILED === 'failed');

  const savedResult = createSaveResult(SAVE_STATUS.SAVED, { filePath: 'a.png' });
  const failedResult = createSaveResult(SAVE_STATUS.FAILED, { reason: 'x' });
  const canceledResult = createSaveResult(SAVE_STATUS.CANCELED);
  check('结构化结果携带 ok / status / filePath / reason',
    savedResult.ok === true && failedResult.ok === false && canceledResult.ok === false
    && 'filePath' in savedResult && 'reason' in failedResult);
  check('结构化结果的 ok 语义正确（失败/取消为 false，成功为 true）',
    savedResult.ok === true && failedResult.ok === false && canceledResult.ok === false);
  check('normalizeSaveResult 兼容裸 boolean 返回值',
    normalizeSaveResult(true).status === SAVE_STATUS.SAVED
    && normalizeSaveResult(false).status === SAVE_STATUS.FAILED
    && normalizeSaveResult(undefined).status === SAVE_STATUS.FAILED);
  check('normalizeSaveResult 透传已有结构化结果',
    normalizeSaveResult(failedResult) === failedResult);

  // ═══ 1. 写入失败必须提示（核心回归：修复前此处 toasts 为空）═══

  const writeFail = await runExport(ExportModule, eventBus, {
    saveImage: async () => createSaveResult(SAVE_STATUS.FAILED, { reason: 'EACCES 权限不足' }),
  });
  check('写入失败 → 产生 error toast', errorsOf(writeFail.toasts).length === 1,
    JSON.stringify(writeFail.toasts));
  check('写入失败 → 提示包含失败原因',
    /权限不足/.test(errorsOf(writeFail.toasts)[0]?.message || ''),
    errorsOf(writeFail.toasts)[0]?.message);
  check('写入失败 → 不产生 success toast', successesOf(writeFail.toasts).length === 0);

  // 宿主沿用旧契约返回裸 false 时同样必须提示
  const legacyFalse = await runExport(ExportModule, eventBus, { saveImage: async () => false });
  check('宿主返回裸 false → 仍然产生 error toast', errorsOf(legacyFalse.toasts).length === 1,
    JSON.stringify(legacyFalse.toasts));

  // 宿主抛异常也必须被兜住
  const throwing = await runExport(ExportModule, eventBus, {
    saveImage: async () => { throw new Error('磁盘已满'); },
  });
  check('宿主抛异常 → 产生 error toast 且不逃逸',
    errorsOf(throwing.toasts).length === 1 && /磁盘已满/.test(errorsOf(throwing.toasts)[0]?.message || ''),
    JSON.stringify(throwing.toasts));

  // 原生对话框分支的写入失败
  const nativeWriteFail = await runExport(ExportModule, eventBus, {
    showSaveImageDialog: () => path.join(root, 'edited.png'),
    writeImageFile: () => createSaveResult(SAVE_STATUS.FAILED, { reason: '路径非法' }),
  });
  check('原生对话框写入失败 → 产生 error toast',
    errorsOf(nativeWriteFail.toasts).length === 1 && /路径非法/.test(errorsOf(nativeWriteFail.toasts)[0]?.message || ''),
    JSON.stringify(nativeWriteFail.toasts));

  // ═══ 2. 用户取消不得报错 ═══

  const canceled = await runExport(ExportModule, eventBus, {
    saveImage: async () => createSaveResult(SAVE_STATUS.CANCELED),
  });
  check('用户取消保存（saveImage 分支）→ 无任何 toast', canceled.toasts.length === 0,
    JSON.stringify(canceled.toasts));

  const canceledNative = await runExport(ExportModule, eventBus, {
    showSaveImageDialog: () => null,
    writeImageFile: () => { throw new Error('不应被调用'); },
  });
  check('用户取消保存（对话框分支）→ 无任何 toast', canceledNative.toasts.length === 0,
    JSON.stringify(canceledNative.toasts));

  // ═══ 3. 保存成功仍然提示成功 ═══

  const ok = await runExport(ExportModule, eventBus, {
    saveImage: async () => createSaveResult(SAVE_STATUS.SAVED, { filePath: 'a.png' }),
  });
  check('保存成功 → success toast 且无 error',
    successesOf(ok.toasts).length === 1 && errorsOf(ok.toasts).length === 0,
    JSON.stringify(ok.toasts));

  // ═══ 4. ORA 保存链路 ═══

  const oraSrc = read(coreBase + '/utils/ora.js');
  check('ORA 保存分支不再在函数内直接 toast（改由 exportORA 统一提示）',
    !/message: saved \? 'ORA 文件已保存'/.test(oraSrc));
  check('ORA 保存分支能区分取消与失败',
    /SAVE_STATUS\.CANCELED/.test(oraSrc) && /SAVE_STATUS\.FAILED/.test(oraSrc));
  check('exportORA 在失败时无 toast 的静默路径已消除',
    /ORA 保存失败/.test(oraSrc));

  // 真实执行 ORA 降级 1（host adapter 写入失败）路径。
  // 注意：必须在 import ora.js 之前装好环境替身，ORA 打包会经由
  // fetch(dataURL) → Blob，缺失时会在打包阶段提前抛错而走不到保存分支。
  global.window = {};            // 无 showSaveOraDialog/writeBinaryFile → 走降级 1
  global.document = {
    createElement: () => ({
      getContext: () => ({ drawImage: () => {}, clearRect: () => {}, fillRect: () => {} }),
      toDataURL: () => 'data:image/png;base64,AAAA',
      width: 0, height: 0, style: {},
    }),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  // JSZip 是 UMD：页面里由 <script> 注入并暴露全局 JSZip。
  // 以 ES Module 方式 import 时它改走 default 导出、不挂全局，而 ora.js 读的是
  // 裸标识符 JSZip（ESM 中解析到 globalThis），所以这里把 default 桥接为全局。
  const jszipMod = await import(url.pathToFileURL(path.join(root, coreBase, 'lib/jszip.min.js')).href)
    .catch(() => null);
  global.JSZip = global.JSZip || global.window?.JSZip || jszipMod?.default || jszipMod?.JSZip;
  // 该 JSZip 版本只接受 string/ArrayBuffer/Uint8Array（不接受浏览器 Blob），
  // 因此 fetch 替身返回 ArrayBuffer，使 ORA 打包能真实跑完。
  global.fetch = async (dataURL) => ({
    blob: async () => new TextEncoder().encode(String(dataURL)).buffer,
  });

  const { exportORA } = await import(
    url.pathToFileURL(path.join(root, coreBase, 'utils/ora.js')).href
  );

  if (global.JSZip) {
    const oraCanvasManager = {
      canvas: {
        getObjects: () => [],
        width: 10,
        height: 10,
        backgroundColor: null,
      },
      originalImage: null,
    };
    const fakeHostWritten = [];
    const oraFail = [];
    const offOra = eventBus.on('toast:show', (p) => oraFail.push(p));
    const okOra = await exportORA(oraCanvasManager, null, {
      showSaveImageDialog: () => path.join(root, 'tmp-project.ora'),
      writeImageFile: (p, d) => { fakeHostWritten.push(p); return createSaveResult(SAVE_STATUS.FAILED, { reason: 'no-space' }); },
    });
    offOra();
    check('ORA 写入失败 → 返回 false', okOra === false, String(okOra));
    check('ORA 写入失败 → 产生 error toast',
      errorsOf(oraFail).length === 1, JSON.stringify(oraFail));

    const oraCancel = [];
    const offCancel = eventBus.on('toast:show', (p) => oraCancel.push(p));
    const canceledOra = await exportORA(oraCanvasManager, null, {
      showSaveImageDialog: () => null,
      writeImageFile: () => { throw new Error('不应被调用'); },
    });
    offCancel();
    check('ORA 用户取消 → 返回 false 且无任何 toast',
      canceledOra === false && oraCancel.length === 0, JSON.stringify(oraCancel));

    const oraOk = [];
    const offOk = eventBus.on('toast:show', (p) => oraOk.push(p));
    const savedOra = await exportORA(oraCanvasManager, null, {
      showSaveImageDialog: () => path.join(root, 'tmp-project.ora'),
      writeImageFile: () => createSaveResult(SAVE_STATUS.SAVED, { filePath: 'tmp-project.ora' }),
    });
    offOk();
    check('ORA 保存成功 → 返回 true 且提示成功',
      savedOra === true && successesOf(oraOk).length === 1 && errorsOf(oraOk).length === 0,
      JSON.stringify(oraOk));
  } else {
    check('JSZip 可用（ORA 运行期用例前置条件）', false, '未加载到 JSZip');
  }

  // ═══ 输出 ═══

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => {
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  });
  console.log('');
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(2);
});
