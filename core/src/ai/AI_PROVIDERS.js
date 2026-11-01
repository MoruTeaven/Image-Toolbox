/**
 * AI_PROVIDERS — AI 能力注册表（唯一权威来源）
 *
 * 与调色参数表（utils/filters.js 的 FILTER_PARAMS）同一纪律：
 * AI 能力的全部元信息集中在本表定义，AIModule 的 UI、执行路由、能力探测
 * 全部由表派生。新增一种 AI 能力 = 在表里加一条，不得在模块/面板里
 * 二次维护能力清单。
 *
 * 字段约定：
 *   id          能力标识（也是 EventBus 事件与执行路由的 key）
 *   label       工具面板里的展示名（用户可见文案）
 *   provider    执行该能力的 Provider id（见 AI_PROVIDER_IDS）
 *   entry       面板形态：'action' 一键执行按钮；'prompt' 提示词工程输入区
 *   model       模型标识（local-onnx 为 rmbg-webgpu 预设键；openai-compat 取用户配置）
 *   description 一句话说明（面板提示文案）
 *   minSelection 是否要求先选中一个图片图层
 *   inPanel     是否在属性面板展示（缺省 true）。false = 能力保留、仍可被
 *               模型指令/内部调用触发，只是不再占用面板空间。阶段内收敛
 *               入口时用它，而不是删能力——删了会连带丢模型资产与路由。
 */

export const AI_PROVIDER_IDS = {
  LOCAL_ONNX: 'local-onnx',
  OPENAI_COMPAT: 'openai-compat'
};

export const AI_CAPABILITIES = {
  removeBackground: {
    id: 'removeBackground',
    label: '一键抠图',
    provider: AI_PROVIDER_IDS.LOCAL_ONNX,
    entry: 'action',
    model: 'u2netp',
    description: '识别选中图层中的主体并抠除背景，结果生成为新图层。',
    minSelection: true,
    // 现阶段面板只收修图入口；抠图能力保留（指令里的「去背景」仍可触发），
    // 只是不再单独占一块面板。要恢复面板入口把这里改回 true。
    inPanel: false
  },
  promptEdit: {
    id: 'promptEdit',
    label: 'AI 指令编辑',
    provider: AI_PROVIDER_IDS.OPENAI_COMPAT,
    entry: 'prompt',
    model: 'user-configured',
    description: '用一句话描述想要的效果，AI 返回编辑指令并应用到当前图层。',
    minSelection: true,
    inPanel: true
  }
};

/**
 * 按能力 id 取定义；未知 id 返回 null（调用方自行兜底）。
 * @param {string} id
 * @returns {object|null}
 */
export function getAiCapability(id) {
  return Object.prototype.hasOwnProperty.call(AI_CAPABILITIES, id) ? AI_CAPABILITIES[id] : null;
}

/** 全部能力定义（UI 派生用，键序即展示序）。 */
export function listAiCapabilities() {
  return Object.values(AI_CAPABILITIES);
}

/**
 * AI_PROMPT_PRESETS — 预设提示词表（唯一权威来源）
 *
 * 顶部预设栏与右侧栏快捷 chips 全部由本表派生，新增一条预设 = 在表里
 * 加一项，不得在 AIModule/OptionsBar 里二次维护提示词清单。
 *
 * 字段约定：
 *   id     预设标识（data-preset 路由用）
 *   label  按钮短文案
 *   prompt 填入提示词框的完整文案（须与 AI_INSTRUCTION 的白名单能力匹配，
 *          否则模型会返回「无可执行指令」）
 */
export const AI_PROMPT_PRESETS = [
  { id: 'brighten', label: '提亮', prompt: '把画面整体提亮，保持自然肤色' },
  { id: 'cool', label: '冷色', prompt: '整体偏冷色调，降低色温' },
  { id: 'warm', label: '暖色', prompt: '整体偏暖，提升色温与饱和度' },
  { id: 'vivid', label: '鲜艳', prompt: '提高饱和度与对比度，色彩更鲜艳' },
  { id: 'soft', label: '柔雾', prompt: '加一点柔光雾感，降低对比度' },
  { id: 'mono', label: '黑白', prompt: '转换为黑白风格，保留层次感' },
  { id: 'cutout', label: '去背景', prompt: '抠除背景，输出透明底' }
];

/** 按预设 id 取定义；未知 id 返回 null。 */
export function getAiPromptPreset(id) {
  return AI_PROMPT_PRESETS.find((preset) => preset.id === id) || null;
}
