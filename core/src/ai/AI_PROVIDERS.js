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
 *   model       LocalOnnxProvider 的模型预设键（rmbg-webgpu 的 MODEL_PRESETS）
 *   description 一句话说明（面板提示文案）
 *   minSelection 是否要求先选中一个图片图层
 */

export const AI_PROVIDER_IDS = {
  LOCAL_ONNX: 'local-onnx'
};

export const AI_CAPABILITIES = {
  removeBackground: {
    id: 'removeBackground',
    label: '一键抠图',
    provider: AI_PROVIDER_IDS.LOCAL_ONNX,
    model: 'u2netp',
    description: '识别选中图层中的主体并抠除背景，结果生成为新图层。',
    minSelection: true
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
