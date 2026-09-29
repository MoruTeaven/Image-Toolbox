/**
 * 屏幕取色 — 优先浏览器原生 EyeDropper（Chromium 95+，全屏吸管），
 * 降级到隐藏的 input[type=color]（面板内同样带吸管工具）。
 *
 * 本模块操作 DOM，属于三端（uTools/ZTools/Web 均为 Chromium 系渲染器）
 * 共用的浏览器标准能力，不含平台判断；后续 core 边界收敛时整体下沉 UI 层即可。
 */

/**
 * 拾取一个颜色。
 * @param {string} [current] 兜底路径的初始展示色（6 位 hex）
 * @returns {Promise<string|null>} 取到的 hex 颜色；取消或不可用返回 null
 */
export async function pickColorFromScreen(current = '#000000') {
  if (typeof window === 'undefined') return null;

  if (typeof window.EyeDropper === 'function') {
    try {
      const dropper = new window.EyeDropper();
      const result = await dropper.open();
      return result && result.sRGBHex ? result.sRGBHex : null;
    } catch (e) {
      // 用户关闭取色界面时 EyeDropper 以 abort 拒绝，属正常操作
      return null;
    }
  }

  // 兜底：原生颜色面板。已知局限——取消不触发任何事件，Promise 保持 pending；
  // 无副作用泄漏（仅一个悬空的一次性监听），可接受。
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.addEventListener('change', () => {
      const value = input.value;
      input.remove();
      resolve(value);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
