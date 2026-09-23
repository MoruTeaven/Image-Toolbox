/**
 * HostAdapter 桩件 — 供 scripts/repro-app-eventbus-leak.mjs 在 Node 中构造 App。
 * 只实现 App 初始化路径实际用到的能力，其余继承 BaseHostAdapter 默认行为。
 */

import BaseHostAdapter from '../core/src/adapters/BaseHostAdapter.js';

class StubHostAdapter extends BaseHostAdapter {
  constructor() {
    super();
    this._pluginEnterCallbacks = [];
    this.windowHeight = null;
  }

  // 基类构造时会用 platformId / getHostDisplayName() / getHostAppVersion() /
  // getPluginVersion() 组装 this.platform，注意不要在此处覆盖 platform 本身。
  get platformId() { return 'stub'; }

  getDefaultHostName() { return 'Stub'; }

  getHostAppVersion() { return '0.0.0'; }

  getPluginVersion() { return '0.0.0'; }

  onPluginEnter(cb) {
    this._pluginEnterCallbacks.push(cb);
    return () => {
      const i = this._pluginEnterCallbacks.indexOf(cb);
      if (i >= 0) { this._pluginEnterCallbacks.splice(i, 1); }
    };
  }

  onPluginOut() {}

  setWindowHeight(h) { this.windowHeight = h; }
}

export default StubHostAdapter;
