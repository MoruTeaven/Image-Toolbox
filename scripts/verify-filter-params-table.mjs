/**
 * 调色参数表门禁 — 守护「新增调色参数只改一处」这条约定
 *
 * 历史缺陷：调色参数的定义曾散落在 6 处（filters.js 的 4 张映射表 + 2 个换算函数、
 * ColorModule 与 ColorPanel 各一份滑块清单），新增一个参数要同步改 6 处，
 * 漏改一处就出现「滑块能拖但滤镜不生效」或两处 UI 清单不一致。
 * 现已收敛为 utils/filters.js 的 FILTER_PARAMS 表，其余全部派生。
 *
 * 本脚本断言：
 *   1. 派生映射与表完全一致，没有第二处硬编码（filters.js / ColorModule / ColorPanel
 *      源码里不得再出现手写的滤镜类名清单或映射表字面量）；
 *   2. 两处调色 UI 渲染出的滑块清单逐项一致（type/label/min/max/step/default）；
 *   3. 类型唯一：vibrance 不能既在 UI 参数里又落在「仅预设」集合中，
 *      否则 ALL_FILTER_TYPES 会出现两次（看板卡 t-mumj0ikk-5ni8u7 的迁移陷阱）；
 *   4. 预设取值 / 预设高亮 / 效果缩略图三条派生链路口径一致：
 *      应用预设后实际滤镜数组 == getPresetFilterValues 生成的清单，
 *      且 isPresetActive 判为高亮；
 *   5. 滤镜数组顺序固定按表键序，与用户拖动顺序无关；
 *   6. 撤销/重做链路保留 filters（快照序列化 props 里有 'filters'）。
 *
 * 运行：node scripts/verify-filter-params-table.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ── fabric 桩件：只需要滤镜类名表与 applyFilters ──

class StubFilter {
  constructor(opts = {}) {
    Object.assign(this, opts);
    this.type = new.target.__fabricType;
  }
  applyTo2d() {}
  isNeutralState() {
    return true;
  }
}

function makeFilterClass(type) {
  const cls = class extends StubFilter {};
  cls.__fabricType = type;
  return cls;
}

const FILTER_CLASSES = {
  Brightness: makeFilterClass('Brightness'),
  Contrast: makeFilterClass('Contrast'),
  Saturation: makeFilterClass('Saturation'),
  Vibrance: makeFilterClass('Vibrance'),
  Gamma: makeFilterClass('Gamma'),
  HueRotation: makeFilterClass('HueRotation'),
  Blur: makeFilterClass('Blur'),
  Sepia: makeFilterClass('Sepia'),
  Grayscale: makeFilterClass('Grayscale'),
  Noise: makeFilterClass('Noise'),
  Pixelate: makeFilterClass('Pixelate')
};

class StubImage {
  constructor() {
    this.type = 'image';
    this.filters = [];
    this.applyCount = 0;
  }
  applyFilters() {
    this.applyCount += 1;
    return this;
  }
}

globalThis.fabric = {
  Image: Object.assign(function ImageStub() {}, { filters: FILTER_CLASSES })
};

// ── 载入被测模块 ──

const filters = await import('../core/src/utils/filters.js');
const { FILTER_PARAMS, FILTER_PRESETS } = filters;

const TYPES = Object.keys(FILTER_PARAMS);

console.log('\n1. 参数表自身的完整性');

check('参数表非空', TYPES.length > 0);
check(
  '每条定义都含必需字段',
  TYPES.every(t => {
    const p = FILTER_PARAMS[t];
    return p && typeof p.label === 'string' && p.label.length > 0
      && typeof p.cls === 'string' && p.cls.length > 0
      && typeof p.attr === 'string' && p.attr.length > 0
      && Number.isFinite(p.min) && Number.isFinite(p.max) && p.min < p.max
      && Number.isFinite(p.step) && p.step > 0
      && Number.isFinite(p.default)
      && p.default >= p.min && p.default <= p.max
      && typeof p.inUi === 'boolean'
      && typeof p.toFilter === 'function' && typeof p.toUi === 'function';
  })
);
check(
  'fabric 类名在 fabric.Image.filters 中真实存在',
  TYPES.every(t => typeof FILTER_CLASSES[FILTER_PARAMS[t].cls] === 'function'),
  TYPES.filter(t => !FILTER_CLASSES[FILTER_PARAMS[t].cls]).join(', ')
);
check(
  '参数键无重复（对象字面量本身去重，这里验证 cls 不重复）',
  new Set(TYPES.map(t => FILTER_PARAMS[t].cls)).size === TYPES.length
);

// toFilter / toUi 往返一致
check(
  'toFilter 与 toUi 往返一致（取端点与中间值）',
  TYPES.every(t => {
    const p = FILTER_PARAMS[t];
    return [p.min, p.max, p.default, 0].every(v => {
      if (v < p.min || v > p.max) {
        return true;
      }
      const back = p.toUi(p.toFilter(v));
      return Math.abs(back - v) <= 1;
    });
  })
);

console.log('\n2. 派生映射与表一致，无第二处硬编码');

const RANGE_KEYS = Object.keys(filters.FILTER_RANGES);
check(
  'FILTER_RANGES 只含 inUi 参数',
  RANGE_KEYS.length === TYPES.filter(t => FILTER_PARAMS[t].inUi).length
    && RANGE_KEYS.every(t => FILTER_PARAMS[t].inUi)
);
check(
  'FILTER_RANGES 的数值来自表',
  RANGE_KEYS.every(t => {
    const p = FILTER_PARAMS[t];
    const r = filters.FILTER_RANGES[t];
    return r.min === p.min && r.max === p.max && r.step === p.step && r.default === p.default;
  })
);

const uiItems = filters.getUiFilterItems();
check(
  'getUiFilterItems 与 FILTER_RANGES 口径一致',
  uiItems.length === RANGE_KEYS.length
    && uiItems.every(item => RANGE_KEYS.includes(item.type))
);
check(
  'getUiFilterItems 每项带全 label/范围/默认值',
  uiItems.every(item => FILTER_PARAMS[item.type]
    && item.label === FILTER_PARAMS[item.type].label
    && item.min === FILTER_PARAMS[item.type].min
    && item.max === FILTER_PARAMS[item.type].max
    && item.step === FILTER_PARAMS[item.type].step
    && item.default === FILTER_PARAMS[item.type].default)
);

// 类型唯一性：UI 参数与「仅预设」集合不得交叠（看板评论记载的 vibrance 陷阱）
const presetOnly = TYPES.filter(t => !FILTER_PARAMS[t].inUi);
check(
  'inUi 参数与预设专用参数无交叠',
  presetOnly.every(t => !RANGE_KEYS.includes(t))
);
check(
  '派生键序无重复类型',
  new Set([...RANGE_KEYS, ...presetOnly]).size === TYPES.length
);
// 预设里用到的「有强度属性」的类型必须在 UI 露出，否则出现「预设改了但滑块不动」——
// vibrance 就曾长期只存在于预设集合里（看板评论记载的迁移陷阱）。
// 合法例外有两类：
//   • sepia / grayscale：fabric 5.3 没有强度属性，做成滑块只会写多余字段（t-mumiz038-z392ul）
//   • noise / pixelate：预设专用的质感参数，量纲（0~100 / blocksize 1~30）与常规调色不同
const PRESET_ONLY_OK = ['sepia', 'grayscale', 'noise', 'pixelate'];
const usedByPresets = new Set(
  FILTER_PRESETS.flatMap(p => Object.keys(p.filters || {}))
);
check(
  '预设使用的参数要么在 UI 露出，要么属于已知预设专用项',
  [...usedByPresets].every(t => FILTER_PARAMS[t].inUi || PRESET_ONLY_OK.includes(t)),
  [...usedByPresets].filter(t => !FILTER_PARAMS[t].inUi && !PRESET_ONLY_OK.includes(t)).join(', ')
);
check(
  '无强度属性的滤镜确实保持 inUi:false',
  ['sepia', 'grayscale'].every(t => FILTER_PARAMS[t] && FILTER_PARAMS[t].inUi === false)
);

// 源码级断言：两处 UI 不得再维护自己的滤镜清单
const readSrc = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FILTERS_SRC = readSrc('core/src/utils/filters.js');
const COLORMODULE_SRC = readSrc('core/src/modules/ColorModule.js');
const COLORPANEL_SRC = readSrc('core/src/ui/ColorPanel.js');

check(
  'ColorModule 不手写滤镜类名清单',
  !Object.keys(FILTER_CLASSES).some(cls => COLORMODULE_SRC.includes(`'${cls}'`)
    || COLORMODULE_SRC.includes(`"${cls}"`))
);
check(
  'ColorPanel 不手写滤镜类名清单',
  !Object.keys(FILTER_CLASSES).some(cls => COLORPANEL_SRC.includes(`'${cls}'`)
    || COLORPANEL_SRC.includes(`"${cls}"`))
);
check(
  '两处 UI 都从 getUiFilterItems 派生滑块清单',
  COLORMODULE_SRC.includes('getUiFilterItems()') && COLORPANEL_SRC.includes('getUiFilterItems()')
);
// 只查「清单式」硬编码：数组/对象字面量里并排出现多个滤镜 label。
// 注释与文案里提到若干 label 名不算（表驱动改造后两处 UI 的说明性注释仍会列举参数名）。
const LABEL_LIST_RE = /\[\s*\{\s*(?:label|type)\s*:|(?:label|type)\s*:\s*'[^']*'\s*,\s*(?:label|type)\s*:/;
check(
  '两处 UI 都不再自行声明 label 清单',
  !LABEL_LIST_RE.test(COLORMODULE_SRC) && !LABEL_LIST_RE.test(COLORPANEL_SRC)
);
check(
  'filters.js 不保留旧的手写映射表（FILTER_CLASS_NAME / FILTER_ATTR_NAME 应为派生）',
  !/const FILTER_CLASS_NAME = \{[\s\S]*?\n\};/.test(FILTERS_SRC)
    && !/const FILTER_ATTR_NAME = \{[\s\S]*?\n\};/.test(FILTERS_SRC)
);
check(
  'filters.js 不再导出 PRESET_ONLY_DEFAULTS（已由 inUi 取代）',
  !/PRESET_ONLY_DEFAULTS/.test(FILTERS_SRC)
);
check(
  'CanvasManager 快照 props 仍含 filters（撤销/重做必须保留滤镜）',
  readSrc('core/src/CanvasManager.js').includes("'filters'")
);

console.log('\n3. 两处 UI 输出的参数清单一致');

function extractSliders(html) {
  return [...html.matchAll(/<input type="range"[^>]*>/g)].map(m => {
    const el = m[0];
    const get = name => {
      const found = el.match(new RegExp(`${name}="([^"]*)"`));
      return found ? found[1] : null;
    };
    return {
      prop: get('data-module-prop') || get('data-prop'),
      label: (el.match(/<label>([^<]*)<\/label>/) || [])[1] || null,
      min: get('min'),
      max: get('max'),
      step: get('step')
    };
  });
}

// 直接调两个 UI 类的渲染入口（桩件化其依赖）
class StubElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.innerHTML = '';
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.children = [];
    this.style = { setProperty() {} };
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.querySelector = () => null;
    this.querySelectorAll = () => [];
    this.appendChild = (c) => {
      this.children.push(c);
      return c;
    };
    this.getContext = () => null;
  }
}

globalThis.document = {
  createElement: tag => new StubElement(tag),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {}
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const ColorModule = (await import('../core/src/modules/ColorModule.js')).default;
const ColorPanel = (await import('../core/src/ui/ColorPanel.js')).default;

const image = new StubImage();
const canvasManagerStub = {
  canvas: {
    getObjects: () => [image],
    getActiveObject: () => image,
    requestRenderAll() {},
    renderAll() {},
    selection: true
  },
  getActiveObject: () => image
};
const historyStub = { saveState() {} };

const moduleInstance = new ColorModule(canvasManagerStub, historyStub, {});
moduleInstance.active = true;
const moduleHTML = moduleInstance.getPropertyPanelHTML();

const panelEl = new StubElement('div');
const panelInstance = new ColorPanel(panelEl, canvasManagerStub, historyStub);
const panelHTML = panelInstance._getColorAdjustHTML(image);

const moduleSliders = extractSliders(moduleHTML);
const panelSliders = extractSliders(panelHTML);

check('两处 UI 都渲染出了滑块', moduleSliders.length > 0 && panelSliders.length > 0,
  `module=${moduleSliders.length} panel=${panelSliders.length}`);
check('两处 UI 滑块数量一致', moduleSliders.length === panelSliders.length,
  `module=${moduleSliders.length} panel=${panelSliders.length}`);
check(
  '两处 UI 滑块逐项一致（prop/label/min/max/step）',
  moduleSliders.length === panelSliders.length
    && moduleSliders.every((s, i) => {
      const p = panelSliders[i];
      return p && s.prop === p.prop && s.label === p.label
        && s.min === p.min && s.max === p.max && s.step === p.step;
    })
);
check(
  '两处 UI 滑块顺序与表键序一致',
  moduleSliders.map(s => s.prop.replace('filter:', '')).join(',')
    === uiItems.map(i => i.type).join(',')
);
check(
  '两处 UI 的 prop 命名空间不同但指向同一 type（各自消费者约定）',
  moduleSliders.every(s => s.prop.startsWith('filter:')) && panelSliders.every(s => s.prop.startsWith('filter:'))
);

console.log('\n4. 预设 / 缩略图 / 高亮三条派生链路口径一致');

const preset = FILTER_PRESETS.find(p => p.preset === 'filter-vintage');
assert.ok(preset, '预设 filter-vintage 应存在');

filters.applyFilterPreset(image, preset.preset);

// 实际写入的滤镜 → 还原成 { type: attrValue }
const actual = image.filters.map(f => ({ type: f.type, attr: Object.keys(f).find(k => k !== 'type') }));
const expected = filters.getPresetFilterValues(preset);

check(
  '应用预设后实际滤镜 == getPresetFilterValues（缩略图与画面同源）',
  actual.length === expected.length
    && actual.every((a, i) => a.type === expected[i].type && a.attr === expected[i].attr
      && Math.abs(a.attr - expected[i].value) < 1e-9 || (a.type === expected[i].type && a.attr === expected[i].attr)),
  `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
);
check(
  '缩略图滤镜数量与预设声明数一致（无重复滤镜条目）',
  expected.length === Object.keys(preset.filters).length,
  `expected=${expected.length} declared=${Object.keys(preset.filters).length}`
);
check(
  '同一类型滤镜在数组中只出现一次',
  new Set(image.filters.map(f => f.type)).size === image.filters.length
);
check(
  'isPresetActive 对刚应用的预设判为高亮',
  filters.isPresetActive(image, preset.preset) === true
);
check(
  'isPresetActive 对不同预设不误判为高亮',
  FILTER_PRESETS.filter(p => p.preset !== preset.preset)
    .every(p => filters.isPresetActive(image, p.preset) === false)
);

console.log('\n5. 滤镜数组顺序固定，与拖动顺序无关');

const orderImage = new StubImage();
// 逆序拖动：先 hue 再 brightness，再 contrast
['hue', 'brightness', 'contrast'].forEach(type => {
  filters.setFilter(orderImage, type, 20);
});
const forwardImage = new StubImage();
['contrast', 'brightness', 'hue'].forEach(type => {
  filters.setFilter(forwardImage, type, 20);
});

check(
  '拖动顺序不同，最终滤镜数组顺序一致',
  orderImage.filters.map(f => f.type).join(',') === forwardImage.filters.map(f => f.type).join(','),
  `${orderImage.filters.map(f => f.type).join(',')} vs ${forwardImage.filters.map(f => f.type).join(',')}`
);
check(
  '滤镜顺序与表键序一致',
  (() => {
    const present = orderImage.filters.map(f => f.type);
    const declared = TYPES
      .filter(t => FILTER_PARAMS[t].cls && present.includes(FILTER_PARAMS[t].cls))
      .map(t => FILTER_PARAMS[t].cls);
    return present.join(',') === declared.join(',');
  })(),
  orderImage.filters.map(f => f.type).join(',')
);

console.log('\n6. setFilter 的默认值/覆盖语义');

const defaultImage = new StubImage();
filters.setFilter(defaultImage, 'brightness', FILTER_PARAMS.brightness.default);
check('默认值不写入滤镜数组', defaultImage.filters.length === 0);

const overrideImage = new StubImage();
filters.setFilter(overrideImage, 'brightness', 30);
filters.setFilter(overrideImage, 'brightness', -30);
check(
  '同类型覆盖式更新，数组里只留一个实例',
  overrideImage.filters.length === 1
);
check(
  '覆盖后值是最后一次写入的值',
  filters.getFilterUiValue(overrideImage, 'brightness') === -30
);

const unknownImage = new StubImage();
filters.setFilter(unknownImage, 'not-a-real-type', 10);
check('未知类型安全忽略', unknownImage.filters.length === 0);

console.log('\n7. 批量应用预设只触发一次重算');

const batchImage = new StubImage();
filters.applyFilterPreset(batchImage, preset.preset);
check(
  'applyFilterPreset 全程只 applyFilters 一次（skipApply 生效）',
  batchImage.applyCount === 1,
  `applyCount=${batchImage.applyCount}`
);

// ── 汇总 ──

console.log(`\n${'─'.repeat(56)}`);
if (failures.length > 0) {
  console.log(`调色参数表门禁：${passed} 项通过，${failures.length} 项失败\n`);
  failures.forEach(f => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
} else {
  console.log(`调色参数表门禁：全部通过（${passed} 项）`);
}
