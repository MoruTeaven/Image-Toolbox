/**
 * ZTools 平台判定回归测试
 *
 * 背景：ZTools 端的 preload 曾把 uTools 列为 API 兜底键，preloadHelpers 又会在
 * 命中后把 ZTools API 别名回写成 window.utools，导致页面侧「window.utools 存在
 * 即 uTools」的嗅探把 ZTools 误判成 uTools：
 *   (a) 更新记录按 uTools 过滤，ZTools 专有变更不显示；
 *   (b) 展示「使用 uTools 账号一键登录」并调用 uTools 专有的
 *       fetchUserServerTemporaryServerToken，登录必然失败。
 *
 * 本测试锁定两个不变量：
 *   1. ZTools 环境下不产生 window.utools 别名；
 *   2. 平台判定来自 HostAdapter.platform.id，而不是全局变量嗅探。
 *
 * 运行：node tests/ztools-platform.test.cjs [项目根目录]
 * 依赖：仅 Node 内置模块（无需安装依赖）。
 */

const fs = require('fs');
const path = require('path');
const url = require('url');
const Module = require('module');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail === undefined || detail === null ? '' : String(detail) });
};

const read = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8');

/** electron 替身：preload 需要 clipboard/nativeImage，测试环境没有 Electron */
const withElectronStub = (fn) => {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        clipboard: { writeImage: () => {}, readText: () => '' },
        nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
};

/** 抽取构建产物中的纯函数源码并在受控作用域求值（保证验证的是真实实现） */
const extractFunction = (source, name) => {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('函数体不闭合: ' + name);
};

const run = async () => {
  // ═══ 1. preload 层：不再产生 window.utools 别名 ═══

  const zPreloadSrc = read('dist/zTools/preload.js');
  const uPreloadSrc = read('dist/uTools/preload.js');
  const helpersSrc = read('dist/zTools/core/src/preloadHelpers.js');

  check(
    'ZTools preload 的 apiKeys 不含 utools 兜底',
    !/apiKeys:\s*\[[^\]]*'utools'/.test(zPreloadSrc),
    (zPreloadSrc.match(/apiKeys:[^\n]*/) || [''])[0]
  );
  check(
    'uTools preload 仍保留 utools 键',
    /apiKeys:\s*\[[^\]]*'utools'/.test(uPreloadSrc),
    (uPreloadSrc.match(/apiKeys:[^\n]*/) || [''])[0]
  );
  check('preloadHelpers 不再回写 window.utools 别名', !/window\.utools\s*=\s*api/.test(helpersSrc));

  // 在「只有 window.ztools」的 ZTools 环境里真实执行 preload
  const hostApi = {
    getAppName: () => 'ZTools',
    getAppVersion: () => '1.2.3',
    getUser: () => ({ nickname: 'z-user' }),
    onPluginEnter: () => {},
    onPluginOut: () => {},
  };
  const zWindow = { ztools: hostApi };
  global.window = zWindow;
  withElectronStub(() => {
    delete require.cache[require.resolve(path.join(root, 'dist/zTools/preload.js'))];
    require(path.join(root, 'dist/zTools/preload.js'));
  });

  check('执行 ZTools preload 后 window.utools 未被创建', zWindow.utools === undefined, typeof zWindow.utools);
  check('window.getHostName() 返回 ZTools', zWindow.getHostName && zWindow.getHostName() === 'ZTools', zWindow.getHostName && zWindow.getHostName());
  check('window.getHostAppVersion() 从 ztools API 取值', zWindow.getHostAppVersion && zWindow.getHostAppVersion() === '1.2.3', zWindow.getHostAppVersion && zWindow.getHostAppVersion());
  check('window.getZtoolsUser 返回 ZTools 用户', zWindow.getZtoolsUser && zWindow.getZtoolsUser()?.nickname === 'z-user');
  // 宿主 API 经由 window.ztools 直接命中（getHostTools 是预加载内部函数，不对外暴露）
  check('宿主 API 仍挂在 window.ztools 上', zWindow.ztools === hostApi);

  // uTools 端不回归
  const uApi = { getAppName: () => 'uTools', getUser: () => ({ nickname: 'u' }), onPluginEnter: () => {} };
  const uWindow = { utools: uApi };
  global.window = uWindow;
  withElectronStub(() => {
    delete require.cache[require.resolve(path.join(root, 'dist/uTools/preload.js'))];
    require(path.join(root, 'dist/uTools/preload.js'));
  });
  check('uTools preload 能从 window.utools 取到用户', uWindow.getUtoolsUser && uWindow.getUtoolsUser()?.nickname === 'u');

  // ═══ 2. HostAdapter 层：platform.id 是单一事实来源 ═══

  const zAdapterUrl = url.pathToFileURL(path.join(root, 'dist/zTools/src/adapters/host/ZtoolsHostAdapter.js')).href;
  const uAdapterUrl = url.pathToFileURL(path.join(root, 'dist/uTools/src/adapters/host/UtoolsHostAdapter.js')).href;
  const wAdapterUrl = url.pathToFileURL(path.join(root, 'dist/web/src/adapters/host/WebHostAdapter.js')).href;

  // 最坏情况：ZTools API 已被别名到 window.utools
  global.window = { ztools: hostApi, utools: hostApi };
  const { default: ZAdapter } = await import(zAdapterUrl);
  const zAdapter = new ZAdapter();
  check('ZTools adapter platform.id === ztools', zAdapter.platform.id === 'ztools', zAdapter.platform.id);
  check('ZTools adapter platform.name 不是 uTools', zAdapter.platform.name !== 'uTools', zAdapter.platform.name);

  global.window = { utools: uApi };
  const { default: UAdapter } = await import(uAdapterUrl);
  check('uTools adapter platform.id === utools', new UAdapter().platform.id === 'utools');

  global.window = {};
  const { default: WAdapter } = await import(wAdapterUrl);
  check('web adapter platform.id === web', new WAdapter().platform.id === 'web');

  // ═══ 3. 页面层：更新记录过滤 + 登录入口 gate ═══

  const { PLATFORMS, CHANGELOG } = await import(
    url.pathToFileURL(path.join(root, 'dist/zTools/core/src/changelog.js')).href
  );
  const accountSrc = read('dist/zTools/core/src/ui/AccountPage.js');

  const moduleScope = new Function(
    'PLATFORMS',
    [
      extractFunction(accountSrc, 'inferPlatformFromGlobals'),
      extractFunction(accountSrc, 'toPlatformTokens'),
      extractFunction(accountSrc, 'shouldShowForCurrentPlatform'),
    ].join('\n') + '\nreturn { inferPlatformFromGlobals, toPlatformTokens, shouldShowForCurrentPlatform };'
  )(PLATFORMS);

  const shouldShow = (platforms, id) => moduleScope.shouldShowForCurrentPlatform(platforms, id);
  const isUToolsPlatform = (value) => {
    const tokens = moduleScope.toPlatformTokens(value);
    return tokens.includes('utools') && !tokens.includes('ztools');
  };

  // 平台判定来自 HostAdapter.platform.id
  check('platform.id=ztools 时 ZTools 专属项显示', shouldShow(['ztools'], 'ztools') === true);
  check('platform.id=ztools 时 uTools 专属项隐藏', shouldShow(['utools'], 'ztools') === false);
  check('platform.id=utools 时 uTools 专属项显示', shouldShow(['utools'], 'utools') === true);
  check('platform.id=utools 时 ZTools 专属项隐藏', shouldShow(['ztools'], 'utools') === false);
  check('platform.id=web 时平台专属项均隐藏', shouldShow(['utools'], 'web') === false && shouldShow(['ztools'], 'web') === false);
  check('platforms=null 通用项在所有平台显示', shouldShow(null, 'ztools') === true && shouldShow(null, 'utools') === true);
  check('宿主自报名 ZTools 归一化后匹配 ztools', shouldShow(['ztools'], 'ZTools') === true);
  check('宿主自报名 uTools 归一化后不匹配 ztools', shouldShow(['ztools'], 'uTools') === false);

  // AccountPage 已移除 window 嗅探（ZTools 下 window.utools 可能是别名，
  // contextIsolation 后页面侧也读不到宿主对象）。无平台信息时，
  // 平台专属项一律隐藏，两个宿主都不显示。
  global.window = { ztools: hostApi, utools: hostApi };
  check('无 platform 时不再嗅探，ztools 专属项隐藏', shouldShow(['ztools'], null) === false);
  check('无 platform 时不返回 utools，utools 专属项隐藏', shouldShow(['utools'], null) === false);

  // 真实更新记录数据：ZTools 视角不得出现 uTools 专属项
  const leaked = [];
  CHANGELOG.forEach((record) => {
    Object.entries(record.changes || {}).forEach(([category, items]) => {
      (items || []).forEach((item) => {
        if (typeof item === 'string' || !Array.isArray(item.platforms)) return;
        const utoolsOnly = item.platforms.includes('utools') && !item.platforms.includes('ztools');
        if (utoolsOnly && shouldShow(item.platforms, 'ztools')) {
          leaked.push(record.version + '/' + category + '/' + item.text);
        }
      });
    });
  });
  check('真实更新记录：ZTools 视角无 uTools 专属项泄漏', leaked.length === 0, leaked.join(' | '));

  // 登录入口 gate
  check('ZTools 不展示 uTools 一键登录入口', isUToolsPlatform('ztools') === false);
  check('uTools 展示 uTools 一键登录入口', isUToolsPlatform('utools') === true);
  check('Web 不展示 uTools 一键登录入口', isUToolsPlatform('web') === false);

  // 源码层：登录入口判定与宿主 API 取值都已脱离 window.utools
  check('AccountPage 登录入口不再嗅探 window.utools', !/const isUTools = !!window\.utools/.test(accountSrc));
  check('AccountPage 一键登录 API 取自 HostAdapter', !/const api = window\.utools/.test(accountSrc));

  // ═══ 输出 ═══

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => {
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  });
  console.log('');
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(2);
});
