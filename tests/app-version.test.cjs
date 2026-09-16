/**
 * 插件版本号来源回归测试
 *
 * 背景：同一份代码曾存在两个互不一致的版本号，且用户可见的版本取的是错误那个。
 *   clients/utools/plugin.json  "version": "2.3.2"   <- 应用市场读取的发布版本
 *   core/src/updateRecords.js[0].version "1.2.3"     <- 更新记录首条，被当作「当前版本」
 *   AccountPage._getCurrentVersion() 取 updateRecords[0].version，
 *   于是市场显示 2.3.2、插件内「关于」页却显示 v1.2.3，用户误以为版本回滚。
 *
 * 本测试锁定三条不变量：
 *   1. 版本号只有一个权威来源（core/src/changelog.js 的 APP_VERSION），
 *      且 plugin.json / package.json / 更新记录首条 / 文档声明全部与它一致；
 *   2. 「关于」页的版本号来自宿主透传的真实插件版本，不是更新记录首条；
 *   3. preload 暴露的 window.getPluginVersion() 读的是插件目录下的 plugin.json。
 *
 * 运行：node tests/app-version.test.cjs [项目根目录]
 * 依赖：仅 Node 内置模块（无需安装依赖）。
 * 前置：先执行 .\build.ps1（测试读取构建产物，与 tests/ 下其他测试一致）。
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
const readJson = (relPath) => JSON.parse(read(relPath));

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

const run = async () => {
  // ═══ 1. 单一权威版本：所有声明点必须一致 ═══

  const { APP_VERSION, CHANGELOG, getAppVersion } = await import(
    url.pathToFileURL(path.join(root, 'core/src/changelog.js')).href
  );
  const version = APP_VERSION;

  check('APP_VERSION 存在且形如 x.y.z', /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(version), version);
  check('getAppVersion() 返回 APP_VERSION', getAppVersion() === version, getAppVersion());

  const utoolsPlugin = readJson('clients/utools/plugin.json');
  const ztoolsPlugin = readJson('clients/ztools/plugin.json');
  const pkg = readJson('package.json');

  check('uTools plugin.json 版本与 APP_VERSION 一致', utoolsPlugin.version === version, utoolsPlugin.version + ' vs ' + version);
  check('ZTools plugin.json 版本与 APP_VERSION 一致', ztoolsPlugin.version === version, ztoolsPlugin.version + ' vs ' + version);
  check('package.json 版本与 APP_VERSION 一致', pkg.version === version, pkg.version + ' vs ' + version);
  check('更新记录首条与 APP_VERSION 一致', CHANGELOG[0].version === version, CHANGELOG[0].version + ' vs ' + version);

  // 更新记录自身的完整性：版本号不得重复、按新到旧排列
  const versions = CHANGELOG.map((r) => r.version);
  check('更新记录无重复版本号', new Set(versions).size === versions.length, versions.join(','));
  check('更新记录首条即最新版本', versions[0] === version, versions[0]);

  // ═══ 2. 「关于」页不再把更新记录首条当版本号 ═══

  const accountSrc = read('core/src/ui/AccountPage.js');

  check(
    'AccountPage 不再直接读 updateRecords',
    !/updateRecords/.test(accountSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))
  );
  check(
    'AccountPage 的 _getCurrentVersion 不再取更新记录首条',
    !/_getCurrentVersion[\s\S]{0,400}CHANGELOG\s*\??\.\s*\[\s*0\s*\]/.test(accountSrc)
  );
  check(
    'AccountPage 从 HostAdapter 读插件版本',
    /_getHostPluginVersion[\s\S]{0,300}platform\??\.\s*appVersion/.test(accountSrc)
  );
  check(
    'AccountPage 回退到 getAppVersion() 而非更新记录',
    /_getCurrentVersion[\s\S]{0,600}getAppVersion\(\)/.test(accountSrc)
  );

  // ═══ 3. BaseHostAdapter 暴露 platform.appVersion ═══

  const adapterSrc = read('core/src/adapters/BaseHostAdapter.js');
  check('BaseHostAdapter 声明 getPluginVersion()', /getPluginVersion\s*\(/.test(adapterSrc));
  check('BaseHostAdapter.platform 暴露 appVersion', /appVersion:\s*this\.getPluginVersion\(\)/.test(adapterSrc));
  check(
    'getPluginVersion 不对宿主程序版本兜底',
    !/getPluginVersion\s*\(\s*\)[\s\S]{0,800}getHostAppVersion\(\)/.test(adapterSrc)
  );

  // 在模拟的 uTools 页面环境里真实构造适配器，确认 appVersion 与 version 语义分离
  const hostApi = {
    getAppName: () => 'uTools',
    getAppVersion: () => '9.9.9',
    getUser: () => null,
    onPluginEnter: () => {},
  };
  global.window = { utools: hostApi };
  const { default: UtoolsHostAdapter } = await import(
    url.pathToFileURL(path.join(root, 'dist/uTools/src/adapters/host/UtoolsHostAdapter.js')).href
  );
  const adapter = new UtoolsHostAdapter();
  check('platform.version 是宿主程序版本', adapter.platform.version === '9.9.9', adapter.platform.version);
  check('platform.appVersion 不误取宿主程序版本', adapter.platform.appVersion !== '9.9.9', adapter.platform.appVersion);

  // ═══ 4. preload 透传的真实插件版本来自 plugin.json ═══

  const preloadWindow = { utools: hostApi };
  global.window = preloadWindow;
  withElectronStub(() => {
    delete require.cache[require.resolve(path.join(root, 'dist/uTools/preload.js'))];
    require(path.join(root, 'dist/uTools/preload.js'));
  });

  check('preload 暴露 window.getPluginVersion()', typeof preloadWindow.getPluginVersion === 'function');
  const hostVersion = preloadWindow.getPluginVersion && preloadWindow.getPluginVersion();
  check('window.getPluginVersion() 返回 plugin.json 的真实版本', hostVersion === version, hostVersion + ' vs ' + version);
  check(
    'window.getPluginVersion() 不是宿主程序版本',
    hostVersion !== hostApi.getAppVersion(),
    hostVersion + ' vs ' + hostApi.getAppVersion()
  );

  // 构建产物中的 plugin.json 也必须是当前版本
  const distPlugin = readJson('dist/uTools/plugin.json');
  check('dist/uTools/plugin.json 与 APP_VERSION 一致', distPlugin.version === version, distPlugin.version);

  // ═══ 5. 构建期校验脚本存在且覆盖关键比对点 ═══

  const gateSrc = read('scripts/version-check.ps1');
  check('版本校验脚本存在', gateSrc.length > 0);
  check('校验脚本读取 APP_VERSION', /APP_VERSION/.test(gateSrc));
  check('校验脚本比对 plugin.json', /plugin\.json/.test(gateSrc));
  check('校验脚本比对 package.json', /package\.json/.test(gateSrc));
  check('构建脚本调用版本校验', /\.\s*\(Join-Path \$PSScriptRoot "scripts/.test(read('build.ps1')));

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
