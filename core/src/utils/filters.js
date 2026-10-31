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
 *   ColorMatrix  色温      matrix     属性 4x5 数组（仅作色温载体，只平移 R/B 常数项，见表内说明）
 *   Invert       反色      invert     属性 布尔开关（预设专用，inUi:false）
 *                （实际写入的是下面的 InvertIntensity：同一套反色管线，但带类型别名，
 *                  不会与色温 / 棕褐 / 灰度共用的 ColorMatrix 类型串味）
 *   Blur         高斯模糊  blur       属性 0 ~ 1
 *   Noise        噪点      noise      属性 0 ~ 100（预设专用，inUi:false）
 *   Pixelate     像素化    blocksize  属性 1 ~ 30（预设专用，inUi:false）
 *
 * ⚠ 棕褐 / 灰度用的是两份「矩阵插值」的自定义滤镜，不是 fabric 自带的 Sepia / Grayscale：
 *   fabric 5.3.0 的 Sepia 是从 ColorMatrix 派生的固定矩阵（mainParameter 为 false），
 *   Grayscale 只有 mode（average / lightness / luminosity），两者都没有强度属性——
 *   传 { sepia: 0.55 } / { grayscale: 0.2 } 只是塞了个没人读的多余字段，
 *   画面强度恒为满（看板卡 t-mumiz038-z392ul）。
 *   现改为两个由 ColorMatrix 派生的自定义滤镜（类型名仍是 Sepia / Grayscale）：
 *     - 矩阵按强度在「单位矩阵 ↔ 目标矩阵」之间线性插值，强度 0 即恒等（无变化）；
 *     - 用 ColorMatrix 作为基类，WebGL 与 Canvas2D 走的是 fabric 自己的同一份实现，
 *       两个后端表现一致；
 *     - type 沿用 'Sepia' / 'Grayscale'，属性名沿用 sepia / grayscale 且是 mainParameter，
 *       因此 fabric 的 BaseFilter.toObject 会把强度写进快照（撤销/重做、复制图层、
 *       ORA 往返后都能读回），旧工程里存的 { type: 'Sepia' } 也能原样反序列化。
 *   反色（Invert）仍是无强度属性的布尔开关，只当预设的整体开关用，inUi 为 false。
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

/** 色温的 UI 满量程：滑块推到 ±77 时 R/B 常数项平移 ±0.77（中性值为 0） */
const TEMPERATURE_FULL_SCALE = 77;

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
  temperature: {
    // 色温：暖（正）整体偏红黄，冷（负）整体偏蓝青。复用现成 ColorMatrix 滤镜：
    // 只平移 R/B 两通道的常数项（4x5 矩阵第 5 列的 index 4 与 14），不动增益与
    // alpha（ColorMatrix 默认 colorsOnly），画面明暗不受影响。
    // UI ±77 → R/B 常数项 ±0.77，与「自然饱和」「中间调」同款满量程约定。
    // 注意 ColorMatrix 类已被本表占用为色温载体：若未来再加矩阵类参数，
    // 需要新的滤镜类，不能共用 cls（同类型滤镜在数组中只保留一个实例）。
    label: '色温',
    cls: 'ColorMatrix',
    attr: 'matrix',
    min: -TEMPERATURE_FULL_SCALE,
    max: TEMPERATURE_FULL_SCALE,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: value => {
      const t = clamp(value, -TEMPERATURE_FULL_SCALE, TEMPERATURE_FULL_SCALE) / 100;
      return [1, 0, 0, 0, t, 0, 1, 0, 0, 0, 0, 0, 1, 0, -t, 0, 0, 0, 1, 0];
    },
    // 属性是 4x5 矩阵：从 R 通道常数项（index 4）反算滑块值
    toUi: value => {
      const t = Array.isArray(value) ? value[4] : value;
      return Math.round((t == null ? 0 : t) * 100);
    },
  },
  sepia: {
    // 棕褐：强度 0 ~ 100 对应「原色 → 满强度棕褐」的线性混合。
    // 由 installIntensityFilters 装到 fabric.Image.filters.Sepia 的强度实现真正按强度插值矩阵，
    // 不是 fabric 自带那个固定矩阵的 Sepia
    label: '棕褐',
    cls: 'Sepia',
    attr: 'sepia',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  grayscale: {
    // 灰度：强度 0 ~ 100 对应「原色 → 全灰」的线性混合。
    // 由 installIntensityFilters 装到 fabric.Image.filters.Grayscale 的强度实现按 mode 权重插值，
    // mode 语义保留（average / lightness / luminosity，默认 luminosity）
    label: '灰度',
    cls: 'Grayscale',
    attr: 'grayscale',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: true,
    toFilter: percentToFilter,
    toUi: filterToPercent,
  },
  invert: {
    // 反色（底片）：fabric 5.3 的 Invert 是开关型（invert 为 true/false），
    // 没有强度属性，别做成滑块——只当预设的整体开关用（棕褐/灰度已是可调强度，见文件头）。
    // UI 值 0 = 关（默认，不写滤镜），1 = 开（写入 invert:true）。
    // 应用顺序刻意排在灰度之后：先变灰再反转才是「底片」，反过来会得到
    // 彩色反转后再压灰的另一种效果。
    label: '反色',
    cls: 'InvertIntensity',
    attr: 'invert',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    inUi: false,
    toFilter: value => value > 0,
    toUi: value => (value ? 1 : 0),
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
  noise: {
    // 胶片颗粒质感：随机像素扰动，0 无噪点，100 满强度。预设专用。
    label: '噪点',
    cls: 'Noise',
    attr: 'noise',
    min: 0,
    max: 100,
    step: 1,
    default: 0,
    inUi: false,
    toFilter: value => Math.round(clamp(value, 0, 100)),
    toUi: value => Math.round(value || 0),
  },
  pixelate: {
    // 像素化/马赛克：blocksize=1 原尺寸，越大越粗。预设专用。
    label: '像素化',
    cls: 'Pixelate',
    attr: 'blocksize',
    min: 0,
    max: 30,
    step: 1,
    default: 0,
    inUi: false,
    toFilter: value => Math.max(1, Math.round(clamp(value, 0, 30))),
    toUi: value => Math.round(value || 0),
  },
};

// ── 强度型棕褐 / 灰度：ColorMatrix 矩阵插值 ──

/** 4x5 单位矩阵（ColorMatrix.matrix 的格式与默认值） */
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** 满强度棕褐矩阵（与 CSS filter: sepia(1) 系数相同，即 fabric 自带 Sepia 的那份） */
const SEPIA_MATRIX = [
  0.393, 0.769, 0.189, 0, 0,
  0.349, 0.686, 0.168, 0, 0,
  0.272, 0.534, 0.131, 0, 0,
  0, 0, 0, 1, 0,
];

/**
 * 灰度权重：保留 fabric 自带 Grayscale 的 mode 语义
 *
 * fabric 的 Grayscale 用 mode 字符串区分三种灰度公式，这里保留同名配置，
 * 只是把每种公式换成等价的矩阵。默认改取 luminosity（0.21/0.72/0.07）：
 * 平均法与 lightness 法在本项目的历史画面上一直显得偏暗、偏亮，亮度权重最接近
 * 「去掉颜色、保留明暗」的直觉。旧快照里若还带着 mode，反序列化时照常生效。
 *
 * 矩阵布局与 ColorMatrix 一致：下标 = 行 * 5 + 列，行序 R/G/B/A，
 * 第 0/1/2 行各自的 [列0..列2] 就是「输出 R / G / B 各吃多少原色」。
 */
const GRAYSCALE_WEIGHTS = {
  average: [1 / 3, 1 / 3, 1 / 3],
  lightness: [0.5, 0.5, 0.5],
  luminosity: [0.21, 0.72, 0.07],
};

/** 灰度公式名 → 等价的灰度矩阵 */
function grayscaleMatrix(mode) {
  const weights = GRAYSCALE_WEIGHTS[mode] || GRAYSCALE_WEIGHTS.luminosity;
  return [
    ...weights, 0, 0,
    ...weights, 0, 0,
    ...weights, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** 强度（0~1 之外一律钳制）→ 插值后的 4x5 矩阵 */
function mixMatrix(target, intensity) {
  const t = clamp(Number(intensity) || 0, 0, 1);
  return IDENTITY_MATRIX.map((base, i) => base + (target[i] - base) * t);
}

/** 滤镜实例上可被「按属性重建」的强度类参数 */
const INTENSITY_FILTER_TYPES = ['sepia', 'grayscale'];

/**
 * 让强度类滤镜的矩阵始终跟着强度与 mode 走
 * 实例属性直接被外部改写时（如 fabric 反序列化只 set 快照里的字段）也能自愈
 */
function syncIntensityMatrix(filter) {
  if (filter.type === 'Sepia') {
    filter.matrix = mixMatrix(SEPIA_MATRIX, filter.sepia);
  } else if (filter.type === 'Grayscale') {
    filter.matrix = mixMatrix(grayscaleMatrix(filter.mode), filter.grayscale);
  }
}

/**
 * 安装自定义滤镜到 fabric.Image.filters
 *
 * 两个强度滤镜都以 ColorMatrix 为基类：几何、着色器、2D 像素算法全部复用 fabric
 * 自己的实现，因此 WebGL 与 Canvas2D 两种后端表现一致，也不需要本模块手写任何
 * 逐像素算法。
 *
 *   Sepia      棕褐：单位矩阵 ↔ 标准棕褐矩阵按强度线性混合（type 沿用 'Sepia'）
 *   Grayscale  灰度：单位矩阵 ↔ 灰度矩阵按 mode 权重混合（type 沿用 'Grayscale'）
 *
 * type 刻意沿用 fabric 原生同名滤镜：fabric 的 enlivenObjects 按 json.type 取类
 * （见 BaseFilter.fromObject），旧工程 / 旧历史栈里的 { type: 'Sepia' } 能被新类
 * 原样读回；同时 BaseFilter.toObject 只输出 { type, [mainParameter] }，把
 * sepia / grayscale 设为 mainParameter 就能让强度进快照，不必改写序列化链路。
 *
 * 色温也用 ColorMatrix 类，但两者靠 type 区分，互不干扰。
 */
function installIntensityFilters() {
  const ns = (typeof fabric !== 'undefined' && fabric && fabric.Image) ? fabric.Image.filters : null;
  if (!ns) {
    return;
  }

  // 反色实现只依赖 fabric.Invert 那套管线，先单独处理：ColorMatrix 缺失时
  // 棕褐/灰度装不上，但反色仍要能装（否则底片预设的复制图层会整条链失败）
  installInvertAlias(ns);

  const BaseFilter = ns.BaseFilter;
  if (!ns.ColorMatrix || !BaseFilter || !fabric.util || typeof fabric.util.createClass !== 'function') {
    return;
  }

  /** 反序列化入口：fabric 按 json.type 从这里取构造器 */
  const attachFromObject = (Cls) => {
    Cls.fromObject = BaseFilter.fromObject;
    return Cls;
  };

  if (!ns.Sepia || ns.Sepia.__intensityImpl !== true) {
    const Sepia = fabric.util.createClass(ns.ColorMatrix, {
      type: 'Sepia',
      sepia: 0,
      mainParameter: 'sepia',
      colorsOnly: true,

      /**
       * @param {object} [options]
       * @param {number} [options.sepia] 棕褐强度 0 ~ 1
       */
      initialize(options = {}) {
        // fabric.createClass 会把 this.callSuper 指向父原型方法，
        // 这里务必写成常量方法名（this.callSuper('initialize', ...)）
        this.callSuper('initialize', options);
        syncIntensityMatrix(this);
      },

      /** 强度 0 等同未套滤镜；给出 delta 供 fabric 的缓存机制判断是否跳过 */
      isNeutralState(delta = 0) {
        return (Number(this.sepia) || 0) <= delta;
      }
    });
    Sepia.__intensityImpl = true;
    ns.Sepia = attachFromObject(Sepia);
  }

  if (!ns.Grayscale || ns.Grayscale.__intensityImpl !== true) {
    const Grayscale = fabric.util.createClass(ns.ColorMatrix, {
      type: 'Grayscale',
      grayscale: 0,
      mode: 'luminosity',
      mainParameter: 'grayscale',
      colorsOnly: true,

      /**
       * @param {object} [options]
       * @param {number} [options.grayscale] 灰度强度 0 ~ 1
       * @param {string} [options.mode] average | lightness | luminosity
       */
      initialize(options = {}) {
        this.callSuper('initialize', options);
        syncIntensityMatrix(this);
      },

      isNeutralState(delta = 0) {
        return (Number(this.grayscale) || 0) <= delta;
      }
    });
    Grayscale.__intensityImpl = true;
    ns.Grayscale = attachFromObject(Grayscale);
  }
}

/**
 * 反色：补一个类型固定的别名实现
 *
 * fabric 自带的 Invert 会把「关」编码成 type 'Invert'、把「开」编码成 type
 * 'InvertIntensity'（按主参数决定），而 getKlass('InvertIntensity') 找不到类会抛错——
 * 底片预设复制图层 / ORA 往返就此整条链失败。别名实现沿用同一套管线，toObject
 * 恒输出 'InvertIntensity'，往返稳定；旧的 'Invert' 类型仍由 fabric 自带类处理。
 *
 * @param {object} ns fabric.Image.filters 命名空间
 */
function installInvertAlias(ns) {
  if (!ns || (ns.InvertIntensity && ns.InvertIntensity.__intensityImpl === true)) {
    return;
  }
  if (!ns.Invert || !ns.BaseFilter || !fabric.util || typeof fabric.util.createClass !== 'function') {
    return;
  }

  const InvertIntensity = fabric.util.createClass(ns.Invert, {
    type: 'InvertIntensity',
    invert: true,

    initialize(options = {}) {
      this.callSuper('initialize', { ...options, invert: true });
    }
  });
  InvertIntensity.__intensityImpl = true;
  InvertIntensity.fromObject = ns.BaseFilter.fromObject;
  ns.InvertIntensity = InvertIntensity;
}

// 模块加载即安装（filters.js 只被真实运行时入口引用，此时 fabric 已就位），
// 下面每个入口再调一次，兼容桩件里「先读模块、后挂 fabric」的测试顺序。
installIntensityFilters();

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
  if (INTENSITY_FILTER_TYPES.includes(type)) {
    // 强度类：属性可能缺失（旧快照 / 旧版本写进去的多余字段），此时按矩阵反推，
    // 让「设过 55% 但快照没存」的历史状态也能显示出真实强度而不是 0
    return filterToUiValue(type, resolveIntensity(filter, type));
  }
  return filterToUiValue(type, filter[attr]);
}

/**
 * 强度类滤镜的强度：属性优先，缺失时从矩阵反推（与 toFilter 互逆）
 *
 * 注意「缺失」不能只看 Number(值) 是否有限：旧快照经过 fromObject 后，
 * 缺失的属性会落到原型上的同名默认值 0（fabric 的滤镜类把默认值写在原型上），
 * 那个 0 与「真的设过 0%」无法区分，但矩阵是可信的——矩阵非恒等就说明
 * 快照里带着强度（哪怕属性没写出来），此时按矩阵反推才不会把效果读丢。
 */
function resolveIntensity(filter, type) {
  const rawOwn = filter[FILTER_ATTR_NAME[type]];
  const matrix = Array.isArray(filter.matrix) ? filter.matrix : null;
  if (!matrix) {
    const numeric = Number(rawOwn);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  const fromMatrix = intensityFromMatrix(matrix, filter.mode, type);
  // 快照里没写强度（undefined / null）或写了个非数值：一律信矩阵
  if (rawOwn === null || rawOwn === undefined || !Number.isFinite(Number(rawOwn))) {
    return fromMatrix;
  }
  // 属性是 0 但矩阵不是恒等矩阵：说明属性不是这一遍写进去的（旧快照 / 只留矩阵的镜像），
  // 仍按矩阵还原，否则会读到 0 并误把仍在生效的滤镜剔除
  if (Number(rawOwn) === 0 && fromMatrix > 0) {
    return fromMatrix;
  }
  return Number(rawOwn);
}

/**
 * 由矩阵反推强度（0 ~ 1）
 * @param {number[]} matrix 4x5 矩阵
 * @param {string} [mode] 灰度公式名
 * @param {'sepia'|'grayscale'} type
 */
function intensityFromMatrix(matrix, mode, type) {
  if (type === 'sepia') {
    // 首行 = [1 - 0.607t, 0.769t, 0.189t]
    const base = IDENTITY_MATRIX[0];
    const target = SEPIA_MATRIX[0];
    const delta = target - base;
    if (Math.abs(delta) < 1e-9) {
      return 0;
    }
    return clamp((matrix[0] - base) / delta, 0, 1);
  }
  // 灰度每行 = identity 与 [wr·t, wg·t, wb·t] 的混合：GB 列在恒等矩阵里是 0，
  // 所以矩阵里的 GB 列除以对应权重就是 t（取两者中信号更大的那个）
  const weights = GRAYSCALE_WEIGHTS[mode] || GRAYSCALE_WEIGHTS.luminosity;
  const candidates = [matrix[1] / weights[1], matrix[2] / weights[2]]
    .filter(v => Number.isFinite(v));
  if (candidates.length === 0) {
    return 0;
  }
  return clamp(Math.max(...candidates), 0, 1);
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
  if (!image) {
    return;
  }

  installIntensityFilters();

  if (!Array.isArray(image.filters)) {
    image.filters = [];
  }

  const param = FILTER_PARAMS[type];
  if (!param) {
    return;
  }

  const FilterClass = getFilterClass(type);
  if (!FilterClass) {
    return;
  }

  // 移除同类型旧滤镜
  image.filters = image.filters.filter(f => !(f && f.type === param.cls));

  // 默认值不写入（避免无效滤镜堆积）
  if (uiValue === getDefaultUiValue(type)) {
    if (!skipApply) {
      applyFilters(image);
    }
    return;
  }

  const filterValue = uiToFilterValue(type, uiValue);
  const filter = new FilterClass({ [param.attr]: filterValue });
  if (INTENSITY_FILTER_TYPES.includes(type)) {
    // 显式回写强度后重建矩阵：构造器已按 options 插值过一次，这里再兜一次，
    // 防止将来有人给强度类滤镜加别的构造分支时矩阵与属性不同步
    filter[param.attr] = filterValue;
    syncIntensityMatrix(filter);
  }
  image.filters.push(filter);
  sortFilters(image);

  if (!skipApply) {
    applyFilters(image);
  }
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

/** 滤镜预设分类（顺序即 UI 显示顺序） */
export const FILTER_CATEGORIES = ['基础', '复古', '黑白'];

/**
 * 滤镜预设定义
 * 每个预设的 filters 字段为 { type: uiValue } 映射，未列出的类型重置为默认值
 * category 字段用于面板分组渲染
 */
export const FILTER_PRESETS = [
  // ── 基础 ──
  { preset: 'filter-original', label: '原图', category: '基础', filters: {} },
  { preset: 'filter-warm', label: '暖色', category: '基础', filters: { brightness: 6, saturation: 18, hue: -12, vibrance: 12 } },
  { preset: 'filter-cool', label: '冷色', category: '基础', filters: { brightness: 2, saturation: -8, hue: 14, vibrance: -6 } },
  { preset: 'filter-vivid', label: '鲜艳', category: '基础', filters: { saturation: 40, contrast: 14, brightness: 4, vibrance: 22 } },
  { preset: 'filter-soft', label: '柔光', category: '基础', filters: { brightness: 10, contrast: -16, blur: 6, gamma: 10 } },
  { preset: 'filter-sharp', label: '锐利', category: '基础', filters: { contrast: 26, saturation: 10, brightness: -2, vibrance: 8 } },
  { preset: 'filter-airy', label: '通透', category: '基础', filters: { brightness: 8, contrast: 6, gamma: 16, saturation: 6, vibrance: 18 } },
  { preset: 'filter-rich', label: '浓郁', category: '基础', filters: { contrast: 12, gamma: -14, saturation: 8, vibrance: 26 } },
  { preset: 'filter-faded', label: '褪色', category: '基础', filters: { brightness: 6, contrast: -14, gamma: 22, saturation: -14 } },
  // ── 复古 ──
  { preset: 'filter-vintage', label: '复古', category: '复古', filters: { brightness: 4, contrast: -8, saturation: -12, gamma: 14, sepia: 55 } },
  { preset: 'filter-sunset', label: '日落', category: '复古', filters: { brightness: 4, saturation: 22, hue: -14, vibrance: 14 } },
  { preset: 'filter-teal', label: '青调', category: '复古', filters: { contrast: 10, saturation: -12, hue: 16, vibrance: 8 } },
  { preset: 'filter-moody', label: '暗调', category: '复古', filters: { brightness: -10, contrast: 16, gamma: -12, saturation: -10 } },
  { preset: 'filter-haze', label: '柔雾', category: '复古', filters: { brightness: 8, contrast: -10, blur: 10, gamma: 14, saturation: -6 } },
  { preset: 'filter-clarendon', label: 'Clarendon', category: '复古', filters: { saturation: 28, contrast: 20, brightness: 4, vibrance: 12 } },
  { preset: 'filter-gingham', label: 'Gingham', category: '复古', filters: { brightness: 4, contrast: -10, saturation: -8, sepia: 18, gamma: 10 } },
  { preset: 'filter-valencia', label: 'Valencia', category: '复古', filters: { sepia: 22, contrast: 10, saturation: 12, brightness: 4, gamma: -8, noise: 8 } },
  { preset: 'filter-1977', label: '1977', category: '复古', filters: { sepia: 28, contrast: -6, brightness: 6, saturation: -10, gamma: 14, noise: 10 } },
  // ── 黑白 ──
  { preset: 'filter-bw', label: '黑白', category: '黑白', filters: { grayscale: 100, contrast: 8, gamma: -6 } },
  { preset: 'filter-ink', label: '高反差', category: '黑白', filters: { grayscale: 100, contrast: 26, gamma: -10 } },
  { preset: 'filter-inkwell', label: 'Inkwell', category: '黑白', filters: { grayscale: 100, contrast: 22, gamma: -6 } },
  { preset: 'filter-negative', label: '底片', category: '黑白', filters: { grayscale: 100, invert: 1 } },
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

  installIntensityFilters();

  // 重置全部为默认值，再应用预设覆盖
  // 批量设置时跳过逐次 applyFilters，循环结束后统一应用一次，避免重复重算
  ALL_FILTER_TYPES.forEach(type => {
    setFilter(image, type, getPresetParamValue(preset, type), true);
  });
  applyFilters(image);
  return true;
}

// 撤销/重做、复制图层、ORA 往返后重建图片对象时，fabric 从快照里取滤镜类构造实例。
// 入口在这里补一次安装，保证「先挂 fabric、后读模块」与「先读模块、后挂 fabric」
// 两种顺序下自定义滤镜都已就位（fabric 桩件可能读模块时还不存在）。
export { installIntensityFilters };

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

  installIntensityFilters();

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
