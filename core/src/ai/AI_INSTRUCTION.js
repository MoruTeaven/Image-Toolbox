/**
 * AI_INSTRUCTION — AI 修图指令的解析与校验（纯函数，无环境依赖）
 *
 * 为什么是指令 JSON 而不是让模型直接返回图片
 * ------------------------------------------
 * 模型输出「白名单 JSON」，由客户端既有的调色 / 图层能力执行，好处是：
 *   1. 任意 OpenAI 兼容服务商都能用（不需要模型支持图片输出）；
 *   2. 结果走既有工具链，撤销/重做、图层面板、导出天然可用；
 *   3. 攻击面收敛：模型无法注入任意代码或属性，只能填白名单里的数。
 *
 * 输出契约与 ai/AI_CONFIG.js 的 buildAiSystemPrompt() 一一对应，
 * 二者必须同步修改（改 prompt 不改解析器 = 能力静默失效）。
 */

import { AI_STAGE } from './AI_PROVIDERS.js';
import { FILTER_PARAMS } from '../utils/filters.js';

/** 允许 AI 写入的调色参数白名单：直接取自 FILTER_PARAMS 的 inUi 项。 */
const FILTERABLE_KEYS = Object.keys(FILTER_PARAMS).filter((key) => FILTER_PARAMS[key].inUi);

/** 允许的 action 类型。 */
export const AI_ACTION_TYPES = ['filter', 'preset', 'background', 'rotate', 'flip', 'opacity'];

/** 旋转允许的角度（避免模型给出无意义的小数角）。 */
const ALLOWED_ROTATE_ANGLES = [0, 90, 180, 270, -90, -180, -270];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const toNumber = (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/**
 * 从模型回复文本里提取 JSON 对象。
 * 容忍 ```json 围栏与前后解释文字：取第一个能解析成功的 { … } 片段。
 * @param {string} text
 * @returns {object|null}
 */
export function extractInstructionJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  const candidates = [];
  // 1) 整体
  candidates.push(raw);
  // 2) 代码围栏内容
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    candidates.push(fence[1].trim());
  }
  // 3) 首个 { 到末个 }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/**
 * 规范化单个 action：不在白名单 / 参数越界的丢弃或钳制。
 * @param {object} action
 * @returns {{ ok:boolean, action?:object, reason?:string }}
 */
export function normalizeAction(action) {
  if (!action || typeof action !== 'object') {
    return { ok: false, reason: '指令项不是对象' };
  }
  const type = String(action.type || '').trim();
  if (!AI_ACTION_TYPES.includes(type)) {
    return { ok: false, reason: `不支持的指令类型: ${type || '(空)'}` };
  }

  if (type === 'filter') {
    const key = String(action.key || '').trim();
    if (!FILTERABLE_KEYS.includes(key)) {
      return { ok: false, reason: `不在调色白名单: ${key || '(空)'}` };
    }
    const spec = FILTER_PARAMS[key];
    const value = toNumber(action.value);
    if (value === null) {
      return { ok: false, reason: `${key} 缺少数值` };
    }
    return { ok: true, action: { type, key, value: clamp(value, spec.min, spec.max) } };
  }

  if (type === 'preset') {
    const name = String(action.name || '').trim();
    if (!name) {
      return { ok: false, reason: 'preset 缺少名称' };
    }
    return { ok: true, action: { type, name } };
  }

  if (type === 'background') {
    // 3.0 未上线抠图（AI_STAGE.background === false）：模型即使返回该动作
    // 也一律拒绝，避免「用户可见面没入口、却能通过提示词触发」的半上线状态。
    if (!AI_STAGE.background) {
      return { ok: false, reason: '去背景能力暂未开放' };
    }
    const mode = String(action.mode || '').trim();
    if (mode !== 'transparent' && mode !== 'white') {
      return { ok: false, reason: `background.mode 只支持 transparent/white: ${mode || '(空)'}` };
    }
    return { ok: true, action: { type, mode } };
  }

  if (type === 'rotate') {
    const angle = toNumber(action.angle);
    if (angle === null || !ALLOWED_ROTATE_ANGLES.includes(angle)) {
      return { ok: false, reason: 'rotate.angle 只支持 0/90/180/270' };
    }
    return { ok: true, action: { type, angle: (angle + 360) % 360 } };
  }

  if (type === 'flip') {
    const axis = String(action.axis || '').trim().toLowerCase();
    if (axis !== 'x' && axis !== 'y') {
      return { ok: false, reason: 'flip.axis 只支持 x/y' };
    }
    return { ok: true, action: { type, axis } };
  }

  // opacity
  const value = toNumber(action.value);
  if (value === null) {
    return { ok: false, reason: 'opacity 缺少数值' };
  }
  return { ok: true, action: { type, value: clamp(value, 0, 100) } };
}

/**
 * 把模型回复解析为可执行指令集。
 * @param {string} text 模型回复原文
 * @returns {actions:object[], notes:string, rejected:Array<{type:string,reason:string}>}
 * @throws {Error} 回复里解析不出 JSON 时抛出（调用方转用户提示）
 */
export function parseInstruction(text) {
  const parsed = extractInstructionJson(text);
  if (!parsed) {
    const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 77);
    throw new Error(`AI 回复无法解析为指令${snippet ? `：${snippet}…` : ''}`);
  }
  const list = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions = [];
  const rejected = [];
  list.forEach((item) => {
    const result = normalizeAction(item);
    if (result.ok) {
      actions.push(result.action);
    } else {
      rejected.push({ type: String(item?.type || ''), reason: result.reason });
    }
  });
  return {
    actions,
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
    rejected
  };
}

/**
 * 指令摘要（一句中文，用于确认提示与状态栏）。
 * @param {object[]} actions
 * @returns {string}
 */
export function describeActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return '无可执行调整';
  }
  return actions.map((action) => {
    if (action.type === 'filter') {
      return `${FILTER_PARAMS[action.key].label} → ${action.value}`;
    }
    if (action.type === 'preset') {
      return `预设「${action.name}」`;
    }
    if (action.type === 'background') {
      return action.mode === 'white' ? '抠图为白底' : '抠图为透明底';
    }
    if (action.type === 'rotate') {
      return `旋转 ${action.angle}°`;
    }
    if (action.type === 'flip') {
      return action.axis === 'x' ? '水平翻转' : '垂直翻转';
    }
    if (action.type === 'opacity') {
      return `不透明度 ${action.value}%`;
    }
    return action.type;
  }).join('；');
}

/**
 * 把已规范化的 filter 指令写进 fabric 图像对象。
 * 走 utils/filters.js 的 setFilter（唯一的调色写入点），顺序与量程
 * 由 FILTER_PARAMS 保证，不在此处二次维护。
 * @param {object} image fabric.Image
 * @param {object[]} actions
 * @param {object} helpers { setFilter, applyFilterPreset, requestRender }
 * @returns {number} 实际生效的指令条数
 */
export function applyActionsToImage(image, actions, helpers) {
  if (!image || !Array.isArray(actions)) {
    return 0;
  }
  let applied = 0;
  actions.forEach((action) => {
    if (action.type === 'filter') {
      helpers.setFilter(image, action.key, action.value);
      applied += 1;
    } else if (action.type === 'preset') {
      const preset = helpers.findPreset(action.name);
      if (preset) {
        helpers.applyFilterPreset(image, preset.preset);
        applied += 1;
      }
    } else if (action.type === 'rotate') {
      image.rotate(action.angle);
      applied += 1;
    } else if (action.type === 'flip') {
      if (action.axis === 'x') {
        image.set({ flipX: !image.flipX });
      } else {
        image.set({ flipY: !image.flipY });
      }
      applied += 1;
    } else if (action.type === 'opacity') {
      image.set({ opacity: action.value / 100 });
      applied += 1;
    }
    // background 由调用方单独处理（需要走推理链，不在此同步应用）
  });
  if (applied > 0) {
    image.setCoords?.();
    helpers.requestRender?.();
  }
  return applied;
}
