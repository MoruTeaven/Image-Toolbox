/**
 * 屏幕取色 — 经 ColorPort 取得，不在本模块直接触碰 DOM。
 *
 * 能力优先级由 ColorPort 决定：
 *   1. 宿主原生取色（HostAdapter.pickColor，uTools/ZTools 系统取色器）
 *   2. 浏览器原生 EyeDropper（Chromium 95+，全屏吸管）
 *   3. 隐藏的 input[type=color]（面板内同样带吸管工具）
 *
 * 历史注记：本模块原先自己实现 EyeDropper + input 降级，并在注释里留下
 * 「后续 core 边界收敛时整体下沉 UI 层」的待办。实际收敛时选择抽成端口而非
 * 下沉 UI 层，因为取色是工具模块（BrushModule / ShapeModule）的功能依赖，
 * 不是界面渲染行为 —— 下沉到 ui/ 会造成 modules → ui 的反向依赖。
 */

import { pickColor as pickColorViaPort } from '../ports/ColorPort.js';

/**
 * 拾取一个颜色。
 * @param {string} [current] 兜底路径的初始展示色（6 位 hex）
 * @returns {Promise<string|null>} 取到的 hex 颜色；取消或不可用返回 null
 */
export async function pickColorFromScreen(current = '#000000') {
  return pickColorViaPort(current);
}
