/**
 * 调色参数表门禁 — 守护「新增调色参数只改一处」这条约定
 *
 * 历史缺陷：调色参数的定义曾散落在 6 处（filters.js 的 4 张映射表 + 2 个换算函数、
 * ColorModule 与 ColorPanel 各一份滑块清单），新增一个参数要同步改 6 处，
 * 漏改一处就出现「滑块能拖但滤镜不生效」或两处 UI 清单不一致。
 * 现已收敛为 utils/filters.js 的 FILTER_PARAMS 表，其余全部派生。
 *
 * 注意：ColorPanel 已于 4331c7a 作为死代码删除（侧栏调色 tab 在 dbf076b 就有意移除），
 * 调色 UI 现在只有 ColorModule 一处消费者。本脚本因此不再读 ColorPanel，
 * 但「唯一消费者必须从表派生」这条断言反而更硬：任何一处手写清单都会直接命中。
 *
 * 本脚本断言：
 *   1. 派生映射与表完全一致，没有第二处硬编码（filters.js / ColorModule
 *      源码里不得再出现手写的滤镜类名清单或映射表字面量）；
 *   2. 调色 UI 渲染出的滑块清单逐项等于表（type/label/min/max/step/default）；
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
  ColorMatrix: makeFilterClass('ColorMatrix'),
  Invert: makeFilterClass('Invert'),
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
// 合法例外有三类：
//   • sepia / grayscale / invert：fabric 5.3 没有强度属性，做成滑块只会写多余字段或恒为满强度
//     （sepia/grayscale 见 t-mumiz038-z392ul；invert 是布尔开关，同理）
//   • noise / pixelate：预设专用的质感参数，量纲（0~100 / blocksize 1~30）与常规调色不同
const PRESET_ONLY_OK = ['sepia', 'grayscale', 'invert', 'noise', 'pixelate'];
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
  ['sepia', 'grayscale', 'invert'].every(t => FILTER_PARAMS[t] && FILTER_PARAMS[t].inUi === false)
);

// 源码级断言：调色 UI 不得再维护自己的滤镜清单
//
// 这里曾经还断言过 ColorPanel（第二处调色 UI）。ColorPanel 在 4331c7a 作为死代码
// 删除后，本脚本仍去读它的源码，于是构建从那次合并起一直以 ENOENT 失败——
// 门禁自己变成了「引用不存在文件」的那类缺陷。现在只断言真实存在的消费者，
// 并在下面单独断言「ColorPanel 不会被悄悄复活」：它若回来，必须同时回到这张断言表里。
const readSrc = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FILTERS_SRC = readSrc('core/src/utils/filters.js');
const COLORMODULE_SRC = readSrc('core/src/modules/ColorModule.js');

check(
  'ColorModule 不手写滤镜类名清单',
  !Object.keys(FILTER_CLASSES).some(cls => COLORMODULE_SRC.includes(`'${cls}'`)
    || COLORMODULE_SRC.includes(`"${cls}"`))
);
check(
  '调色 UI 从 getUiFilterItems 派生滑块清单',
  COLORMODULE_SRC.includes('getUiFilterItems()')
);
// 只查「清单式」硬编码：数组/对象字面量里并排出现多个滤镜 label。
// 注释与文案里提到若干 label 名不算（表驱动改造后 UI 的说明性注释仍会列举参数名）。
const LABEL_LIST_RE = /\[\s*\{\s*(?:label|type)\s*:|(?:label|type)\s*:\s*'[^']*'\s*,\s*(?:label|type)\s*:/;
check(
  '调色 UI 不再自行声明 label 清单',
  !LABEL_LIST_RE.test(COLORMODULE_SRC)
);
// 已删除的死代码不得无声复活：文件若重新出现，上面的断言必须同步覆盖它，
// 否则新 UI 就会绕过「只改一处」这条约定而不被任何东西发现。
check(
  'ColorPanel.js 仍处于删除状态（复活须同步本门禁）',
  !fs.existsSync(path.join(ROOT, 'core/src/ui/ColorPanel.js'))
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

console.log('\n3. 调色 UI 输出的参数清单与表一致');

// 从 HTML 里抽滑块。注意必须连着外层的 property-item 块一起匹配：
// 只匹配 <input ...> 标签本身是取不到 <label> 的，而旧版本是「两处 UI 互相比对」，
// 两边都取到 label=null 于是永远相等——这类断言看着绿，实际什么也没守。
function extractSliders(html) {
  const blocks = [...html.matchAll(
    /<div class="property-item[^"]*">\s*<label>([^<]*)<\/label>\s*<input([^>]*)>/g
  )];
  return blocks.map(m => {
    const [, label, attrs] = m;
    const get = name => {
      const found = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return found ? found[1] : null;
    };
    return {
      prop: get('data-module-prop') || get('data-prop'),
      label: label.trim(),
      min: get('min'),
      max: get('max'),
      step: get('step')
    };
  }).filter(s => s.prop && s.prop.startsWith('filter:'));
}

// 直接调调色 UI 的渲染入口（桩件化其依赖）
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

const moduleSliders = extractSliders(moduleHTML);

check('调色 UI 渲染出了滑块', moduleSliders.length > 0,
  `module=${moduleSliders.length}`);
check('滑块数量与表里 inUi 参数数量一致', moduleSliders.length === uiItems.length,
  `module=${moduleSliders.length} table=${uiItems.length}`);
check(
  '滑块逐项等于表定义（prop/label/min/max/step）',
  moduleSliders.length === uiItems.length
    && moduleSliders.every((s, i) => {
      const item = uiItems[i];
      return s.prop === `filter:${item.type}` && s.label === item.label
        && s.min === String(item.min) && s.max === String(item.max)
        && s.step === String(item.step);
    })
);
check(
  '滑块顺序与表键序一致',
  moduleSliders.map(s => s.prop.replace('filter:', '')).join(',')
    === uiItems.map(i => i.type).join(',')
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

console.log('\n8. 新增参数专项：色温（ColorMatrix 矩阵）与反色（Invert 开关）');

// 色温：toFilter 必须产出 20 元素 4x5 矩阵，且除 R/B 常数项外保持恒等，
// 否则色温滑块会连带改变增益或 alpha，画面明暗随之漂移。
const tempParam = FILTER_PARAMS.temperature;
check(
  'temperature 存在且以 ColorMatrix.matrix 承载',
  !!tempParam && tempParam.cls === 'ColorMatrix' && tempParam.attr === 'matrix'
);
check(
  'temperature 矩阵只平移 R/B 常数项（其余保持恒等）',
  (() => {
    if (!tempParam) return false;
    const m = tempParam.toFilter(tempParam.max);
    const identity = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    return m.length === 20
      && m.every((v, i) => (i === 4 || i === 14) || v === identity[i])
      && m[4] > 0 && m[4] === -m[14];
  })()
);
check(
  'temperature 中性矩阵全零偏移、端点可往返',
  tempParam
    && tempParam.toFilter(0)[4] === 0 && tempParam.toFilter(0)[14] === 0
    && Math.abs(tempParam.toUi(tempParam.toFilter(tempParam.max)) - tempParam.max) <= 1
    && Math.abs(tempParam.toUi(tempParam.toFilter(tempParam.min)) - tempParam.min) <= 1
);

// 反色：默认值不写滤镜；底片预设写入 grayscale+invert 两枚滤镜并正确高亮
const negPreset = FILTER_PRESETS.find(p => p.preset === 'filter-negative');
check(
  'filter-negative 底片预设存在且为 grayscale+invert',
  !!negPreset && negPreset.filters.grayscale === 100 && negPreset.filters.invert === 1
);
const negImage = new StubImage();
filters.setFilter(negImage, 'invert', FILTER_PARAMS.invert ? FILTER_PARAMS.invert.default : 0);
check('invert 默认值不写入滤镜数组', negImage.filters.length === 0);
filters.applyFilterPreset(negImage, 'filter-negative');
check(
  '底片预设写入 Grayscale+Invert 两枚滤镜（invert 为 true）',
  negImage.filters.length === 2
    && negImage.filters.some(f => f.type === 'Invert' && f.invert === true)
    && negImage.filters.some(f => f.type === 'Grayscale')
);
check(
  '底片预设应用后判为高亮，且不误伤相邻黑白预设',
  filters.isPresetActive(negImage, 'filter-negative') === true
    && filters.isPresetActive(negImage, 'filter-bw') === false
);
check(
  '底片预设的缩略图清单与实际滤镜同源',
  (() => {
    const expected = filters.getPresetFilterValues(negPreset);
    return expected.length === 2
      && expected.some(e => e.type === 'Invert' && e.attr === 'invert' && e.value === true)
      && expected.some(e => e.type === 'Grayscale');
  })()
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
