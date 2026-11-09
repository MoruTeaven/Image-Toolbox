/**
 * 历史快照差异 — 把两个 Fabric.js 画布快照之间的变化翻译成用户可读的参数变更。
 *
 * 纯函数，无环境依赖，由 HistoryManager.saveState 在入栈时调用一次，
 * 结果缓存在时间线条目里（历史面板展开时直接读，不重复计算）。
 *
 * 设计取舍：
 *   - 只比较白名单里的「用户能感知」的属性，不比较 src / selectable / evented 等
 *     序列化细节，避免把内部字段当成参数变更展示；
 *   - 图片对象的 src 可能是 MB 级 base64，任何地方都不对它做字符串比较；
 *   - 滤镜的 UI 值复用 FILTER_PARAMS（唯一权威来源）换算，不在本文件另维护一份量程。
 */

import { FILTER_PARAMS } from './filters.js';

/** 单个对象最多展示的变更条数，超出折叠为「还有 N 项」 */
const MAX_PROP_CHANGES = 12;
/** 整体最多展示的条目数 */
const MAX_TOTAL_ITEMS = 40;

const LAYER_TYPE_LABELS = {
  'i-text': '文字',
  text: '文字',
  textbox: '文字',
  rect: '矩形',
  circle: '圆形',
  ellipse: '椭圆',
  triangle: '三角形',
  polygon: '多边形',
  line: '线条',
  path: '画笔',
  group: '编组',
  image: '图片',
  activeSelection: '选择组',
};

const BLEND_MODE_LABELS = {
  'source-over': '正常',
  multiply: '正片叠底',
  screen: '滤色',
  overlay: '叠加',
  darken: '变暗',
  lighten: '变亮',
  'color-dodge': '颜色减淡',
  'color-burn': '颜色加深',
  'hard-light': '强光',
  'soft-light': '柔光',
  difference: '差值',
  exclusion: '排除',
  hue: '色相',
  saturation: '饱和度',
  color: '颜色',
  luminosity: '明度',
};

const MOSAIC_MODE_LABELS = {
  mosaic: '马赛克',
  blur: '模糊',
};

const MOSAIC_MASK_LABELS = {
  rect: '矩形',
  brush: '涂抹',
  lasso: '套索',
  polygon: '多边形',
};

/** 常规数值属性（left/top/scale 已单独合并，不在此列） */
const NUMBER_PROPS = [
  ['angle', '旋转'],
  ['opacity', '不透明度'],
  ['width', '宽度'],
  ['height', '高度'],
  ['fontSize', '字号'],
  ['strokeWidth', '描边宽度'],
  ['charSpacing', '字距'],
  ['lineHeight', '行高'],
];

/** 布尔属性 */
const BOOLEAN_PROPS = [
  ['visible', '可见'],
  ['linethrough', '删除线'],
  ['underline', '下划线'],
  ['flipX', '水平翻转'],
  ['flipY', '垂直翻转'],
];

/** 文本 / 颜色类属性（_layerName 属图层元数据，恢复后会被自动命名重写，不参与对比） */
const TEXT_PROPS = [
  ['fill', '颜色'],
  ['stroke', '描边颜色'],
  ['text', '文字'],
  ['fontFamily', '字体'],
  ['fontWeight', '字重'],
  ['fontStyle', '字形'],
  ['textAlign', '对齐'],
];

/** 打码参数 */
const MOSAIC_PROPS = [
  ['_mosaicMode', '打码模式'],
  ['_mosaicSize', '马赛克大小'],
  ['_mosaicBlurRadius', '模糊半径'],
  ['_mosaicMaskType', '打码形状'],
  ['_mosaicWidth', '打码宽度'],
  ['_mosaicHeight', '打码高度'],
];

/** 滤镜类型 → { label, attr, toUi }；以 FILTER_PARAMS 为唯一权威来源 */
const FILTER_META = new Map(
  Object.values(FILTER_PARAMS).map((param) => [
    param.cls,
    { label: param.label, attr: param.attr, toUi: param.toUi },
  ])
);

/**
 * 对比两个画布快照。
 * @param {object|null} prevJson 前一条快照（首条记录时为 null）
 * @param {object} nextJson 本条快照
 * @returns {{items: Array<{kind:string, layer:string, changes:Array<{label:string, from:string, to:string}>}>}}
 */
export function diffSnapshots(prevJson, nextJson) {
  if (!nextJson) return { items: [] };

  const prevObjects = Array.isArray(prevJson?.objects) ? prevJson.objects : [];
  const nextObjects = Array.isArray(nextJson.objects) ? nextJson.objects : [];
  const prevMap = indexObjects(prevObjects);
  const nextMap = indexObjects(nextObjects);

  const items = [];

  // 删除的图层
  for (const [key, prev] of prevMap) {
    if (!nextMap.has(key)) {
      items.push({ kind: 'remove', layer: describeLayer(prev.obj), changes: [] });
    }
  }

  // 新增 / 修改的图层
  for (const [key, next] of nextMap) {
    const prev = prevMap.get(key);
    if (!prev) {
      items.push({ kind: 'add', layer: describeLayer(next.obj), changes: [] });
      continue;
    }

    const changes = diffObject(prev.obj, next.obj);
    if (changes.length > 0) {
      items.push({ kind: 'modify', layer: describeLayer(next.obj), changes });
    }
  }

  // 图层顺序变化（只有在对象集合完全一致时才判定，避免把增删误报成排序）
  if (isReorderOnly(prevObjects, nextObjects, prevMap, nextMap)) {
    items.push({ kind: 'reorder', layer: '图层顺序', changes: [] });
  }

  // 画布级属性
  const canvasChanges = diffCanvas(prevJson, nextJson);
  if (canvasChanges.length > 0) {
    items.unshift({ kind: 'canvas', layer: '画布', changes: canvasChanges });
  }

  if (items.length > MAX_TOTAL_ITEMS) {
    const hidden = items.length - MAX_TOTAL_ITEMS;
    return {
      items: [
        ...items.slice(0, MAX_TOTAL_ITEMS),
        { kind: 'more', layer: `还有 ${hidden} 项变更`, changes: [] },
      ],
    };
  }

  return { items };
}

// ── 内部实现 ──

function indexObjects(objects) {
  const map = new Map();
  objects.forEach((obj, index) => {
    if (!obj || typeof obj !== 'object') return;
    const key = objectKey(obj, index);
    if (!map.has(key)) map.set(key, { obj, index });
  });
  return map;
}

function objectKey(obj, index) {
  if (obj.id) return `id:${obj.id}`;
  if (obj._layerName) return `name:${obj._layerName}`;
  if (obj._originalImage) return 'original-image';
  return `type:${obj.type}:${index}`;
}

function describeLayer(obj) {
  if (obj._layerName) return obj._layerName;
  if (obj._originalImage) return '背景图';
  return LAYER_TYPE_LABELS[obj.type] || '图层';
}

function isReorderOnly(prevObjects, nextObjects, prevMap, nextMap) {
  if (prevObjects.length !== nextObjects.length) return false;
  if (prevObjects.length < 2) return false;
  for (const key of prevMap.keys()) {
    if (!nextMap.has(key)) return false;
  }
  const prevKeys = prevObjects.map((obj, i) => objectKey(obj, i));
  const nextKeys = nextObjects.map((obj, i) => objectKey(obj, i));
  return prevKeys.some((key, i) => key !== nextKeys[i]);
}

function diffCanvas(prevJson, nextJson) {
  const changes = [];
  const prev = prevJson || {};

  if (!sameValue(prev.backgroundColor, nextJson.backgroundColor)) {
    changes.push({
      label: '背景色',
      from: formatValue(prev.backgroundColor),
      to: formatValue(nextJson.backgroundColor),
    });
  }

  const hadClip = !!prev.clipPath;
  const hasClip = !!nextJson.clipPath;
  if (hadClip !== hasClip) {
    changes.push({
      label: '画布裁剪',
      from: hadClip ? '已应用' : '无',
      to: hasClip ? '已应用' : '无',
    });
  }

  return changes;
}

function diffObject(prev, next) {
  const changes = [];
  const push = (label, from, to) => {
    if (changes.length >= MAX_PROP_CHANGES) return;
    changes.push({ label, from: formatValue(from), to: formatValue(to) });
  };

  // 位置与缩放合并成一条，避免 left/top/scaleX/scaleY 刷屏
  if (!sameValue(prev.left, next.left) || !sameValue(prev.top, next.top)) {
    changes.push({
      label: '位置',
      from: formatPair(prev.left, prev.top),
      to: formatPair(next.left, next.top),
    });
  }

  if (!sameValue(prev.scaleX, next.scaleX) || !sameValue(prev.scaleY, next.scaleY)) {
    changes.push({
      label: '缩放',
      from: formatPair(prev.scaleX ?? 1, prev.scaleY ?? 1),
      to: formatPair(next.scaleX ?? 1, next.scaleY ?? 1),
    });
  }

  for (const [prop, label] of NUMBER_PROPS) {
    if (!sameValue(prev[prop], next[prop])) push(label, prev[prop], next[prop]);
  }

  for (const [prop, label] of BOOLEAN_PROPS) {
    if (!sameValue(prev[prop], next[prop])) push(label, prev[prop], next[prop]);
  }

  for (const [prop, label] of TEXT_PROPS) {
    if (!sameValue(prev[prop], next[prop])) push(label, prev[prop], next[prop]);
  }

  for (const [prop, label] of MOSAIC_PROPS) {
    if (!sameValue(prev[prop], next[prop])) push(label, mosaicLabel(prop, prev[prop]), mosaicLabel(prop, next[prop]));
  }

  if (!sameValue(prev.globalCompositeOperation, next.globalCompositeOperation)) {
    const prevMode = prev.globalCompositeOperation || 'source-over';
    const nextMode = next.globalCompositeOperation || 'source-over';
    push('混合模式', BLEND_MODE_LABELS[prevMode] || prevMode, BLEND_MODE_LABELS[nextMode] || nextMode);
  }

  // 对象级裁剪（例如对某个图层套用裁剪）
  const hadClip = !!prev.clipPath;
  const hasClip = !!next.clipPath;
  if (hadClip !== hasClip) {
    push('对象裁剪', hadClip ? '已应用' : '无', hasClip ? '已应用' : '无');
  }

  for (const change of diffFilters(prev.filters, next.filters)) {
    if (changes.length >= MAX_PROP_CHANGES) break;
    changes.push(change);
  }

  return changes;
}

function mosaicLabel(prop, value) {
  if (prop === '_mosaicMode') return MOSAIC_MODE_LABELS[value] || value;
  if (prop === '_mosaicMaskType') return MOSAIC_MASK_LABELS[value] || value;
  return value;
}

function diffFilters(prevFilters, nextFilters) {
  const prevList = Array.isArray(prevFilters) ? prevFilters : [];
  const nextList = Array.isArray(nextFilters) ? nextFilters : [];
  if (prevList.length === 0 && nextList.length === 0) return [];

  const prevByType = new Map(prevList.map((filter) => [filter?.type, filter]));
  const nextByType = new Map(nextList.map((filter) => [filter?.type, filter]));
  const types = new Set([...prevByType.keys(), ...nextByType.keys()]);

  const changes = [];
  for (const type of types) {
    const prev = prevByType.get(type);
    const next = nextByType.get(type);
    const meta = FILTER_META.get(type);
    const label = meta?.label ? `${meta.label}滤镜` : `滤镜 ${type}`;

    if (prev && !next) {
      changes.push({ label, from: '开启', to: '关闭' });
      continue;
    }
    if (!prev && next) {
      changes.push({ label, from: '关闭', to: '开启' });
      continue;
    }
    if (!prev || !next) continue;

    const attr = meta?.attr;
    if (attr && Object.prototype.hasOwnProperty.call(next, attr)) {
      if (sameValue(prev[attr], next[attr])) continue;
      const from = meta.toUi ? meta.toUi(prev[attr]) : formatValue(prev[attr]);
      const to = meta.toUi ? meta.toUi(next[attr]) : formatValue(next[attr]);
      changes.push({ label: meta.label, from: formatValue(from), to: formatValue(to) });
      continue;
    }

    if (!sameValue(prev, next)) {
      changes.push({ label, from: '旧值', to: '新值' });
    }
  }

  return changes;
}

function formatPair(a, b) {
  return `(${formatValue(a)}, ${formatValue(b)})`;
}

function formatValue(value) {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return String(Math.round(value * 10) / 10);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') {
    return value.length > 28 ? `${value.slice(0, 28)}…` : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 8) return `[${value.length} 项]`;
    return value.map(formatValue).join(', ');
  }
  if (typeof value === 'object') return '[对象]';
  return String(value);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }

  // 常规对象：浅层 JSON 比较即可（这里只会传入滤镜对象等小结构）
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (err) {
    return false;
  }
}
