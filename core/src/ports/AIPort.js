/**
 * AIPort — AI 能力的环境接合点（非 UI 层 AI 资产/运行时的唯一出口）
 *
 * 职责
 * ----
 * 1. 资产定位：模型（u2netp.onnx）与 ONNX Runtime wasm 在「内联」与
 *    「URL」两种形态间统一解析，调用方不感知平台差异：
 *      - Web 端：构建期拷贝到 dist/web/assets/ai/，按相对 URL 按需加载；
 *      - uTools / ZTools 端：受限页面协议下 fetch 本地文件不可靠，
 *        构建期生成 ai-assets-inline.js 注入 base64，这里解码为字节直喂
 *        ONNX Runtime（env.wasm.wasmBinary / InferenceSession.create(Uint8Array)），
 *        全程零网络、零 file:// fetch。
 * 2. 运行时配置：onnxruntime-web 的 env 设置只允许经本端口。
 *
 * AI 能力注册表见 core/src/ai/AI_PROVIDERS.js（唯一权威来源）。
 */

import { getInlineAiAssets } from '../ai/assetSource.js';
import { getDomPort } from './DomPort.js';

/** dist 内 AI 资产目录（相对页面基准 URL）。 */
export const AI_ASSET_DIR = './assets/ai/';

/** 资产文件名（构建期从 node_modules 拷贝，运行时按此名解析）。 */
export const AI_ASSET_FILES = {
  MODEL_U2NETP: 'u2netp.onnx',
  // 非 jsep 变体：构建期 esbuild 把 onnxruntime-web/webgpu alias 到主入口，
  // 胶水与 wasm 均为 ort-wasm-simd-threaded.*（与 build.mjs / prepare-build.mjs 的
  // 拷贝与内联源两处保持一致）。
  ORT_WASM_MJS: 'ort-wasm-simd-threaded.mjs',
  ORT_WASM: 'ort-wasm-simd-threaded.wasm'
};

/**
 * base64 → Uint8Array（纯字节操作，不依赖浏览器 API）。
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 解析 u2netp 模型来源。
 * @returns {{ mode: 'inline', bytes: Uint8Array } | { mode: 'url', url: string }}
 * @throws {Error} 两种形态都不可用时抛出（调用方转用户提示）
 */
export function resolveU2netpModelSource() {
  const inline = getInlineAiAssets();
  if (inline && inline.u2netpModelBase64) {
    return { mode: 'inline', bytes: base64ToBytes(inline.u2netpModelBase64) };
  }
  return { mode: 'url', url: `${AI_ASSET_DIR}${AI_ASSET_FILES.MODEL_U2NETP}` };
}

/**
 * 解析 ONNX Runtime wasm 装配方式。
 * @returns {{ mode: 'inline', bytes: Uint8Array, wasmPaths: string } | { mode: 'url', wasmPaths: string }}
 * @throws {Error} 内联模式下 wasm base64 缺失时抛出
 */
export function resolveOrtWasmSetup() {
  const inline = getInlineAiAssets();
  if (inline) {
    if (!inline.ortWasmBase64) {
      throw new Error('[AIPort] 内联模式缺少 ort wasm 资产（构建产物不完整）');
    }
    // wasmBinary 直接喂字节（设置后 ort 不再 fetch .wasm）；
    // 但 ESM 胶水 .mjs 仍按 wasmPaths 动态 import，因此目录必须照常下发。
    return { mode: 'inline', bytes: base64ToBytes(inline.ortWasmBase64), wasmPaths: AI_ASSET_DIR };
  }
  return { mode: 'url', wasmPaths: AI_ASSET_DIR };
}

/**
 * 加载 onnxruntime-web 并按平台形态配置 env。
 * 动态 import 使运行时初始化延迟到首次真正使用 AI 功能时，
 * 保证 bundle 冒烟（无 AI 调用路径）不受 ort 顶层副作用影响。
 * @returns {Promise<object>} onnxruntime-web 模块（含 env / Tensor 等）
 */
export async function loadOnnxRuntime() {
  // 构建期 esbuild 以 --alias 把 onnxruntime-web/webgpu 重定向到主入口
  //（wasm 执行提供器专用，体积减半），源码统一写主入口。
  const ort = await import('onnxruntime-web');
  const setup = resolveOrtWasmSetup();
  if (setup.mode === 'inline') {
    ort.env.wasm.wasmBinary = setup.bytes;
  }
  ort.env.wasm.wasmPaths = setup.wasmPaths;
  // 单线程：uTools / ZTools 页面无跨域隔离（SharedArrayBuffer 不可用），web 端同理。
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  return ort;
}

/**
 * 通用资源获取出口（AI 相关的网络访问只允许经此方法）。
 * @param {string} url
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export function aiFetch(url, init) {
  const hostGlobal = getDomPort()?.getHostGlobal?.();
  const fetchFn = hostGlobal && typeof hostGlobal.fetch === 'function'
    ? hostGlobal.fetch.bind(hostGlobal)
    : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) {
    return Promise.reject(new Error('[AIPort] 当前环境无 fetch 能力'));
  }
  return fetchFn(url, init);
}
