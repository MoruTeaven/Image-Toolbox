/**
 * AI_CONFIG — 外部 AI 服务商（OpenAI 兼容 Chat Completions）配置的唯一权威来源
 *
 * 模式约定
 * --------
 * 与 utils/filters.js 的 FILTER_PARAMS 同一纪律：服务商配置的全部字段、
 * 默认值、校验规则集中在本模块定义，「AI 配置」页（AccountPage）、推理
 * 出口（OpenAiCompatProvider）、能力注册表（AI_PROVIDERS）全部由此派生，
 * 不得在 UI 或 Provider 里二次维护字段清单。
 *
 * 存储分层（安全设计，勿随意合并）
 * --------------------------------
 * - API Key → **仅存本机**（DomPort 存储，即浏览器/渲染进程 localStorage）。
 *   uTools / ZTools 的宿主 dbStorage 会跟随宿主账号在设备间同步，Key 一旦
 *   进入该通道等于把凭据上传到宿主云端，因此这里刻意**不走** preferences.js
 *   的宿主存储层。Key 也绝不写日志、绝不出现在任何非用户指定 baseUrl 的请求里。
 * - baseUrl / 模型名 / 系统提示词 / 提示词草稿 → 宿主存储优先（可跟随宿主账号
 *   同步，属用户自己配置的偏好，不含凭据）。
 *
 * 网络出口
 * --------
 * 全部请求经 ports/AIPort.js 的 aiFetch（core 唯一的 AI 网络出口），
 * 本模块只负责组装 URL 与请求体。
 */

import { getPreference, setPreference } from '../utils/preferences.js';
import { getDomPort } from '../ports/DomPort.js';

/** 存储键（历史沿用，勿改，改了会丢用户已配置的值）。 */
const STORAGE_KEYS = {
  baseUrl: 'image-toolbox-ai-base-url',
  model: 'image-toolbox-ai-model',
  systemPrompt: 'image-toolbox-ai-system-prompt',
  draft: 'image-toolbox-ai-draft',
  // 仅本机：刻意不加 db 前缀，避免被宿主存储层（会同步）捡走
  apiKeyLocal: 'image-toolbox-ai-api-key'
};

/** 服务商预设：用户只需选地址并填 Key。 */
export const AI_SERVICE_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'custom', label: '自定义', baseUrl: '' }
];

/** 各字段的权威定义（UI 与校验都由此派生）。 */
export const AI_CONFIG_FIELDS = {
  baseUrl: {
    key: 'baseUrl',
    label: '服务地址',
    placeholder: 'https://api.openai.com/v1',
    multiline: false,
    maxlength: 277,
    required: true,
    storage: 'sync',
    description: 'OpenAI 兼容的 Chat Completions 根地址（会自动补 /chat/completions）。'
  },
  apiKey: {
    key: 'apiKey',
    label: 'API Key',
    placeholder: 'sk-…',
    multiline: false,
    maxlength: 277,
    required: false,
    storage: 'local',
    description: '仅保存在本机，不会跟随宿主账号同步，也不会发往你填写地址以外的任何服务器。'
  },
  model: {
    key: 'model',
    label: '模型',
    placeholder: 'gpt-4o-mini',
    multiline: false,
    maxlength: 77,
    required: true,
    storage: 'sync',
    description: '模型名按你所用服务商的写法填写。'
  },
  systemPrompt: {
    key: 'systemPrompt',
    label: '系统提示词',
    placeholder: '描述 AI 的角色与修图偏好（可留空用内置默认）',
    multiline: true,
    maxlength: 7777,
    required: false,
    storage: 'sync',
    description: '每次请求都会带上的固定人设。留空则使用内置的修图指令人设。'
  },
  draft: {
    key: 'draft',
    label: '提示词草稿',
    placeholder: '',
    multiline: true,
    maxlength: 7777,
    required: false,
    storage: 'sync',
    description: '右侧栏的提示词会自动存草稿，重启后仍在。'
  }
};

/** 采样与尺寸上限（默认值取用户偏好的 7/77 系列）。 */
export const AI_CONFIG_LIMITS = {
  temperature: { min: 0, max: 2, step: 0.1, default: 0.7 },
  maxTokens: { min: 128, max: 7777, step: 128, default: 777 },
  maxInputEdge: 4096,
  previewMaxEdge: 777,
  previewQuality: 0.77,
  timeoutMs: 77000
};

/**
 * 内置默认系统提示词（系统提示词留空时使用）。
 * 输出契约与 ai/AI_INSTRUCTION.js 的解析器一一对应，改这里必须同步改解析器。
 */
export const DEFAULT_AI_SYSTEM_PROMPT = [
  '你是图片工具箱的 AI 修图指令引擎。用户会给出对一张图片的修图要求，',
  '你只输出一个 JSON 对象，不要输出 Markdown、代码围栏或任何解释文字。',
  'JSON 结构：{"actions":[{"type":"...","参数...":...}],"notes":"一句话说明"}',
  '允许的 actions（数值一律用 UI 量程）：',
  '- {"type":"filter","key":"brightness|contrast|saturation|vibrance|hue|temperature|gamma|blur","value":数值}',
  '  量程：brightness/contrast/saturation -100~100；vibrance/gamma/temperature -77~77；hue -180~180；blur 0~100',
  '- {"type":"preset","name":"滤镜预设名"}',
  '- {"type":"background","mode":"transparent|white"}（抠图去背景）',
  '- {"type":"rotate","angle":0|90|180|270} · {"type":"flip","axis":"x|y"}',
  '- {"type":"opacity","value":0~100}',
  '不确定或超出上述能力时，返回 {"actions":[],"notes":"说明为什么做不到"}。'
].join('');

const _readSync = (storageKey) => getPreference(storageKey);
const _writeSync = (storageKey, value) => setPreference(storageKey, value);

const _readLocal = (storageKey) => {
  try {
    const storage = getDomPort()?.getStorage?.();
    const value = storage?.getItem?.(storageKey);
    return value === null || value === undefined ? null : String(value);
  } catch (e) {
    console.warn('[AI_CONFIG] 本机存储读取失败:', e);
    return null;
  }
};

const _writeLocal = (storageKey, value) => {
  try {
    const storage = getDomPort()?.getStorage?.();
    if (!storage?.setItem) {
      return false;
    }
    storage.setItem(storageKey, String(value));
    return true;
  } catch (e) {
    // 隐私模式 / 配额满：Key 不持久只影响本次会话，不升级为错误
    console.warn('[AI_CONFIG] 本机存储写入失败:', e);
    return false;
  }
};

const _storageKeyOf = (fieldKey) => STORAGE_KEYS[fieldKey === 'apiKey' ? 'apiKeyLocal' : fieldKey];

/**
 * 读取全部 AI 配置。
 * @returns {{ baseUrl:string, apiKey:string, model:string, systemPrompt:string, draft:string }}
 */
export function getAiConfig() {
  const out = {};
  Object.values(AI_CONFIG_FIELDS).forEach((field) => {
    const storageKey = _storageKeyOf(field.key);
    const raw = field.storage === 'local' ? _readLocal(storageKey) : _readSync(storageKey);
    out[field.key] = raw === null ? '' : raw;
  });
  return out;
}

/**
 * 写入一个字段（按字段的存储分层自动路由）。
 * @param {string} fieldKey AI_CONFIG_FIELDS 的键
 * @param {string} value
 * @returns {boolean} 是否成功持久化
 */
export function setAiConfigField(fieldKey, value) {
  const field = AI_CONFIG_FIELDS[fieldKey];
  if (!field) {
    console.warn(`[AI_CONFIG] 未知配置字段: ${fieldKey}`);
    return false;
  }
  const text = value === null || value === undefined ? '' : String(value);
  const storageKey = _storageKeyOf(fieldKey);
  return field.storage === 'local' ? _writeLocal(storageKey, text) : _writeSync(storageKey, text);
}

/**
 * 规范化服务商根地址：去空格、去尾部斜杠，缺 scheme 时补 https://。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeAiBaseUrl(baseUrl) {
  let text = String(baseUrl || '').trim();
  if (!text) {
    return '';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  return text.replace(/\/+$/, '');
}

/**
 * Chat Completions 端点：根地址已带 /chat/completions 则原样，否则补上。
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveChatCompletionsUrl(baseUrl) {
  const root = normalizeAiBaseUrl(baseUrl);
  if (!root) {
    return '';
  }
  return /\/chat\/completions$/i.test(root) ? root : `${root}/chat/completions`;
}

/**
 * 配置完整性与合法性校验（保存前与执行前共用）。
 * @param {object} [config] 缺省自动读取
 * @returns {ok:boolean, errors:Record<string,string>}
 */
export function validateAiConfig(config = getAiConfig()) {
  const errors = {};
  const root = normalizeAiBaseUrl(config.baseUrl);
  if (!root) {
    errors.baseUrl = '请填写服务地址';
  } else if (!/^https:\/\//i.test(root)) {
    // 只允许 https：Key 与图片数据不得走明文通道
    errors.baseUrl = '服务地址必须使用 https';
  }
  if (!String(config.model || '').trim()) {
    errors.model = '请填写模型名';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * 服务商是否已配置到可用程度（不要求填 Key：自建网关可能免鉴权）。
 * @param {object} [config]
 * @returns {boolean}
 */
export function isAiConfigReady(config = getAiConfig()) {
  return validateAiConfig(config).ok;
}

/**
 * 命中预设时返回预设 id，供 UI 高亮。
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function matchPresetId(baseUrl) {
  const root = normalizeAiBaseUrl(baseUrl);
  if (!root) {
    return null;
  }
  const hit = AI_SERVICE_PRESETS.find((preset) => preset.baseUrl && normalizeAiBaseUrl(preset.baseUrl) === root);
  return hit ? hit.id : null;
}

/**
 * 把 Key 打码用于界面展示（只留前后各 2 位）。
 * @param {string} apiKey
 * @returns {string}
 */
export function maskApiKey(apiKey) {
  const text = String(apiKey || '');
  if (!text) {
    return '';
  }
  if (text.length <= 7) {
    return '••••';
  }
  return `${text.slice(0, 2)}${'•'.repeat(7)}${text.slice(-2)}`;
}
