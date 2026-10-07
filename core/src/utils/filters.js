/**
 * 滤镜工具 — 统一管理 fabric.Image 的滤镜读写与预设
 *
 * 所有调色参数集中在 FILTER_PARAMS 一处定义：fabric 类名、属性名、UI 取值范围、
 * UI 值与滤镜实际值的换算、是否作为滑块露出，以及滤镜的应用顺序。
 * 新增一个参数只需在表里加一条，其余（应用预设 / 预设高亮判定 / 效果缩略图 /
 * 两处调色面板的滑块清单）都由它派生，不需要再改第二处。
 *
 * Fabric.js 5.3.0 本模块用到的滤镜（均挂在 fabric.Image.filters 命名空间下）：
 *   Brightness   亮度      brightness 属性 -1 ~ 1
 *   Contrast     对比度    contrast   属性 -1 ~ 1
 *   Saturation   饱和度    saturation 属性 -1 ~ 1
 *   Vibrance     自然饱和  vibrance   属性 -1 ~ 1
 *   HueRotation  色相旋转  rotation   属性 弧度（-π ~ π）
 *   Blur         高斯模糊  blur       属性 0 ~ 1
 *
 * ⚠ Sepia 与 Grayscale 没有强度属性，别把它们做成滑块：
 *   Sepia 是 ColorMatrix 派生的固定矩阵（mainParameter 为 false），
 *   Grayscale 只有 mode（average / lightness / luminosity）。
 *   传进去的 sepia / grayscale 数值只会成为滤镜对象上的多余字段，画面强度恒定
 *   （棕褐恒为满强度、灰度恒为全灰）。所以这两项目前只当预设的整体开关用，
 *   inUi 一律为 false；改成真正可调强度的方案见看板卡 t-mumiz038-z392ul。
 *
 * 每个 fabric.Image 实例都有一个 filters 数组，滤镜按数组顺序依次应用。
 * 本模块约定：
 *   - 同一类型的滤镜在数组中只保留一个实例，覆盖式更新；
 *   - 数组顺序固定按 FILTER_PARAMS 的声明顺序（见 sortFilters），不由用户的
 *     拖动先后决定。饱和度与自然饱和度都依赖像素当前值、不可交换，若听任
 *     操作顺序，同样的数值会因拖动次序不同而得出不同画面，且预设高亮判定
 *     （只比值不比顺序）与效果缩略图都会与实际画面对不上。
 */

import { clamp } from './helpers.js';

/** 自然饱和度的 UI 满量程：滑块推到 ±77 即滤镜的 ±1（收窄量程见表内说明） */
const VIBRANCE_FULL_SCALE = 77;

/** 中间调（Gamma）的 UI 满量程：滑块推到 ±77 时 gamma 为 1 ± 0.77（中性值为 1） */
const GAMMA_FULL_SCALE = 77;

/** 比例型参数的换算：UI 百分比 ↔ 滤镜 -1~1 / 0~1 */
function percentToFilter(value) {
  return clamp(value, -100, 100) / 100;
}

function filterToPercent(value) {
  return Math.round((value || 0) * 100);
}

/**
 * 调色参数定义表
 *
 * 键的书写顺序 = 滤镜在 image.filters 中的应用顺序。
 *
 * @typedef {Object} FilterParam
 * @property {string} label 面板显示名
 * @property {string} cls   fabric.Image.filters 下的类名
 * @property {string} attr  该滤镜在 fabric 中的属性名
 * @property {number} min   滑块最小值（UI 语义）
 * @property {number} max   滑块最大值（UI 语义）
 * @property {number} step  滑块步长
 * @property {number} default 未调整时的 UI 值，写入时不产生滤镜
 * @property {boolean} inUi 是否在调色面板露出滑块；false 时仅供预设使用
 * @property {Function} toFilter UI 值 → 滤镜实际值
 * @property {Function} toUi     滤镜实际值 → UI 值
 */
export const FILTER_PARAMS = {
  brightness: {
    label: '亮度',
    cls: 'Brightness',
    attr: 'brightness',
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  gamma: {
    // Gamma 的属性是 [r, g, b] 数组，这里用单滑块等量控制三个通道：
    // 只抬/压中间调，黑场与白场不动，因此不会像「亮度」那样把暗部推灰或让高光溢出。
    // UI ±77 → gamma = 1 ± 0.77（中性 1），与「亮度」「对比」互补
    label: '中间调',
    cls: 'Gamma',
    attr: 'gamma',
    min: -GAMMA_FULL_SCALE,
    max: GAMMA_FULL_SCALE,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: value => {
      const g = 1 + clamp(value, -GAMMA_FULL_SCALE, GAMMA_FULL_SCALE) / 100;
      return [g, g, g];
    },
    // 属性可能是数组：取首个通道即可还原滑块值（三通道由单滑块等量写入）
    toUi: value => {
      const g = Array.isArray(value) ? value[0] : value;
      return Math.round(((g == null ? 1 : g) - 1) * 100);
    },
  },
  contrast: {
    label: '对比',
    cls: 'Contrast',
    attr: 'contrast',
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  saturation: {
    label: '饱和',
    cls: 'Saturation',
    attr: 'saturation',
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  vibrance: {
    // 与「饱和」同向但算法不同：只抬低饱和的区域，肤色与天空不容易调过头。
    // 两者允许同时使用，叠加后最容易过冲，因此满量程收窄到 ±77
    label: '自然饱和',
    cls: 'Vibrance',
    attr: 'vibrance',
    min: -VIBRANCE_FULL_SCALE,
    max: VIBRANCE_FULL_SCALE,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: value => clamp(value, -VIBRANCE_FULL_SCALE, VIBRANCE_FULL_SCALE) / VIBRANCE_FULL_SCALE,
    toUi: value => Math.round((value || 0) * VIBRANCE_FULL_SCALE),
  },
  hue: {
    label: '色相',
    cls: 'HueRotation',
    attr: 'rotation',
    min: -180,
    max: 180,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: value => clamp(value, -180, 180) * Math.PI / 180,
    toUi: value => Math.round((value || 0) * 180 / Math.PI),
  },
  sepia: {
    label: '棕褐',
    cls: 'Sepia',
    attr: 'sepia',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: false,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  grayscale: {
    label: '灰度',
    cls: 'Grayscale',
    attr: 'grayscale',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: false,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  blur: {
    label: '模糊',
    cls: 'Blur',
    attr: 'blur',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: value => clamp(value, 0, 100) / 100,
    toUi: value => Math.round((value || 0) * 100),
  },
};

/** 全部调色类型，键序即滤镜应用顺序 */
const ALL_FILTER_TYPES = Object.keys(FILTER_PARAMS);

/** 参数类型 → 应用顺序下标 */
const FILTER_ORDER_INDEX = {};
ALL_FILTER_TYPES.forEach((type, index) => {
  FILTER_ORDER_INDEX[type] = index;
});

/** 参数类型 → fabric 类名 */
const FILTER_CLASS_NAME = {};
/** 参数类型 → 滤镜属性名 */
const FILTER_ATTR_NAME = {};
/** fabric 类名 → 参数类型（排序时反查用） */
const FILTER_TYPE_TO_PARAM = {};
ALL_FILTER_TYPES.forEach(type => {
  FILTER_CLASS_NAME[type] = FILTER_PARAMS[type].cls;
  FILTER_ATTR_NAME[type] = FILTER_PARAMS[type].attr;
  FILTER_TYPE_TO_PARAM[FILTER_PARAMS[type].cls] = type;
});

/**
 * UI 滑块范围定义（仅供读取兜底与外部查询，面板渲染请用 getUiFilterItems）
 * 仅包含 inUi 为 true 的参数
 */
export const FILTER_RANGES = {};
ALL_FILTER_TYPES.forEach(type => {
  if (!FILTER_PARAMS[type].inUi) return;
  const param = FILTER_PARAMS[type];
  FILTER_RANGES[type] = { min: param.min, max: param.max, step: param.step, default: param.default };
});

/**
 * 调色面板的滑块清单（两处调色 UI 共用，避免各抄一份）
 * @returns {Array<{type: string, label: string, min: number, max: number, step: number, default: number}>}
 */
export function getUiFilterItems() {
  return ALL_FILTER_TYPES
    .filter(type => FILTER_PARAMS[type].inUi)
    .map(type => ({
      type,
      label: FILTER_PARAMS[type].label,
      min: FILTER_PARAMS[type].min,
      max: FILTER_PARAMS[type].max,
      step: FILTER_PARAMS[type].step,
      default: FILTER_PARAMS[type].default,
    }));
}

/** 某参数的默认 UI 值 */
function getDefaultUiValue(type) {
  const param = FILTER_PARAMS[type];
  return param ? param.default : 0;
}

/**
 * 预设中某参数应取的值
 * 预设未声明的参数一律回落默认值 —— 应用预设的语义是「整套参数换一遍」，
 * 因此手调过的、预设里没写的参数会被归零（与亮度/饱和等既有表现一致）。
 * @param {object} preset FILTER_PRESETS 中的一项
 * @param {string} type
 * @returns {number}
 */
function getPresetParamValue(preset, type) {
  if (preset && preset.filters && preset.filters[type] != null) {
    return preset.filters[type];
  }
  return getDefaultUiValue(type);
}

/**
 * 将 UI 滑块值（百分比或度数）换算为 fabric 滤镜实际值
 * @param {string} type
 * @param {number} uiValue
 * @returns {number}
 */
export function uiToFilterValue(type, uiValue) {
  const param = FILTER_PARAMS[type];
  if (!param) return uiValue;
  return param.toFilter(uiValue);
}

/**
 * 将 fabric 滤镜值换算为 UI 滑块值
 * @param {string} type
 * @param {number} filterValue
 * @returns {number}
 */
export function filterToUiValue(type, filterValue) {
  const param = FILTER_PARAMS[type];
  if (!param) return Math.round(filterValue || 0);
  return param.toUi(filterValue);
}

function getFilterClass(type) {
  const className = FILTER_CLASS_NAME[type];
  if (!className) return null;
  return (typeof fabric !== 'undefined' && fabric.Image && fabric.Image.filters)
    ? fabric.Image.filters[className]
    : null;
}

/** 滤镜在固定顺序中的位置；不属于调色参数的滤镜排到末尾 */
function orderIndexOfFilter(filter) {
  const type = filter && FILTER_TYPE_TO_PARAM[filter.type];
  return type ? FILTER_ORDER_INDEX[type] : Number.MAX_SAFE_INTEGER;
}

/**
 * 按 FILTER_PARAMS 的声明顺序重排滤镜数组
 *
 * Array.prototype.sort 自 ES2019 起保证稳定，因此排到末尾的非调色滤镜
 * 之间仍保持原有相对顺序。
 * @param {fabric.Image} image
 */
function sortFilters(image) {
  image.filters.sort((a, b) => orderIndexOfFilter(a) - orderIndexOfFilter(b));
}

/**
 * 读取图片上某类滤镜的当前值（无则返回默认值）
 * @param {fabric.Image} image
 * @param {string} type
 * @returns {number} UI 滑块值
 */
export function getFilterUiValue(image, type) {
  const fallback = getDefaultUiValue(type);
  if (!image || !Array.isArray(image.filters)) return fallback;

  const className = FILTER_CLASS_NAME[type];
  if (!className) return fallback;

  const filter = image.filters.find(f => f && f.type === className);
  if (!filter) return fallback;

  const attr = FILTER_ATTR_NAME[type];
  return filterToUiValue(type, filter[attr]);
}

/**
 * 设置/替换图片上的某类滤镜
 * @param {fabric.Image} image
 * @param {string} type
 * @param {number} uiValue
 * @param {boolean} [skipApply=false] 为 true 时跳过 applyFilters(image) 重算，
 *   用于批量设置（如应用预设）时避免多次重复调用昂贵的滤镜重算；
 *   调用方需在批量结束后自行触发一次重算
 */
export function setFilter(image, type, uiValue, skipApply = false) {
  if (!image) return;

  if (!Array.isArray(image.filters)) {
    image.filters = [];
  }

  const param = FILTER_PARAMS[type];
  if (!param) return;

  const FilterClass = getFilterClass(type);
  if (!FilterClass) return;

  // 移除同类型旧滤镜
  image.filters = image.filters.filter(f => !(f && f.type === param.cls));

  // 默认值不写入（避免无效滤镜堆积）
  if (uiValue === getDefaultUiValue(type)) {
    if (!skipApply) applyFilters(image);
    return;
  }

  const filterValue = uiToFilterValue(type, uiValue);
  const filter = new FilterClass({ [param.attr]: filterValue });
  image.filters.push(filter);
  sortFilters(image);

  if (!skipApply) applyFilters(image);
}

/**
 * 清除图片上的所有滤镜
 * @param {fabric.Image} image
 */
export function clearFilters(image) {
  if (!image) return;
  image.filters = [];
  applyFilters(image);
}

/**
 * 应用滤镜到图片（触发重新渲染）
 * @param {fabric.Image} image
 */
function applyFilters(image) {
  if (typeof image.applyFilters === 'function') {
    image.applyFilters();
  }
}

/**
 * 判断图片是否完全无滤镜
 * @param {fabric.Image} image
 * @returns {boolean}
 */
export function hasNoFilters(image) {
  if (!image || !Array.isArray(image.filters)) return true;
  return image.filters.length === 0;
}

// ── 预设 ──

/**
 * 滤镜预设定义
 * 每个预设的 filters 字段为 { type: uiValue } 映射，未列出的类型重置为默认值
 */
export const FILTER_PRESETS = [
  {
    preset: 'filter-original',
    label: '原图',
    filters: {},
  },
  {
    preset: 'filter-warm',
    label: '暖色',
    filters: { brightness: 6, saturation: 18, hue: -12, vibrance: 12 },
  },
  {
    preset: 'filter-cool',
    label: '冷色',
    filters: { brightness: 2, saturation: -8, hue: 14, vibrance: -6 },
  },
  {
    preset: 'filter-vintage',
    label: '复古',
    // 中间调提亮是褪色的关键：只抬中间调，黑场不被推灰
    filters: { brightness: 4, contrast: -8, saturation: -12, gamma: 14, sepia: 55 },
  },
  {
    preset: 'filter-bw',
    label: '黑白',
    filters: { grayscale: 100, contrast: 8, gamma: -6 },
  },
  {
    preset: 'filter-vivid',
    label: '鲜艳',
    // 由自然饱和分担一部分，避免饱和度拉高后肤色发脏
    filters: { saturation: 40, contrast: 14, brightness: 4, vibrance: 22 },
  },
  {
    preset: 'filter-soft',
    label: '柔光',
    filters: { brightness: 10, contrast: -16, blur: 6, gamma: 10 },
  },
  {
    preset: 'filter-sharp',
    label: '锐利',
    filters: { contrast: 26, saturation: 10, brightness: -2, vibrance: 8 },
  },
  {
    preset: 'filter-airy',
    label: '通透',
    filters: { brightness: 8, contrast: 6, gamma: 16, saturation: 6, vibrance: 18 },
  },
  {
    preset: 'filter-rich',
    label: '浓郁',
    filters: { contrast: 12, gamma: -14, saturation: 8, vibrance: 26 },
  },
  {
    preset: 'filter-faded',
    label: '褪色',
    filters: { brightness: 6, contrast: -14, gamma: 22, saturation: -14 },
  },
  {
    preset: 'filter-sunset',
    label: '日落',
    // 暖调走色相 + 饱和，不用棕褐（棕褐是固定强度的开关，弱不了）
    filters: { brightness: 4, saturation: 22, hue: -14, vibrance: 14 },
  },
  {
    preset: 'filter-teal',
    label: '青调',
    filters: { contrast: 10, saturation: -12, hue: 16, vibrance: 8 },
  },
  {
    preset: 'filter-moody',
    label: '暗调',
    filters: { brightness: -10, contrast: 16, gamma: -12, saturation: -10 },
  },
  {
    preset: 'filter-ink',
    label: '高反差',
    filters: { grayscale: 100, contrast: 26, gamma: -10 },
  },
  {
    preset: 'filter-haze',
    label: '柔雾',
    filters: { brightness: 8, contrast: -10, blur: 10, gamma: 14, saturation: -6 },
  },
];

/**
 * 应用滤镜预设到图片
 * @param {fabric.Image} image
 * @param {string} presetName
 */
export function applyFilterPreset(image, presetName) {
  if (!image) return false;
  const preset = FILTER_PRESETS.find(p => p.preset === presetName);
  if (!preset) return false;

  // 重置全部为默认值，再应用预设覆盖
  // 批量设置时跳过逐次 applyFilters，循环结束后统一应用一次，避免重复重算
  ALL_FILTER_TYPES.forEach(type => {
    setFilter(image, type, getPresetParamValue(preset, type), true);
  });
  applyFilters(image);
  return true;
}

/**
 * 计算某个预设应用到图片后的滤镜参数列表（供预览缩略图使用）
 *
 * 与 applyFilterPreset 保持同一套取值规则：未在预设中声明的滤镜重置为默认值，
 * 因而返回结果中会剔除默认值项（与 setFilter 的写入规则一致）；
 * 返回顺序同样是 FILTER_PARAMS 的声明顺序，缩略图与实际画面由此保持一致。
 *
 * @param {object} preset - FILTER_PRESETS 中的一项
 * @returns {Array<{type: string, attr: string, value: number}>}
 */
export function getPresetFilterValues(preset) {
  if (!preset || !preset.filters) return [];

  return ALL_FILTER_TYPES.map(type => {
    const uiValue = getPresetParamValue(preset, type);
    if (uiValue === getDefaultUiValue(type)) return null;

    return {
      type: FILTER_CLASS_NAME[type],
      attr: FILTER_ATTR_NAME[type],
      value: uiToFilterValue(type, uiValue),
    };
  }).filter(item => item && item.type && item.attr);
}

/**
 * 判断当前图片是否匹配某个预设（用于预设按钮高亮）
 * @param {fabric.Image} image
 * @param {string} presetName
 * @returns {boolean}
 */
export function isPresetActive(image, presetName) {
  if (!image) return false;
  const preset = FILTER_PRESETS.find(p => p.preset === presetName);
  if (!preset) return false;

  return ALL_FILTER_TYPES.every(type => {
    const expected = getPresetParamValue(preset, type);
    const actual = getFilterUiValue(image, type);
    return Math.abs(actual - expected) < 0.5;
  });
}
