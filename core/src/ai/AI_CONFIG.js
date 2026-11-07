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
import { AI_STAGE } from './AI_PROVIDERS.js';

/** 存储键（历史沿用，勿改，改了会丢用户已配置的值）。 */
const STORAGE_KEYS = {
  // 旧版单套配置（仅用于迁移，写入路径已废弃）
  baseUrl: 'image-toolbox-ai-base-url',
  model: 'image-toolbox-ai-model',
  systemPrompt: 'image-toolbox-ai-system-prompt',
  draft: 'image-toolbox-ai-draft',
  // 仅本机：刻意不加 db 前缀，避免被宿主存储层（会同步）捡走
  apiKeyLocal: 'image-toolbox-ai-api-key',
  // 新版两级配置：提供商（不含 Key）+ 当前选中项
  providers: 'image-toolbox-ai-providers',
  activeProvider: 'image-toolbox-ai-active-provider',
  activeModel: 'image-toolbox-ai-active-model'
};

/** 每个提供商的 Key 单独存本机：image-toolbox-ai-key-<providerId>。 */
const PROVIDER_KEY_PREFIX = 'image-toolbox-ai-key-';

/** 服务商预设：用户只需选地址并填 Key。 */
export const AI_SERVICE_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'custom', label: '自定义', baseUrl: '' }
];

/**
 * 各字段的权威定义（UI 与校验都由此派生）。
 *
 * 注意：baseUrl / apiKey / model 三个字段属于旧版单套配置，现在由
 * 「提供商 + 模型」两级结构取代（见 listProviders 一节），这里保留定义
 * 仅用于旧配置迁移；新 UI 不再渲染这三个字段。
 */
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
 *
 * 为什么是函数而不是常量：可执行动作清单随上线阶段变化（AI_STAGE）。
 * 未上线的能力不能写进提示词——否则模型会主动建议用户「去背景」，
 * 而该动作会在白名单处被拒绝，体验上是「AI 说能做、点下去做不到」。
 *
 * @returns {string}
 */
export function buildAiSystemPrompt() {
  const lines = [
    '你是图片工具箱的 AI 修图指令引擎。用户会给出对一张图片的修图要求，',
    '你只输出一个 JSON 对象，不要输出 Markdown、代码围栏或任何解释文字。',
    'JSON 结构：{"actions":[{"type":"...","参数...":...}],"notes":"一句话说明"}',
    '允许的 actions（数值一律用 UI 量程）：',
    '- {"type":"filter","key":"brightness|contrast|saturation|vibrance|hue|temperature|gamma|blur","value":数值}',
    '  量程：brightness/contrast/saturation -100~100；vibrance/gamma/temperature -77~77；hue -180~180；blur 0~100',
    '- {"type":"preset","name":"滤镜预设名"}',
    '- {"type":"rotate","angle":0|90|180|270} · {"type":"flip","axis":"x|y"}',
    '- {"type":"opacity","value":0~100}'
  ];
  if (AI_STAGE.background) {
    lines.splice(4, 0, '- {"type":"background","mode":"transparent|white"}（抠图去背景）');
  }
  lines.push('不确定或超出上述能力时，返回 {"actions":[],"notes":"说明为什么做不到"}。');
  return lines.join('');
}

/** 3.1 起为兼容旧调用保留；新代码请用 buildAiSystemPrompt()。 */
export const DEFAULT_AI_SYSTEM_PROMPT = buildAiSystemPrompt();

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

// ── 提供商 / 模型两级配置 ──
//
// 结构：提供商 { id, label, baseUrl, models: string[] }，Key 按提供商单独存本机。
// 这样用户可以一次配置多个服务商（OpenAI / DeepSeek / 自建网关…），
// 每个服务商下挂多个模型，使用时在右侧栏选「提供商 · 模型」。

let _migrated = false;

const _generateProviderId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const _readProviders = () => {
  const raw = _readSync(STORAGE_KEYS.providers);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || _generateProviderId()),
        label: String(item.label || ''),
        baseUrl: String(item.baseUrl || ''),
        models: Array.isArray(item.models) ? item.models.map((m) => String(m)).filter(Boolean) : []
      }));
  } catch {
    console.warn('[AI_CONFIG] 提供商配置解析失败，按空配置处理');
    return [];
  }
};

const _writeProviders = (providers) => _writeSync(STORAGE_KEYS.providers, JSON.stringify(providers));

/**
 * 旧版单套配置 → 新版两级配置的一次性迁移。
 * 已存在新版配置时不动；旧配置迁移后保留原键（只读，不再写入）。
 */
function _migrateLegacyConfig() {
  if (_migrated) {
    return;
  }
  _migrated = true;
  if (_readProviders().length > 0) {
    return;
  }
  const baseUrl = _readSync(STORAGE_KEYS.baseUrl) || '';
  const model = _readSync(STORAGE_KEYS.model) || '';
  const apiKey = _readLocal(STORAGE_KEYS.apiKeyLocal) || '';
  if (!baseUrl && !model && !apiKey) {
    return;
  }
  const provider = {
    id: _generateProviderId(),
    label: matchPresetId(baseUrl) ? String(matchPresetId(baseUrl)) : (baseUrl ? '自定义服务商' : '默认服务商'),
    baseUrl,
    models: model ? [model] : []
  };
  _writeProviders([provider]);
  if (apiKey) {
    _writeLocal(`${PROVIDER_KEY_PREFIX}${provider.id}`, apiKey);
  }
  if (baseUrl) {
    _writeSync(STORAGE_KEYS.activeProvider, provider.id);
  }
  if (model) {
    _writeSync(STORAGE_KEYS.activeModel, model);
  }
}

/**
 * 读取全部提供商（含 Key 与本机是否有 Key 的标记），UI 直接渲染用。
 * @returns {Array<{id:string,label:string,baseUrl:string,models:string[],key:string,hasKey:boolean}>}
 */
export function listProviders() {
  _migrateLegacyConfig();
  return _readProviders().map((provider) => {
    const key = getProviderKey(provider.id);
    return { ...provider, key, hasKey: !!key };
  });
}

/**
 * 按 id 取提供商（不含 Key）。
 * @param {string} providerId
 * @returns {object|null}
 */
export function getProvider(providerId) {
  return _readProviders().find((provider) => provider.id === providerId) || null;
}

/**
 * 新增一个提供商。
 * @param {object} params { label, baseUrl }
 * @returns {object} 新增的提供商（不含 Key）
 */
export function addProvider({ label = '', baseUrl = '' } = {}) {
  const providers = _readProviders();
  const provider = {
    id: _generateProviderId(),
    label: String(label || '').trim() || '未命名服务商',
    baseUrl: normalizeAiBaseUrl(baseUrl),
    models: []
  };
  providers.push(provider);
  _writeProviders(providers);
  return provider;
}

/**
 * 修改提供商的基础信息（label / baseUrl）。
 * @param {string} providerId
 * @param {object} patch { label?, baseUrl? }
 * @returns {boolean}
 */
export function updateProvider(providerId, patch = {}) {
  const providers = _readProviders();
  const target = providers.find((provider) => provider.id === providerId);
  if (!target) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
    target.label = String(patch.label || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'baseUrl')) {
    target.baseUrl = normalizeAiBaseUrl(patch.baseUrl);
  }
  _writeProviders(providers);
  return true;
}

/**
 * 删除提供商（连带删除本机 Key 与当前选中项指向它的引用）。
 * @param {string} providerId
 * @returns {boolean}
 */
export function removeProvider(providerId) {
  const providers = _readProviders();
  const next = providers.filter((provider) => provider.id !== providerId);
  if (next.length === providers.length) {
    return false;
  }
  _writeProviders(next);
  _writeLocal(`${PROVIDER_KEY_PREFIX}${providerId}`, '');
  if ((_readSync(STORAGE_KEYS.activeProvider) || '') === providerId) {
    _writeSync(STORAGE_KEYS.activeProvider, next[0] ? next[0].id : '');
    _writeSync(STORAGE_KEYS.activeModel, next[0] && next[0].models[0] ? next[0].models[0] : '');
  }
  return true;
}

/**
 * 读取某提供商的 API Key（仅本机存储）。
 * @param {string} providerId
 * @returns {string}
 */
export function getProviderKey(providerId) {
  if (!providerId) {
    return '';
  }
  return _readLocal(`${PROVIDER_KEY_PREFIX}${providerId}`) || '';
}

/**
 * 写入某提供商的 API Key（仅本机，不随宿主账号同步）。
 * @param {string} providerId
 * @param {string} apiKey
 * @returns {boolean}
 */
export function setProviderKey(providerId, apiKey) {
  if (!providerId) {
    return false;
  }
  return _writeLocal(`${PROVIDER_KEY_PREFIX}${providerId}`, apiKey || '');
}

/**
 * 给提供商添加一个模型（重名忽略）。
 * @param {string} providerId
 * @param {string} modelName
 * @returns {boolean} 是否真的新增了
 */
export function addModel(providerId, modelName) {
  const name = String(modelName || '').trim();
  if (!name) {
    return false;
  }
  const providers = _readProviders();
  const target = providers.find((provider) => provider.id === providerId);
  if (!target) {
    return false;
  }
  if (target.models.includes(name)) {
    return false;
  }
  target.models.push(name);
  _writeProviders(providers);
  return true;
}

/**
 * 从提供商删除一个模型；若删的是当前选中模型，自动切到剩余第一个。
 * @param {string} providerId
 * @param {string} modelName
 * @returns {boolean}
 */
export function removeModel(providerId, modelName) {
  const providers = _readProviders();
  const target = providers.find((provider) => provider.id === providerId);
  if (!target) {
    return false;
  }
  const next = target.models.filter((model) => model !== modelName);
  if (next.length === target.models.length) {
    return false;
  }
  target.models = next;
  _writeProviders(providers);
  if ((_readSync(STORAGE_KEYS.activeProvider) || '') === providerId
    && (_readSync(STORAGE_KEYS.activeModel) || '') === modelName) {
    _writeSync(STORAGE_KEYS.activeModel, next[0] || '');
  }
  return true;
}

/**
 * 当前选中的「提供商 + 模型」。
 * @returns {{providerId:string, model:string}}
 */
export function getActiveSelection() {
  _migrateLegacyConfig();
  const providers = _readProviders();
  if (providers.length === 0) {
    return { providerId: '', model: '' };
  }
  const selectedProviderId = _readSync(STORAGE_KEYS.activeProvider) || '';
  const selectedModel = _readSync(STORAGE_KEYS.activeModel) || '';
  const provider = providers.find((item) => item.id === selectedProviderId) || providers[0];
  const model = provider.models.includes(selectedModel) ? selectedModel : (provider.models[0] || '');
  return { providerId: provider.id, model };
}

/**
 * 保存当前选中的「提供商 + 模型」。
 * @param {string} providerId
 * @param {string} model
 * @returns {boolean}
 */
export function setActiveSelection(providerId, model) {
  _writeSync(STORAGE_KEYS.activeProvider, providerId || '');
  _writeSync(STORAGE_KEYS.activeModel, model || '');
  return true;
}

/**
 * 解析当前可用的执行目标（提供商 + 模型 + Key）。
 * @returns {{provider:object, model:string, apiKey:string}|null}
 */
export function resolveActiveTarget() {
  const { providerId, model } = getActiveSelection();
  const provider = providerId ? getProvider(providerId) : null;
  if (!provider || !model) {
    return null;
  }
  return { provider, model, apiKey: getProviderKey(provider.id) };
}

/**
 * 读取执行用配置（对上层保持「扁平」视图，避免每个调用方都处理两级结构）。
 * @returns {{ baseUrl:string, apiKey:string, model:string, systemPrompt:string, draft:string }}
 */
export function getAiConfig() {
  const systemPrompt = _readSync(STORAGE_KEYS.systemPrompt) || '';
  const draft = _readSync(STORAGE_KEYS.draft) || '';
  const target = resolveActiveTarget();
  if (!target) {
    return { baseUrl: '', apiKey: '', model: '', systemPrompt, draft };
  }
  return {
    baseUrl: target.provider.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    systemPrompt,
    draft
  };
}

/**
 * 写入一个字段（按字段的存储分层自动路由）。
 *
 * 只接受全局面板字段（systemPrompt / draft）。baseUrl / apiKey / model 属于
 * 提供商+模型两级结构，必须经 addProvider / setProviderKey / addModel 写入，
 * 用扁平接口直写会让两级数据不同步。
 *
 * @param {string} fieldKey AI_CONFIG_FIELDS 的键
 * @param {string} value
 * @returns {boolean} 是否成功持久化
 */
export function setAiConfigField(fieldKey, value) {
  if (fieldKey === 'baseUrl' || fieldKey === 'apiKey' || fieldKey === 'model') {
    console.warn(`[AI_CONFIG] 字段 ${fieldKey} 已由提供商/模型两级配置接管，请使用 addProvider/setProviderKey/addModel`);
    return false;
  }
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
 * 配置状态码（UI 文案与执行前置判断共用）。
 * @type {{READY:string, NO_PROVIDER:string, NO_MODEL:string, NO_BASE_URL:string, INSECURE_BASE_URL:string}}
 */
export const AI_CONFIG_STATUS = {
  READY: 'ready',
  NO_PROVIDER: 'no-provider',
  NO_MODEL: 'no-model',
  NO_BASE_URL: 'no-base-url',
  INSECURE_BASE_URL: 'insecure-base-url'
};

/**
 * 服务地址的问题码（空 / 非 https），没问题返回空串。
 *
 * 抽成单一函数是因为「校验」（validateAiConfig）与「诊断文案」
 * （getAiConfigStatus）必须同一个口径：以前两处各自判断 https，
 * 一旦规则改动就会一边放行一边拒绝。
 * @param {string} baseUrl
 * @returns {''|'no-base-url'|'insecure-base-url'}
 */
function _baseUrlIssue(baseUrl) {
  const root = normalizeAiBaseUrl(baseUrl);
  if (!root) {
    return AI_CONFIG_STATUS.NO_BASE_URL;
  }
  // 只允许 https：Key 与图片数据不得走明文通道
  if (!/^https:\/\//i.test(root)) {
    return AI_CONFIG_STATUS.INSECURE_BASE_URL;
  }
  return '';
}

/**
 * 配置完整性与合法性校验（保存前与执行前共用）。
 * @param {object} [config] 缺省自动读取
 * @returns {ok:boolean, errors:Record<string,string>}
 */
export function validateAiConfig(config = getAiConfig()) {
  const errors = {};
  const issue = _baseUrlIssue(config.baseUrl);
  if (issue === AI_CONFIG_STATUS.NO_BASE_URL) {
    errors.baseUrl = '请填写服务地址';
  } else if (issue === AI_CONFIG_STATUS.INSECURE_BASE_URL) {
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
 * 配置就绪状态 + 面向用户的诊断文案（唯一来源）。
 *
 * 为什么需要它：过去 UI 只有 isAiConfigReady() 一个布尔值，「没配服务商」
 * 「没加模型」「没填服务地址」「地址不是 https」四种完全不同的情况都被
 * 渲染成同一句「尚未配置服务商」。于是用户在配置页明明已经加好服务商与
 * 模型（右侧栏模型下拉都能选），属性面板却坚持说他没配置，谁也看不出
 * 还差的是服务地址。
 *
 * 文案里的入口统一写「头像 → AI 配置」，与编辑器属性面板的实际路径一致。
 *
 * @param {object} [config] 缺省自动读取
 * @returns {{ready:boolean, code:string, message:string, providerId:string, model:string}}
 */
export function getAiConfigStatus(config = getAiConfig()) {
  const selection = getActiveSelection();
  const providerId = selection.providerId || '';
  const model = String(config.model || '').trim();

  if (!providerId || listProviders().length === 0) {
    return {
      ready: false,
      code: AI_CONFIG_STATUS.NO_PROVIDER,
      message: '尚未添加服务商：请到「头像 → AI 配置」添加服务商与模型。',
      providerId,
      model
    };
  }
  if (!model) {
    return {
      ready: false,
      code: AI_CONFIG_STATUS.NO_MODEL,
      message: '服务商还没有模型：请到「头像 → AI 配置」添加一个模型名。',
      providerId,
      model
    };
  }

  const issue = _baseUrlIssue(config.baseUrl);
  if (issue === AI_CONFIG_STATUS.NO_BASE_URL) {
    return {
      ready: false,
      code: AI_CONFIG_STATUS.NO_BASE_URL,
      message: '服务商缺少服务地址：请到「头像 → AI 配置」填写该服务商的服务地址。',
      providerId,
      model
    };
  }
  if (issue === AI_CONFIG_STATUS.INSECURE_BASE_URL) {
    return {
      ready: false,
      code: AI_CONFIG_STATUS.INSECURE_BASE_URL,
      message: '服务地址必须以 https:// 开头：请到「头像 → AI 配置」修正服务地址。',
      providerId,
      model
    };
  }

  return { ready: true, code: AI_CONFIG_STATUS.READY, message: '', providerId, model };
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
