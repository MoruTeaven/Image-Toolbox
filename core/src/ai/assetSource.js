/**
 * assetSource — AI 资产（模型 / ONNX Runtime wasm）的内联注入点
 *
 * 背景
 * ----
 * AI 模型与 onnxruntime-web 的 .wasm 是二进制资产，无法打进 bundle：
 *   - Web 端按「相对 URL 按需 fetch」加载（构建期拷贝到 dist/web/assets/ai/）；
 *   - uTools / ZTools 端页面运行在受限协议下，运行时 fetch 本地文件不可靠，
 *     构建期由 scripts/prepare-build.mjs 把资产转成 base64 生成
 *     ai-assets-inline.js，在该模块里调用 setInlineAiAssets() 注入。
 *
 * core 其余代码只经本模块读取「内联资产是否存在」，不感知平台差异；
 * 资产到字节的解析统一收敛在 ports/AIPort.js。
 */

let _inlineAssets = null;

/**
 * 注入内联 AI 资产（仅由构建期生成的入口模块调用一次）。
 * @param {{ u2netpModelBase64: string, ortWasmBase64: string }} assets
 */
export function setInlineAiAssets(assets) {
  if (!assets || typeof assets !== 'object') {
    return;
  }
  _inlineAssets = {
    u2netpModelBase64: typeof assets.u2netpModelBase64 === 'string' ? assets.u2netpModelBase64 : '',
    ortWasmBase64: typeof assets.ortWasmBase64 === 'string' ? assets.ortWasmBase64 : ''
  };
}

/**
 * 读取内联 AI 资产；未注入（Web 端）时返回 null。
 * @returns {{ u2netpModelBase64: string, ortWasmBase64: string }|null}
 */
export function getInlineAiAssets() {
  return _inlineAssets;
}

/** 清空注入（测试用）。 */
export function resetInlineAiAssets() {
  _inlineAssets = null;
}
