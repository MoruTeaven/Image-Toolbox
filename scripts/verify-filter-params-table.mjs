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
 *   6. 撤销/重做链路保留 filters（快照序列化 props 里有 'filters'）；
 *   9. 棕褐 / 灰度是可调强度滤镜：矩阵按强度插值、强度进快照、快照往返后
 *      仍能读回并列进调色 UI（看板卡 t-mumiz038-z392ul）。
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
//
// 桩件尽量贴近 fabric 5.3 的真实形状：util.createClass 的支持继承，滤镜的
// toObject 只输出 { type, [mainParameter] }。棕褐/灰度/反色是本项目装到
// fabric.Image.filters 上的自定义滤镜（见 filters.js 的 installIntensityFilters），
// 因此这里**不要**预先塞同名类——塞了就测不到「用户拿到的确实是自定义实现」。

/* fabric 滤镜桩件：尽量贴近 5.3 的真实形状
 *
 * 关键点（踩过就会导致断言假阴性）：
 *   - 具体滤镜的 type 属于类原型，构造时不能把快照里的 type 覆盖到实例上；
 *   - toObject 只输出 { type, [mainParameter] }，且与原型默认值相同的字段不写；
 *   - 棕褐/灰度/反色是本项目自定义的滤镜，这里不预置同名类，
 *     否则测不到「用户拿到的确实是自定义实现」。
 */
class StubFilter {
  constructor(opts = {}) {
    Object.keys(opts).forEach(key => {
      if (key !== 'type') this[key] = opts[key];
    });
    this.type = typeOfClass(this.constructor);
  }
  applyTo2d() {}
  isNeutralState() {
    return true;
  }
  toObject() {
    const obj = { type: this.type };
    const main = this.mainParameter;
    if (!main) return obj;
    const value = this[main];
    const defaultValue = lookupDefault(this, main);
    const sameAsDefault = Array.isArray(value) && Array.isArray(defaultValue)
      ? value.length === defaultValue.length && value.every((v, i) => v === defaultValue[i])
      : value === defaultValue;
    if (!sameAsDefault) obj[main] = value;
    return obj;
  }
}

/** 滤镜类的 type（类原型链上最近的一层） */
function typeOfClass(Cls) {
  let proto = Cls && Cls.prototype;
  while (proto) {
    if (Object.prototype.hasOwnProperty.call(proto, 'type')) return proto.type;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

/** 实例属性 main 的原型默认值（不取实例自身） */
function lookupDefault(instance, main) {
  let proto = Object.getPrototypeOf(instance);
  while (proto) {
    if (Object.prototype.hasOwnProperty.call(proto, main)) return proto[main];
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function makeFilterClass(type) {
  const cls = class extends StubFilter {
    constructor(options = {}) {
      super(options);
      // 与 fabric 一致：具体滤镜的 initialize 会把选项落到实例上（fabric 各滤镜
      // 用 createClass 的 initialize + setOptions 实现，这里等价处理）
      baseInitialize(this, options);
    }
  };
  cls.__fabricType = type;
  cls.prototype.type = type;
  return cls;
}

/** 对应 fabric.BaseFilter 的 initialize(options) → setOptions(options) */
function baseInitialize(target, options = {}) {
  Object.keys(options).forEach(key => {
    target[key] = options[key];
  });
}

const FILTER_CLASSES = {
  BaseFilter: makeFilterClass('BaseFilter'),
  Brightness: makeFilterClass('Brightness'),
  /* 默认值与 fabric 一致：各滤镜的原型默认强度 */
  Contrast: makeFilterClass('Contrast'),
  Saturation: makeFilterClass('Saturation'),
  Vibrance: makeFilterClass('Vibrance'),
  Gamma: makeFilterClass('Gamma'),
  HueRotation: makeFilterClass('HueRotation'),
  Blur: makeFilterClass('Blur'),
  ColorMatrix: makeFilterClass('ColorMatrix'),
  Invert: makeFilterClass('Invert'),
  Noise: makeFilterClass('Noise'),
  Pixelate: makeFilterClass('Pixelate')
};
FILTER_CLASSES.Brightness.prototype.mainParameter = 'brightness';
FILTER_CLASSES.Brightness.prototype.brightness = 0;
FILTER_CLASSES.Contrast.prototype.mainParameter = 'contrast';
FILTER_CLASSES.Contrast.prototype.contrast = 0;
FILTER_CLASSES.Saturation.prototype.mainParameter = 'saturation';
FILTER_CLASSES.Saturation.prototype.saturation = 0;
FILTER_CLASSES.Vibrance.prototype.mainParameter = 'vibrance';
FILTER_CLASSES.Vibrance.prototype.vibrance = 0;
FILTER_CLASSES.Gamma.prototype.mainParameter = 'gamma';
FILTER_CLASSES.Gamma.prototype.gamma = [1, 1, 1];
FILTER_CLASSES.HueRotation.prototype.mainParameter = 'rotation';
FILTER_CLASSES.HueRotation.prototype.rotation = 0;
FILTER_CLASSES.Blur.prototype.mainParameter = 'blur';
FILTER_CLASSES.Blur.prototype.blur = 0;
FILTER_CLASSES.Noise.prototype.mainParameter = 'noise';
FILTER_CLASSES.Noise.prototype.noise = 0;
FILTER_CLASSES.Pixelate.prototype.mainParameter = 'blocksize';
FILTER_CLASSES.Pixelate.prototype.blocksize = 1;
FILTER_CLASSES.ColorMatrix.prototype.mainParameter = 'matrix';
// fabric 的 ColorMatrix.initialize：先落选项，再把 matrix 复制一份
FILTER_CLASSES.ColorMatrix.prototype.initialize = function (options = {}) {
  baseInitialize(this, options);
  this.matrix = Array.isArray(this.matrix) ? this.matrix.slice() : this.matrix;
};
FILTER_CLASSES.ColorMatrix.prototype.applyTo2d = function () {};
FILTER_CLASSES.Invert.prototype.mainParameter = 'invert';
FILTER_CLASSES.Invert.prototype.invert = false;
FILTER_CLASSES.Invert.fromObject = () => {};

/** 当前正在调用的方式 → callSuper 跳到哪一层（WeakMap，避免往函数上挂可被覆盖的属性） */
const CALL_SUPER_TARGETS = new WeakMap();

/**
 * fabric.util.createClass 的最小实现：支持单继承与 callSuper
 *
 * fabric 5.3 的 createClass 会把 this.callSuper 指向父原型的同名方法，
 * 方法名由调用时传入（`this.callSuper('initialize', options)`）。这里复刻同一语义：
 *   - 构造函数调用 initialize；
 *   - 每个实例方法都能用 this.callSuper('方法名', ...args) 调父实现。
 *
 * ⚠ 别把 callSuper 当成函数自身属性挂上去：方法体里的 this 是调用者实例，
 * 读不到函数上的属性，照那样写只会得到「this.callSuper is not a function」。
 * 正确做法是把它作为原型链成员，用 WeakMap 记住每个实例方法对应的父实现。
 */
function createClass(parent, props = {}) {
  const Base = parent && typeof parent === 'function' ? parent : Object;
  function Child(...args) {
    if (typeof this.initialize === 'function') {
      this.initialize(...args);
    }
  }
  Child.prototype = Object.create(Base.prototype);
  Child.prototype.constructor = Child;
  Object.keys(props).forEach(key => {
    const value = props[key];
    const parentImpl = typeof Base.prototype[key] === 'function' ? Base.prototype[key] : null;
    if (typeof value === 'function') {
      const wrapper = function (...args) {
        return value.apply(this, args);
      };
      CALL_SUPER_TARGETS.set(wrapper, { parentImpl, key });
      Child.prototype[key] = wrapper;
    } else {
      Child.prototype[key] = value;
    }
  });
  // 实例上的 callSuper：沿原型链找到最近一层的实例方法，再取其父实现
  Object.defineProperty(Child.prototype, 'callSuper', {
    configurable: true,
    writable: true,
    value: function (method, ...args) {
      let proto = Object.getPrototypeOf(this);
      while (proto) {
        if (Object.prototype.hasOwnProperty.call(proto, method || '')) {
          const meta = CALL_SUPER_TARGETS.get(proto[method]);
          if (!meta) break;
          const target = meta.parentImpl;
          return target ? target.apply(this, args) : undefined;
        }
        proto = Object.getPrototypeOf(proto);
      }
      throw new Error(`this.callSuper('${method}') 找不到父实现`);
    }
  });
  return Child;
}

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
  util: { createClass },
  Image: Object.assign(function ImageStub() {}, { filters: FILTER_CLASSES })
};

// ── 载入被测模块 ──

fs.writeFileSync('C:/Users/c/AppData/Local/Temp/mtruth.txt', import.meta.url + '\n');
const filters = await import('../core/src/utils/filters.js');
const { FILTER_PARAMS, FILTER_PRESETS } = filters;

const TYPES = Object.keys(FILTER_PARAMS);

/** fabric 类名 → 参数类型（断言里按表回查属性名用） */
const FILTER_CLASS_TO_TYPE = Object.fromEntries(
  TYPES.map(t => [FILTER_PARAMS[t].cls, t])
);

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
//   • invert：fabric 5.3 的 Invert 是布尔开关，没有强度，做成滑块只会写多余字段
//   • noise / pixelate：预设专用的质感参数，量纲（0~100 / blocksize 1~30）与常规调色不同
// sepia / grayscale 曾属第一类（fabric 原生滤镜无强度属性），t-mumiz038-z392ul 已改为
// 自定义的矩阵插值强度滤镜，因此现在必须在 UI 露出，见第 9 节。
const PRESET_ONLY_OK = ['invert', 'noise', 'pixelate'];
const usedByPresets = new Set(
  FILTER_PRESETS.flatMap(p => Object.keys(p.filters || {}))
);
check(
  '预设使用的参数要么在 UI 露出，要么属于已知预设专用项',
  [...usedByPresets].every(t => FILTER_PARAMS[t].inUi || PRESET_ONLY_OK.includes(t)),
  [...usedByPresets].filter(t => !FILTER_PARAMS[t].inUi && !PRESET_ONLY_OK.includes(t)).join(', ')
);
check(
  '棕褐 / 灰度已露出为可调参数（inUi 为 true）',
  ['sepia', 'grayscale'].every(t => FILTER_PARAMS[t] && FILTER_PARAMS[t].inUi === true)
);
check(
  '无强度属性的反色仍保持 inUi:false',
  FILTER_PARAMS.invert && FILTER_PARAMS.invert.inUi === false
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

// 实际写入的滤镜 → { type, attr, value }：属性取表里的 attr，
// 不再「猜第一个非 type 的键」——强度类滤镜还有 matrix / mode，猜法会取错
const actual = image.filters.map(f => {
  const param = FILTER_PARAMS[FILTER_CLASS_TO_TYPE[f.type]];
  return { type: f.type, attr: param.attr, value: f[param.attr] };
});
const expected = filters.getPresetFilterValues(preset);

check(
  '应用预设后实际滤镜 == getPresetFilterValues（缩略图与画面同源）',
  actual.length === expected.length
    && actual.every((a, i) => {
      const e = expected[i];
      if (a.type !== e.type || a.attr !== e.attr) return false;
      if (Array.isArray(e.value)) {
        return Array.isArray(a.value)
          && a.value.length === e.value.length
          && a.value.every((v, k) => Math.abs(v - e.value[k]) < 1e-9);
      }
      return Math.abs(a.value - e.value) < 1e-9;
    }),
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

// 逐项确认滑块写入的色调值没有串味：每类滤镜只带自己的属性，且值等于表换算结果。
// 只比顺序不够：截断过的属性（例如 hue 的 rotation 被写成 0.2π 但表要 20°）在
// 顺序断言里看不出来。
check(
  '逐项写入后每类滤镜只携带自己的属性且值与表换算一致',
  (() => {
    const img = new StubImage();
    ['brightness', 'gamma', 'contrast', 'hue'].forEach(type => filters.setFilter(img, type, 20, true));
    return img.filters.length === 4 && img.filters.every(f => {
      const param = FILTER_PARAMS[FILTER_CLASS_TO_TYPE[f.type]];
      const own = f[param.attr];
      const expected = param.toFilter(20);
      if (Array.isArray(expected)) {
        return Array.isArray(own) && own.every((v, i) => Math.abs(v - expected[i]) < 1e-9);
      }
      return Math.abs(own - expected) < 1e-9;
    });
  })()
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
// 反色的类名取表（cls: InvertIntensity），不在这里再写一份字符串
const INVERT_CLASS = FILTER_PARAMS.invert.cls;
check(
  '底片预设写入 Grayscale+Invert 两枚滤镜（invert 为 true）',
  negImage.filters.length === 2
    && negImage.filters.some(f => f.type === INVERT_CLASS && f.invert === true)
    && negImage.filters.some(f => f.type === 'Grayscale' && f.grayscale === 1)
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
      && expected.some(e => e.type === INVERT_CLASS && e.attr === 'invert' && e.value === true)
      && expected.some(e => e.type === 'Grayscale' && Math.abs(e.value - 1) < 1e-9);
  })()
);

console.log('\n9. 棕褐 / 灰度：矩阵插值强度 + 快照往返（t-mumiz038-z392ul）');

// 曾有的缺陷：表里把 sepia / grayscale 当「无强度属性」的预设开关，画面恒为满强度；
// 且 BaseFilter.toObject 只输出 { type, mainParameter }，强度不进快照，
// 撤销/重做、复制图层、ORA 往返后读回 0，预设高亮随之丢失。
// 现在两者是 ColorMatrix 派生的自定义强度滤镜，强度属性即 mainParameter。
const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const SepiaClass = FILTER_CLASSES[FILTER_PARAMS.sepia.cls];
const GrayClass = FILTER_CLASSES[FILTER_PARAMS.grayscale.cls];

check(
  'Sepia 类由 ColorMatrix 派生（WebGL 与 Canvas2D 复用同一实现）',
  typeof SepiaClass === 'function' && SepiaClass.prototype instanceof FILTER_CLASSES.ColorMatrix
);
check(
  'Grayscale 类由 ColorMatrix 派生',
  typeof GrayClass === 'function' && GrayClass.prototype instanceof FILTER_CLASSES.ColorMatrix
);
check(
  'sepia / grayscale 的强度属性就是 mainParameter（toObject 会写进快照）',
  SepiaClass.prototype.mainParameter === 'sepia'
    && GrayClass.prototype.mainParameter === 'grayscale'
);

const sepiaMid = new SepiaClass({ sepia: 0.55 });
check(
  '棕褐强度 0.55 → 矩阵在单位矩阵与满强度棕褐之间线性插值',
  sepiaMid.matrix.length === 20
    && Math.abs(sepiaMid.matrix[1] - 0.769 * 0.55) < 1e-6
    && Math.abs(sepiaMid.matrix[0] - (1 - 0.607 * 0.55)) < 1e-6
    && sepiaMid.matrix[18] === 1
);
check(
  '棕褐强度 0 → 恒等矩阵（等同未套滤镜）',
  new SepiaClass({ sepia: 0 }).matrix.every((v, i) => v === IDENTITY[i])
);
check(
  '棕褐强度 1 → 标准满强度棕褐矩阵',
  (() => {
    const m = new SepiaClass({ sepia: 1 }).matrix;
    return Math.abs(m[0] - 0.393) < 1e-6 && Math.abs(m[1] - 0.769) < 1e-6 && Math.abs(m[2] - 0.189) < 1e-6;
  })()
);
check(
  '棕褐强度 0 视为中性（fabric 会跳过该滤镜的重算）',
  new SepiaClass({ sepia: 0 }).isNeutralState() === true
    && new SepiaClass({ sepia: 0.2 }).isNeutralState() === false
);

const grayMid = new GrayClass({ grayscale: 0.2 });
check(
  '灰度强度 0.2 → 矩阵按 luminosity 权重插值',
  (() => {
    const t = 0.2;
    const w = [0.21, 0.72, 0.07];
    // 仿射等价：M(t) = I + t·(G - I)，G 每行都是 [wr, wg, wb]。
    // 所以「R 项是否 i === j」决定这一格是恒等 1 还是被灰度权重替换。
    const expected = (i, j) => (i === j ? 1 : 0) + ((i < 3 ? w[j] : 0) - (i === j ? 1 : 0)) * t;
    return [0, 1, 2].every(i => [0, 1, 2].every(j => Math.abs(grayMid.matrix[i * 5 + j] - expected(i, j)) < 1e-6))
      && [0, 1, 2].every(i => [3, 4].every(j => grayMid.matrix[i * 5 + j] === 0))
      && [15, 16, 17, 19].every(k => grayMid.matrix[k] === 0)
      && grayMid.matrix[18] === 1;
  })(),
  `m=${JSON.stringify(grayMid.matrix)}`
);
check(
  '灰度保留 mode 语义：average / lightness / luminosity 权重不同',
  (() => {
    const avg = new GrayClass({ grayscale: 1, mode: 'average' }).matrix[1];
    const light = new GrayClass({ grayscale: 1, mode: 'lightness' }).matrix[1];
    const lum = new GrayClass({ grayscale: 1, mode: 'luminosity' }).matrix[1];
    return Math.abs(avg - 1 / 3) < 1e-6 && Math.abs(light - 0.5) < 1e-6 && Math.abs(lum - 0.72) < 1e-6;
  })()
);
check(
  '灰度强度 0 → 恒等矩阵',
  new GrayClass({ grayscale: 0 }).matrix.every((v, i) => v === IDENTITY[i])
);

// 快照往返：撤销/重做与复制图层都走 toObject → fromObject
const sepiaImage = new StubImage();
filters.setFilter(sepiaImage, 'sepia', 55);
filters.setFilter(sepiaImage, 'grayscale', 20);
const snapshot = sepiaImage.filters.map(f => f.toObject());
check(
  '强度写进滤镜快照（toObject 输出 sepia / grayscale）',
  snapshot.length === 2
    && Math.abs(snapshot[0].sepia - 0.55) < 1e-9
    && Math.abs(snapshot[1].grayscale - 0.2) < 1e-9
);
const restoredImage = new StubImage();
restoredImage.filters = snapshot.map(json => new FILTER_CLASSES[json.type](json));
check(
  '快照往返后强度能读回，且预设高亮判定正确',
  filters.getFilterUiValue(restoredImage, 'sepia') === 55
    && filters.getFilterUiValue(restoredImage, 'grayscale') === 20
    && filters.isPresetActive(restoredImage, 'filter-vintage') === false
);

// 复古 / 黑白预设：预设值写进去、读回来，且高亮
['filter-vintage', 'filter-gingham', 'filter-1977', 'filter-bw', 'filter-inkwell'].forEach(name => {
  const p = FILTER_PRESETS.find(item => item.preset === name);
  const img = new StubImage();
  filters.applyFilterPreset(img, name);

  // 快照往返：模拟 fabric 的 enliven → 用 classes[type] 构造快照里的字段
  const roundTrip = new StubImage();
  roundTrip.filters = img.filters.map(f => new FILTER_CLASSES[f.toObject().type](f.toObject()));

  const sepiaActual = filters.getFilterUiValue(roundTrip, 'sepia');
  const grayActual = filters.getFilterUiValue(roundTrip, 'grayscale');
  const activeBefore = filters.isPresetActive(img, name);
  const activeAfter = filters.isPresetActive(roundTrip, name);
  const badParams = Object.keys(FILTER_PARAMS)
    .filter(t => Math.abs(filters.getFilterUiValue(roundTrip, t) - (p.filters[t] ?? 0)) >= 0.5);
  const detail = `sepia=${sepiaActual}/${p.filters.sepia || 0} grayscale=${grayActual}/${p.filters.grayscale || 0}`
    + ` active=${activeBefore}/${activeAfter}`
    + ` bad=${badParams.join('+')}`
    + ` types=${roundTrip.filters.map(f => f.type).join(',')}`;
  check(
    `预设 ${name}：棕褐/灰度强度往返一致并保持高亮`,
    activeBefore === true
      && activeAfter === true
      && sepiaActual === (p.filters.sepia || 0)
      && grayActual === (p.filters.grayscale || 0),
    detail
  );
});

// 旧快照：只有 { type: 'Sepia' } 没有强度属性时不得读成 0（会连带移除仍在生效的滤镜）。
// 注意：构造之后再 delete 属性会落到原型上的同名默认值（0）——那正是「属性缺失」的
// 真实形态，所以这里按 fabric 的 fromObject 路径构造，再显式置成 undefined。
const LEGACY_SEPIA_MATRIX = [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
const legacyImage = new StubImage();
legacyImage.filters = [new SepiaClass({ matrix: LEGACY_SEPIA_MATRIX })];
// 构造函数会按强度重建矩阵（强度缺失时得到恒等矩阵），旧快照里的矩阵是跟着一起存的，
// 这里把快照里的矩阵写回去，模拟「强度属性丢了、矩阵还在」
legacyImage.filters[0].sepia = undefined;
legacyImage.filters[0].matrix = LEGACY_SEPIA_MATRIX.slice();
check(
  '旧快照只带矩阵时按矩阵反推强度（满强度读回 100）',
  filters.getFilterUiValue(legacyImage, 'sepia') === 100,
  `got=${filters.getFilterUiValue(legacyImage, 'sepia')}`
);

// 反色的序列化类型必须稳定，否则 enlivenObjects 取不到类会抛错
const invertImage = new StubImage();
filters.applyFilterPreset(invertImage, 'filter-negative');
const invertFilter = invertImage.filters.find(f => f.type === INVERT_CLASS);
const invertJson = invertFilter ? invertFilter.toObject() : {};
// 反色是布尔开关，不是强度：快照里有没有 invert 字段都等价于「开」，
// 真正要守的是类型稳定（fabric 的 Invert 会按主参数把类型切成 Invert / InvertIntensity，
// 而 getKlass('InvertIntensity') 在原生 fabric 上是找不到类的）
check(
  '反色滤镜序列化类型固定为 InvertIntensity（可被 enlivenObjects 反解）',
  invertJson.type === INVERT_CLASS && invertFilter.invert === true,
  `json=${JSON.stringify(invertJson)} invert=${invertFilter && invertFilter.invert} types=${invertImage.filters.map(f => f.type).join(',')}`
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
