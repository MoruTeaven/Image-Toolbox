/**
 * 导出分辨率还原门禁。
 *
 * 用户反馈：导出/保存的图片分辨率与原图不一致。
 * 根因：图片按 fitToCanvas 缩放显示（scale ≤ 1），画布尺寸跟随窗口容器，
 * 旧导出链路 multiplier=1 且不裁剪边界，输出分辨率被绑死在窗口大小上
 * （如 4000×3000 原图导出后 ≈ 画布尺寸）；高 DPR 屏上 fabric 默认
 * enableRetinaScaling 还会再乘 devicePixelRatio，分辨率随设备漂移；
 * 视口滚轮缩放也会混入导出内容。
 *
 * 本门禁断言 ExportModule 的导出参数组装（捕获传给 fabric toDataURL 的实参）：
 *   1. multiplier 按原图显示缩放反向补偿（导出像素 = 图片坐标系像素数）；
 *   2. 导出边界取图片/裁剪 clipPath 的显示边界，画布空白边距不进入结果；
 *   3. PNG 裁剪导出保留透明 / JPEG 保留背景色（JPEG 无透明通道，透明变黑底）；
 *   4. 视口缩放/平移不进入导出（resetViewport），导出后视口恢复；
 *   5. enableRetinaScaling=false，与设备像素比解耦；
 *   6. 巨图补偿倍率按浏览器画布边长上限截断（宁降分辨率不出空白文件）；
 *   7. 显式 multiplier 优先于自动补偿。
 *
 * 变异自验：把补偿逻辑注回旧行为（multiplier 固定 1 / retina 开启），
 * 断言必须出现失败——否则说明断言是「兜底掩盖式」空洞断言。
 * 变异前后源文件逐字节恢复。
 *
 * 用法：node scripts/verify-export-resolution.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './test-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_MODULE_PATH = path.join(ROOT, 'core', 'src', 'modules', 'ExportModule.js');

const failures = [];
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ExportModule 的 import 链（BaseModule/EventBus/ports）需要 document/window 存在
installDom();

async function loadExportModule(query = '') {
  const mod = await import(`../core/src/modules/ExportModule.js${query}`);
  return mod.default;
}

// ── 桩件 ──

/**
 * 画布桩：捕获 toDataURL 实参，并记录调用瞬间的背景色与视口状态。
 * backgroundColor / viewportTransform / clipPath 是 _toDataURL 会临时改写的字段，
 * 必须是普通可写属性。
 */
function makeCanvasStub({ width = 800, height = 600 } = {}) {
  const captured = [];
  const stub = {
    width,
    height,
    backgroundColor: '#ffffff',
    viewportTransform: [1, 0, 0, 1, 0, 0],
    clipPath: null,
    toDataURL(options) {
      captured.push({
        options,
        backgroundColorAtCall: stub.backgroundColor,
        viewportAtCall: [...stub.viewportTransform]
      });
      return 'data:image/png;base64,';
    },
    requestRenderAll() {}
  };
  return { stub, captured };
}

/** 图片桩：getBoundingRect 返回画布坐标下的显示边界（width × scaleX） */
function makeImage({ width = 4000, height = 3000, scaleX = 0.1733, scaleY = 0.1733, left = 53.4, top = 26.7 } = {}) {
  return {
    type: 'image',
    width,
    height,
    scaleX,
    scaleY,
    left,
    top,
    setCoords() {},
    getBoundingRect() {
      return { left, top, width: width * scaleX, height: height * scaleY };
    }
  };
}

function makeModule(canvasStub) {
  const ExportModuleClass = globalThis.__exportModuleClass;
  return new ExportModuleClass(
    { canvas: canvasStub, originalImage: null, refreshDynamicMosaics() {} },
    {},
    {},
    null
  );
}

// ── 用例 ──

async function runCases(ExportModuleClass) {
  globalThis.__exportModuleClass = ExportModuleClass;

  console.log('\n[1] fit 场景：multiplier 反向补偿，输出分辨率回到原图坐标');
  {
    const { stub, captured } = makeCanvasStub();
    const img = makeImage({ width: 4000, height: 3000, scaleX: 0.1733, scaleY: 0.1733 });
    stub.getObjects = () => [];
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = img;

    const dataURL = mod.exportToDataURL('png');
    check('返回 dataURL', typeof dataURL === 'string' && dataURL.startsWith('data:image/png'));
    check('恰好调用一次 toDataURL', captured.length === 1, `captured=${captured.length}`);

    const opts = captured[0]?.options || {};
    const expectedMultiplier = 1 / 0.1733;
    check(
      'multiplier = 1/scale（反向补偿）',
      Math.abs(opts.multiplier - expectedMultiplier) < 1e-9,
      `multiplier=${opts.multiplier} 期望 ${expectedMultiplier}`
    );
    check(
      'enableRetinaScaling=false（与设备像素比解耦）',
      opts.enableRetinaScaling === false,
      `enableRetinaScaling=${opts.enableRetinaScaling}`
    );
    check(
      '导出边界 = 图片显示边界（整像素对齐，±2px 舍入容差）',
      Math.abs(opts.width - 4000 * 0.1733) < 2
        && Math.abs(opts.height - 3000 * 0.1733) < 2,
      `bounds=${opts.width}×${opts.height}`
    );
    const exportPxW = opts.width * opts.multiplier;
    const exportPxH = opts.height * opts.multiplier;
    check(
      '导出像素 ≈ 原图分辨率 4000×3000（±0.5% 整像素对齐误差）',
      Math.abs(exportPxW - 4000) < 20 && Math.abs(exportPxH - 3000) < 20,
      `输出=${exportPxW.toFixed(1)}×${exportPxH.toFixed(1)}`
    );
    check('PNG 裁剪导出保留透明（backgroundColor=null）', captured[0].backgroundColorAtCall === null);
    check('视口在导出瞬间已重置', captured[0].viewportAtCall.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]));
  }

  console.log('\n[2] JPEG：无透明通道，保留画布背景色（避免黑底）');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = makeImage();
    mod.exportToDataURL('jpeg', 0.9);
    const opts = captured[0]?.options || {};
    check('format=jpeg / quality 透传', opts.format === 'jpeg' && opts.quality === 0.9);
    check('JPEG 保留背景色', captured[0].backgroundColorAtCall === '#ffffff');
  }

  console.log('\n[3] 视口缩放不进入导出，导出后视口恢复');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = makeImage();
    stub.viewportTransform = [2, 0, 0, 2, 10, 20];
    mod.exportToDataURL('png');
    check('导出瞬间视口为单位变换', captured[0].viewportAtCall.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]));
    check(
      '导出后视口恢复（滚轮缩放不被导出破坏）',
      stub.viewportTransform[0] === 2 && stub.viewportTransform[4] === 10 && stub.viewportTransform[5] === 20
    );
  }

  console.log('\n[4] 裁剪（clipPath）场景：边界取裁剪区域，multiplier 仍按原图补偿');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = makeImage({ scaleX: 0.1733, scaleY: 0.1733 });
    stub.clipPath = {
      setCoords() {},
      getBoundingRect() {
        return { left: 100, top: 50, width: 346.6, height: 260 };
      }
    };
    mod.exportToDataURL('png');
    const opts = captured[0]?.options || {};
    check(
      '边界 = 裁剪 clipPath 的显示边界（整像素对齐，±2px 舍入容差）',
      Math.abs(opts.width - 346.6) < 2 && Math.abs(opts.height - 260) < 2,
      `bounds=${opts.width}×${opts.height}`
    );
    check(
      'multiplier 仍按原图 scale 补偿（裁剪输出 = 裁剪区域原始像素）',
      Math.abs(opts.multiplier - 1 / 0.1733) < 1e-9,
      `multiplier=${opts.multiplier}`
    );
    const exportPxW = opts.width * opts.multiplier;
    check('裁剪输出像素 = 裁剪区域在原图坐标系的大小（≈2000，±0.5%）', Math.abs(exportPxW - 2000) < 10, `输出宽=${exportPxW.toFixed(1)}`);
  }

  console.log('\n[5] 纯创作画布（无原图）：multiplier=1、整画布导出、所见即所得');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.exportToDataURL('png');
    const opts = captured[0]?.options || {};
    check('multiplier=1（无原图无从补偿）', opts.multiplier === 1);
    check('无裁剪边界（整画布导出）', opts.width === undefined && opts.height === undefined);
    check('保留画布背景色', captured[0].backgroundColorAtCall === '#ffffff');
  }

  console.log('\n[6] 显式 multiplier 优先于自动补偿');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = makeImage({ scaleX: 0.5, scaleY: 0.5 });
    mod.exportToDataURL('png', 1, { multiplier: 0.5 });
    check('multiplier=0.5（显式值）', captured[0]?.options?.multiplier === 0.5);
  }

  console.log('\n[7] trimToImage=false：整画布导出但分辨率补偿仍然生效');
  {
    const { stub, captured } = makeCanvasStub();
    const mod = makeModule(stub);
    mod.canvasManager.originalImage = makeImage({ scaleX: 0.1733, scaleY: 0.1733 });
    mod.exportToDataURL('png', 1, { trimToImage: false });
    const opts = captured[0]?.options || {};
    check('无裁剪边界', opts.width === undefined);
    check(
      'multiplier 仍补偿',
      Math.abs(opts.multiplier - 1 / 0.1733) < 1e-9,
      `multiplier=${opts.multiplier}`
    );
  }

  console.log('\n[8] 巨图防御：补偿倍率按浏览器画布边长上限截断');
  {
    const { stub, captured } = makeCanvasStub({ width: 800, height: 600 });
    const mod = makeModule(stub);
    // 40000px 原图 fit 到 800px 画布：scale=0.02，补偿倍率 50 → 导出边长 800×50=40000 > 16384
    mod.canvasManager.originalImage = makeImage({ width: 40000, height: 30000, scaleX: 0.02, scaleY: 0.02, left: 0, top: 0 });
    mod.exportToDataURL('png');
    const opts = captured[0]?.options || {};
    const exportEdge = Math.max(opts.width || 800, opts.height || 600);
    check(
      'multiplier 被截断（低于未截断的 1/0.02=50）',
      opts.multiplier > 0 && opts.multiplier < 50,
      `multiplier=${opts.multiplier}`
    );
    const exportPx = Math.max(opts.width || 800, opts.height || 600) * opts.multiplier;
    check(
      '导出边长不超过浏览器上限 16384',
      exportPx <= 16384,
      `输出边长=${exportPx.toFixed(1)}（exportEdge=${exportEdge}）`
    );
  }

  delete globalThis.__exportModuleClass;
}

// ── 变异自验 ──

async function runMutationChecks() {
  const original = fs.readFileSync(EXPORT_MODULE_PATH);
  const originalText = original.toString('utf8');

  const mutations = [
    {
      name: 'M1：multiplier 补偿失效（注回旧行为 return 1）',
      anchor: 'return 1 / scale;',
      replacement: 'return 1;'
    },
    {
      name: 'M2：retina 缩放重新混入（enableRetinaScaling: true）',
      anchor: 'enableRetinaScaling: false',
      replacement: 'enableRetinaScaling: true'
    }
  ];

  for (const mutation of mutations) {
    console.log(`\n[变异自验] ${mutation.name}`);
    if (!originalText.includes(mutation.anchor)) {
      failures.push(`${mutation.name} — 源码锚点失配（导出补偿逻辑重构后需同步更新本脚本）`);
      console.log('  ✗ 源码锚点失配（导出补偿逻辑重构后需同步更新本脚本）');
      continue;
    }

    try {
      const mutated = originalText.replace(mutation.anchor, mutation.replacement);
      if (mutated === originalText) {
        failures.push(`${mutation.name} — 变异未生效`);
        console.log('  ✗ 变异未生效');
        continue;
      }
      fs.writeFileSync(EXPORT_MODULE_PATH, mutated, 'utf8');

      // 变异轮次的断言计数走独立快照：预期失败用于证明可证伪性，
      // 不计入主体失败清单；主体通过数也不因变异轮次虚增。
      const snapFailures = failures.length;
      const snapPassed = passed;
      const MutatedExportModule = await loadExportModule(`?mutation=${encodeURIComponent(mutation.name)}`);
      await runCases(MutatedExportModule);
      const mutatedNewFailures = failures.length - snapFailures;
      failures.length = snapFailures;
      passed = snapPassed;

      if (mutatedNewFailures > 0) {
        passed += 1;
        console.log(`  ✓ 变异被捕获（${mutatedNewFailures} 条断言失败）——断言可证伪`);
      } else {
        failures.push(`${mutation.name} — 变异后断言全部通过：断言是空洞的，无法抓住该类回归`);
        console.log('  ✗ 变异后断言全部通过：断言是空洞的，无法抓住该类回归');
      }
    } finally {
      // 逐字节恢复
      fs.writeFileSync(EXPORT_MODULE_PATH, original);
    }
  }
}

// ── 主流程 ──

console.log('导出分辨率还原门禁（verify-export-resolution）');
const ExportModuleClass = await loadExportModule();
await runCases(ExportModuleClass);
await runMutationChecks();

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.error('\n失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过 ✓');
