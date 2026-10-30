/**
 * LocalOnnxProvider — 本地 ONNX 推理 Provider（基于 @planby-tech/rmbg-webgpu）
 *
 * 依赖说明
 * ----
 * @planby-tech/rmbg-webgpu（库源码 MIT；捆绑 u2netp.onnx 模型 Apache-2.0，
 * 见其 THIRD_PARTY_NOTICES.md 与 LICENSES/Apache-2.0.txt）封装了
 * onnxruntime-web 的推理管线：预处理（320×320、max 归一化）、
 * u2netp 推理、输出 minmax 归一化为 alpha mask、与输入合成 RGBA。
 * WASM 执行提供器在无 WebGPU 的环境（uTools / ZTools 渲染进程、多数
 * 桌面浏览器）作为默认通道，单线程运行，不依赖跨域隔离。
 *
 * 资产装配
 * ----
 * 模型字节与 wasm 装配方式统一经 ports/AIPort.js 解析（内联 / URL 两种
 * 形态），本文件不感知平台差异。
 */

import { AI_CAPABILITIES, AI_PROVIDER_IDS } from './AI_PROVIDERS.js';
import { loadOnnxRuntime, resolveU2netpModelSource } from '../ports/AIPort.js';

/** 共享会话缓存：同一次插件生命周期内复用已加载的模型，避免重复初始化。 */
let _sessionPromise = null;

/**
 * 取（或创建）共享推理会话。
 * @returns {Promise<object>} rmbg-webgpu 的 RmbgSession 实例
 * @throws {Error} 模型或运行时初始化失败时抛出，由调用方转用户提示
 */
async function getSharedSession() {
  if (_sessionPromise) {
    return _sessionPromise;
  }

  _sessionPromise = (async () => {
    // 先按平台形态配置 ort env（wasmBinary / wasmPaths），再创建会话。
    await loadOnnxRuntime();

    const { RmbgSession } = await import('@planby-tech/rmbg-webgpu');
    const modelSource = resolveU2netpModelSource();
    const createOptions = {
      model: 'u2netp',
      executionProviders: ['wasm']
    };
    if (modelSource.mode === 'inline') {
      createOptions.modelUrl = modelSource.bytes;
    } else {
      createOptions.modelUrl = modelSource.url;
    }

    try {
      return await RmbgSession.create(createOptions);
    } catch (err) {
      // 会话创建失败时清空缓存，允许下次重试（如资源加载瞬时失败）。
      _sessionPromise = null;
      throw err;
    }
  })();

  return _sessionPromise;
}

/** 释放共享会话（换图不释放；供测试或显式回收调用）。 */
export async function disposeLocalOnnxProvider() {
  if (!_sessionPromise) {
    return;
  }
  const pending = _sessionPromise;
  _sessionPromise = null;
  try {
    const session = await pending;
    await session.dispose?.();
  } catch (e) {
    console.warn('[LocalOnnxProvider] 释放推理会话失败:', e);
  }
}

/**
 * 本地推理是否就绪（资产两种形态至少一种可用）。
 * @returns {boolean}
 */
export function isLocalOnnxAvailable() {
  try {
    const source = resolveU2netpModelSource();
    return source.mode === 'url' || (source.bytes && source.bytes.length > 0);
  } catch {
    return false;
  }
}

/**
 * 执行一键抠图。
 *
 * @param {ImageData} imageData 输入图层像素（原始分辨率）
 * @param {string} capabilityId 能力 id（须指向 local-onnx Provider）
 * @param {object} [options]
 * @param {Array<number>|null} [options.backgroundColor] 输出背景色 RGBA，null 为透明
 * @returns {Promise<{ output: ImageData, mask: ImageData, timingMs: number, executionProvider: string }>}
 * @throws {Error} 能力未注册到本 Provider、或推理失败时抛出
 */
export async function runCapability(imageData, capabilityId, options = {}) {
  const capability = AI_CAPABILITIES[capabilityId];
  if (!capability || capability.provider !== AI_PROVIDER_IDS.LOCAL_ONNX) {
    throw new Error(`[LocalOnnxProvider] 能力未路由到本地推理: ${capabilityId}`);
  }

  const session = await getSharedSession();
  const result = await session.remove(imageData, {
    backgroundColor: options.backgroundColor !== undefined ? options.backgroundColor : null,
    mimeType: 'image/png'
  });

  if (!result || !(result.output instanceof ImageData)) {
    throw new Error('[LocalOnnxProvider] 推理结果格式异常（缺少 ImageData 输出）');
  }

  return {
    output: result.output,
    mask: result.mask,
    timingMs: result.timingMs || 0,
    executionProvider: result.executionProvider || 'wasm'
  };
}
