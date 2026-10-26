/**
 * ColorPort — 屏幕取色能力入口
 *
 * 三端（uTools / ZTools / Web）都是 Chromium 系渲染器，取色有多条降级路径。
 * 本端口把它们收敛在一处，让业务模块（BrushModule / ShapeModule）只表达
 * 「我要取一个颜色」这一意图。
 *
 * 取值优先级：
 *   1. 注入实现（测试 / 特殊平台）
 *   2. HostAdapter.pickColor（宿主系统取色器，uTools 已实测可用）
 *   3. EyeDropper API（Web 端 Chromium 原生全屏吸管）
 *   4. 隐藏 input[type=color]（原生颜色面板，面板内自带吸管）
 */

import { getDomPort } from './DomPort.js';

let _hostAdapter = null;
let _impl = null;

/**
 * 注入宿主适配器。
 * @param {object|null} hostAdapter
 */
export function setColorHost(hostAdapter) {
  _hostAdapter = hostAdapter || null;
}

/**
 * 注入自定义取色实现（测试用）。
 * @param {((current: string) => Promise<string|null>)|null} impl
 */
export function setColorImpl(impl) {
  _impl = typeof impl === 'function' ? impl : null;
}

/** 清空注入（测试用）。 */
export function resetColorPort() {
  _hostAdapter = null;
  _impl = null;
}

/**
 * 拾取一个颜色。
 * @param {string} [current] 兜底路径的初始展示色（6 位 hex）
 * @returns {Promise<string|null>} hex 颜色；取消或不可用返回 null
 */
export async function pickColor(current = '#000000') {
  if (_impl) {
    try {
      return await _impl(current);
    } catch (e) {
      console.warn('[ColorPort] 注入的取色实现失败:', e);
      return null;
    }
  }

  // 宿主原生取色器
  if (typeof _hostAdapter?.pickColor === 'function') {
    try {
      const color = await _hostAdapter.pickColor();
      if (color) return color;
    } catch (e) {
      console.warn('[ColorPort] 宿主取色失败，降级到浏览器 API:', e);
    }
  }

  // 浏览器 EyeDropper
  const EyeDropperCtor = getDomPort()?.getHostGlobal?.()?.EyeDropper;
  if (typeof EyeDropperCtor === 'function') {
    try {
      const dropper = new EyeDropperCtor();
      const result = await dropper.open();
      if (result?.sRGBHex) return result.sRGBHex;
    } catch (e) {
      // 用户关闭取色界面时 EyeDropper 以 abort 拒绝，属正常操作
      return null;
    }
  }

  return _pickWithColorInput(current);
}

/**
 * 兜底：隐藏的 input[type=color]。
 *
 * 已知局限——取消不触发任何事件，Promise 保持 pending；无副作用泄漏
 * （仅一个悬空的一次性监听），可接受。
 */
function _pickWithColorInput(current) {
  const port = getDomPort();
  const input = port?.createElement?.('input');
  const body = port?.getBody?.();

  if (!input || !body) return Promise.resolve(null);

  return new Promise((resolve) => {
    input.type = 'color';
    input.value = current;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';

    port.onElement?.(input, 'change', () => {
      const value = input.value;
      input.remove?.();
      resolve(value);
    }, { once: true });

    body.appendChild(input);
    input.click?.();
  });
}
