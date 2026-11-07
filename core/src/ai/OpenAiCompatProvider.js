/**
 * OpenAiCompatProvider — OpenAI 兼容 Chat Completions 服务商（用户自带配置）
 *
 * 定位
 * ----
 * 图片工具箱的「AI 编辑」云端通道：用户在「AI 配置」页填服务商地址 /
 * Key / 模型，右侧栏写提示词，本模块把「提示词 + 当前图层缩略图」发给
 * 模型，模型返回白名单修图指令 JSON（契约见 ai/AI_INSTRUCTION.js），
 * 由 AIModule 落到既有工具链执行。
 *
 * 安全红线（与 AI_CONFIG.js 的分层存储配套）
 * ----------------------------------------
 * - Key 只在用户填写的 baseUrl 这一跳发出；aiFetch 是唯一网络出口；
 * - Key 不写日志，错误文案里不含 Key；
 * - 公网地址只允许 https；本机 / 局域网地址（127.0.0.0/8、10/8、
 *   172.16/12、192.168/16、169.254/16、localhost 等）允许 http——
 *   这类设备通常没有证书，且流量不出内网；判定统一在 AI_CONFIG；
 * - 发给模型的是 ≤777px 的 JPEG 缩略图（供理解画面），不是原图上传。
 */

import { aiFetch } from '../ports/AIPort.js';
import {
  AI_CONFIG_LIMITS,
  buildAiSystemPrompt,
  getAiConfig,
  normalizeAiBaseUrl,
  resolveChatCompletionsUrl,
  validateAiConfig
} from './AI_CONFIG.js';

/**
 * 请求一个带超时的 fetch。
 * @param {string} url
 * @param {object} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    return await aiFetch(url, { ...init, signal: controller?.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 HTTP 状态码翻成用户能看懂的原因（不带 Key、不带响应体细节）。
 * @param {number} status
 * @param {string} body 截断后的响应体
 * @returns {string}
 */
function describeHttpError(status, body) {
  if (status === 401 || status === 403) {
    return '鉴权失败，请检查 API Key 是否正确';
  }
  if (status === 404) {
    return '接口不存在，请检查服务地址是否为 OpenAI 兼容的 v1 根地址';
  }
  if (status === 429) {
    return '服务商限流或额度用尽，稍后再试';
  }
  if (status >= 500) {
    return '服务商暂时不可用，稍后再试';
  }
  const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 177);
  return `服务商返回 ${status}${detail ? `：${detail}` : ''}`;
}

/**
 * 向配置好的服务商发起一次修图指令请求。
 * @param {object} params
 * @param {string} params.prompt 用户提示词（右侧栏原文）
 * @param {string} [params.imageDataUrl] 当前图层缩略图 dataURL（JPEG/PNG）
 * @param {Array<{role:string, content:string}>} [params.history] 之前轮次对话（可选）
 * @param {object} [params.config] 覆盖配置（缺省自动读取 AI_CONFIG）
 * @returns {Promise<{ text: string, model: string }>} 模型回复原文（指令 JSON 由调用方解析）
 * @throws {Error} 配置不完整 / 网络失败 / HTTP 错误 / 响应格式异常
 */
export async function requestInstruction(params) {
  const { prompt, imageDataUrl, history = [], config = getAiConfig() } = params || {};

  const validation = validateAiConfig(config);
  if (!validation.ok) {
    const firstError = Object.values(validation.errors)[0] || '请先完成 AI 配置';
    throw new Error(`AI 配置未完成：${firstError}`);
  }

  const url = resolveChatCompletionsUrl(config.baseUrl);
  const systemPrompt = String(config.systemPrompt || '').trim() || buildAiSystemPrompt();

  const userContent = [];
  if (prompt) {
    userContent.push({ type: 'text', text: String(prompt).slice(0, 7777) });
  }
  if (imageDataUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  if (userContent.length === 0) {
    throw new Error('[OpenAiCompat] 提示词为空');
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-7),
    { role: 'user', content: userContent }
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${String(config.apiKey).trim()}`;
  }

  const body = {
    model: String(config.model).trim(),
    messages,
    temperature: AI_CONFIG_LIMITS.temperature.default,
    max_tokens: AI_CONFIG_LIMITS.maxTokens.default
  };

  let response;
  try {
    response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, AI_CONFIG_LIMITS.timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(AI_CONFIG_LIMITS.timeoutMs / 1000)} 秒），请检查网络或服务商`);
    }
    // 浏览器 fetch 对「连不上」和「被跨域拦掉」都只给一句 Failed to fetch，
    // 单看原文无法判断是地址不对还是服务商没放行跨域，这里补一句排查方向。
    if (/failed to fetch|networkerror|load failed/i.test(String(err?.message || ''))) {
      throw new Error('网络请求失败：无法连接该地址（请确认地址可从本机访问，且服务商允许跨域请求）');
    }
    throw new Error(`网络请求失败：${err?.message || '无法连接服务商'}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = String(await response.text()).slice(0, 300);
    } catch { /* 忽略读取失败 */ }
    throw new Error(describeHttpError(response.status, detail));
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('服务商返回的不是合法 JSON，请确认地址是 OpenAI 兼容接口');
  }

  const message = payload?.choices?.[0]?.message;
  // 部分服务商把内容放在 reasoning_content 或多段数组里，做一次宽松提取
  let text = message?.content;
  if (Array.isArray(text)) {
    text = text.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('服务商未返回内容，请更换模型或稍后再试');
  }

  return { text, model: payload?.model || body.model };
}

/**
 * 测试服务商连通性（供「AI 配置」页的测试按钮）。
 * 先探 GET /models（标准端点，能列出模型即地址与 Key 均可用）；
 * 服务商不提供该端点（404/405）时退化为一次极小 chat/completions。
 * @param {object} [config] 缺省自动读取
 * @returns {Promise<{ ok:boolean, message:string, models:string[] }>}
 */
export async function testConnection(config = getAiConfig()) {
  const validation = validateAiConfig(config);
  if (!validation.ok) {
    return { ok: false, message: Object.values(validation.errors)[0] || '请先完成配置', models: [] };
  }

  const root = normalizeAiBaseUrl(config.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${String(config.apiKey).trim()}`;
  }

  try {
    let response = await fetchWithTimeout(`${root}/models`, { headers }, AI_CONFIG_LIMITS.timeoutMs);
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const models = Array.isArray(payload?.data)
        ? payload.data.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean)
        : [];
      const wanted = String(config.model).trim();
      const suffix = models.length
        ? `（${models.length} 个模型${models.includes(wanted) ? `，含 ${wanted}` : `，未找到 ${wanted}`}）`
        : '';
      return { ok: true, message: `连接成功${suffix}`, models };
    }

    // 兼容服务商常省略 /models，退化为最小对话请求
    if (response.status === 404 || response.status === 405) {
      response = await fetchWithTimeout(resolveChatCompletionsUrl(config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: String(config.model).trim(),
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16
        })
      }, AI_CONFIG_LIMITS.timeoutMs);
      if (response.ok) {
        return { ok: true, message: '连接成功', models: [] };
      }
    }

    let detail = '';
    try {
      detail = String(await response.text()).slice(0, 300);
    } catch { /* 忽略 */ }
    return { ok: false, message: describeHttpError(response.status, detail), models: [] };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, message: `请求超时（${Math.round(AI_CONFIG_LIMITS.timeoutMs / 1000)} 秒）`, models: [] };
    }
    return { ok: false, message: err?.message || '无法连接服务商', models: [] };
  }
}
