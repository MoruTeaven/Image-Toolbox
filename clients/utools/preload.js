const { initPlatformPreload } = require('../../../core/src/preloadHelpers.js');

// ═══════════════════════════════════════════════════════════════
// uTools 平台特定配置
// ═══════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
  initPlatformPreload({
    name: 'uTools',
    apiKeys: ['hostTools', 'utools'],
    userFnName: 'getUtoolsUser',
    contactUrl: 'https://qm.qq.com/q/8mY7o7ZJx1',
  });
}
