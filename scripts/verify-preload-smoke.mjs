/**
 * verify-preload-smoke.mjs — preload bundle 运行时冒烟门禁（build.mjs 门禁 3b，Electron 端）
 *
 * 为什么需要它：node --check 只证明语法，页面 bundle 的 smoke 不经过 preload。
 * "commonjs-variable-in-esm" 这一类缺陷（type:module 包内的 CJS 文件被按 ESM
 * 解析，module.exports 被当成全局赋值）产出的 bundle 语法完全合法，运行时
 * initPlatformPreload 却是 undefined——只有真机进插件才会炸。
 *
 * 为什么要测「隔离关闭」这一分支：uTools / ZTools 把插件窗口的
 * contextIsolation 写死为 false，却仍然在 preload 里提供 contextBridge 对象，
 * 该对象在被调用时才抛「contextBridge API can only be used when
 * contextIsolation is enabled」。历史上 preload 只看「contextBridge 存在」就
 * 桥接，于是 uTools 每次启动都刷两条 error（缺陷卡 t-mujptm4h-wluvri）。
 * 修复方式是在桥接前用 process.contextIsolated 探测隔离状态。若哪天有人把
 * 这段探测删掉或改坏，只测「隔离开启」分支的门禁会继续全绿——因此本脚本
 * 必须在宿主真实形态（隔离关闭）下断言「一次 contextBridge 都不许调」。
 *
 * 三个场景各跑一个独立子进程（模块级状态互不污染）：
 *   isolated-off      隔离关闭（uTools / ZTools 真实形态）：不得桥接、不得打
 *                     contextBridge 噪音、window API 必须已直接挂载
 *   isolated-unknown  宿主未提供 process.contextIsolated（旧 Electron）：按关闭处理
 *   isolated-on       隔离开启：必须真的桥接，证明 initPlatformPreload 链路跑通
 *
 * 另有变异自验：把产物里的隔离探测分支改成恒不返回，隔离关闭场景必须被捕获，
 * 否则说明断言是空洞的（与门禁 5/6/7 的变异自验同一思路）。
 *
 * Usage: node scripts/verify-preload-smoke.mjs <dist/<platform>/preload.js 的绝对路径>
 * Exit:  0 通过；1 失败；2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(selfPath), '..');
const RESULT_PREFIX = '__PRELOAD_SMOKE__ ';

// 产物里隔离探测分支的锚点。esbuild 产出的形态稳定为这一行；若哪天变了，
// 变异自验会判失败并提示同步——静默失配的自验比没有自验更危险。
const ISOLATION_BRANCH_ANCHOR = 'if (!_isContextIsolationEnabled(electron)) {';

const target = process.argv[2];
const scenarioArg = process.argv[3];

if (scenarioArg) {
  // 子进程模式：只跑一个场景并汇报事实，判定交给父进程。
  await runScenario(target, scenarioArg);
} else {
  if (!target || !path.isAbsolute(target)) {
    console.error('用法: node scripts/verify-preload-smoke.mjs <preload.js 绝对路径>');
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error('FAIL: 找不到 preload 产物 — ' + target);
    process.exit(1);
  }
  main(target);
}

/**
 * 在伪造的 electron + window 环境里 require 一次产物，汇报可观测事实。
 * @param {string} filePath - 被测 preload 产物（可能是变异副本）
 * @param {string} scenario - isolated-off | isolated-unknown | isolated-on
 */
async function runScenario(filePath, scenario) {
  const isolationOn = scenario === 'isolated-on';
  const bridge = [];
  const noop = () => {};

  // electron 替身：preloadHelpers require('electron') 只为拿 contextBridge /
  // clipboard / nativeImage / ipcRenderer，与 verify-security-hardening 同形态。
  // exposeInMainWorld 刻意按真实 Electron 的行为在隔离关闭时抛错：这样「误调
  // contextBridge」既会被 bridgeCalls 记到，也会以 error 日志出现，两条断言
  // 互为佐证，不依赖单一口径。
  const stubElectron = {
    clipboard: { writeImage: noop, readImage: () => ({ isEmpty: () => true }), writeText: noop, readText: () => '' },
    nativeImage: {
      createFromBuffer: () => ({ toDataURL: () => 'data:,' }),
      createFromPath: () => ({ toDataURL: () => 'data:,' })
    },
    contextBridge: {
      exposeInMainWorld: (key, value) => {
        if (!isolationOn) {
          throw new Error('contextBridge API can only be used when contextIsolation is enabled');
        }
        bridge.push({ key, type: typeof value });
      }
    },
    ipcRenderer: { on: noop, once: noop, off: noop, send: noop, sendSync: () => ({}), invoke: async () => ({}) },
    shell: { openExternal: () => Promise.resolve() }
  };
  const origLoad = Module._load;
  Module._load = function(request, ...rest) {
    if (request === 'electron') {
      return stubElectron;
    }
    return origLoad.call(this, request, ...rest);
  };

  // 最小宿主环境：DOM/window 桩件复用 test-env；hostTools 是 apiKeys 的第一优先级。
  const { installTestEnvironment } = await import(pathToFileURL(path.join(root, 'scripts', 'test-env.mjs')).href);
  installTestEnvironment();
  globalThis.window = globalThis.window || {};
  globalThis.window.hostTools = { showOpenDialog: () => null, showSaveDialog: () => null };
  if (typeof globalThis.window.open !== 'function') {
    globalThis.window.open = () => null;
  }

  if (scenario === 'isolated-off') {
    process.contextIsolated = false;
  } else if (scenario === 'isolated-on') {
    process.contextIsolated = true;
  } else {
    try {
      delete process.contextIsolated;
    } catch (e) {
      // Electron 的 process 可能把该属性定义成不可删除，置 undefined 等价于缺失
      process.contextIsolated = undefined;
    }
  }

  // 捕获 preload 侧所有日志，供父进程断言「隔离关闭时不得出现 contextBridge 噪音」
  const logs = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => logs.push('ERROR ' + args.map(String).join(' '));
  console.warn = (...args) => logs.push('WARN ' + args.map(String).join(' '));

  const requireCjs = createRequire(import.meta.url);
  let threw = null;
  try {
    requireCjs(filePath);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  } finally {
    console.error = origError;
    console.warn = origWarn;
    Module._load = origLoad;
  }

  const result = {
    scenario,
    threw,
    bridgeCalls: bridge.length,
    logs,
    // 隔离关闭时页面与 preload 同世界，API 必须已经直接挂在 window 上
    hasDirectApi: typeof globalThis.window.getPluginVersion === 'function'
      && typeof globalThis.window.getHostName === 'function',
    hasBridgeMarker: '__imageToolboxApiBridge' in globalThis.window
  };
  process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n');
  process.exit(0);
}

/** 起一个子进程跑单个场景，返回其汇报的事实。 */
function runChild(filePath, scenario) {
  const child = spawnSync(process.execPath, [selfPath, filePath, scenario], {
    encoding: 'utf8',
    timeout: 60000
  });
  if (child.error) {
    console.error('FAIL: 无法启动场景子进程（' + scenario + '）— ' + child.error.message);
    process.exit(1);
  }
  const line = (child.stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith(RESULT_PREFIX))
    .pop();
  if (!line) {
    console.error('FAIL: 场景 ' + scenario + ' 未汇报结果（exit ' + child.status + '）');
    if (child.stdout) {
      console.error(child.stdout.split('\n').slice(-10).join('\n'));
    }
    if (child.stderr) {
      console.error(child.stderr.split('\n').slice(-10).join('\n'));
    }
    process.exit(1);
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

/** 隔离关闭 / 未知时的共同断言。 */
function assertNoBridging(result, label) {
  const problems = [];
  if (result.threw) {
    problems.push('require() 抛出异常：' + result.threw);
  }
  if (result.bridgeCalls !== 0) {
    problems.push('隔离关闭时仍调用了 contextBridge（' + result.bridgeCalls + ' 次）——'
      + '宿主会抛「contextBridge API can only be used when contextIsolation is enabled」并刷屏');
  }
  const noise = result.logs.filter((l) => /contextBridge/i.test(l));
  if (noise.length > 0) {
    problems.push('隔离关闭时打印了 contextBridge 相关日志：' + noise.join(' | '));
  }
  if (!result.hasDirectApi) {
    problems.push('隔离关闭时 window API 未直接挂载（页面将拿不到宿主能力）');
  }
  if (result.hasBridgeMarker) {
    problems.push('隔离关闭时仍设置了 __imageToolboxApiBridge 桥接标记');
  }
  if (problems.length > 0) {
    console.error('FAIL [' + label + ']：');
    for (const p of problems) {
      console.error('      - ' + p);
    }
    process.exit(1);
  }
  console.log('OK [' + label + ']：隔离未启用，未调用 contextBridge，window API 直接可用');
}

/**
 * 变异自验：把产物里的隔离探测分支改成恒不返回（即回到「只看 contextBridge
 * 存在就桥接」的旧行为），隔离关闭场景必须报出问题。若变异后仍然全绿，
 * 说明断言没有真正覆盖这条路径。
 */
function mutationSelfCheck(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(ISOLATION_BRANCH_ANCHOR)) {
    console.error('FAIL: 变异自验锚点失配 — 产物中找不到：' + ISOLATION_BRANCH_ANCHOR);
    console.error('      说明 preloadHelpers 的隔离探测分支被重构或产物格式变了。');
    console.error('      请同步更新本脚本的 ISOLATION_BRANCH_ANCHOR，不要直接删掉变异自验。');
    process.exit(1);
  }
  const mutatedPath = path.join(path.dirname(filePath), '.preload-mutation-' + process.pid + '.js');
  const mutated = source.replace(ISOLATION_BRANCH_ANCHOR, 'if (!1) {');
  fs.writeFileSync(mutatedPath, mutated, 'utf8');
  try {
    const result = runChild(mutatedPath, 'isolated-off');
    const caught = result.bridgeCalls > 0
      || Boolean(result.threw)
      || result.logs.some((l) => /contextBridge/i.test(l));
    if (!caught) {
      console.error('FAIL: 变异自验未通过 — 删掉隔离探测分支后，隔离关闭场景仍然全绿。');
      console.error('      这说明「不得调用 contextBridge」的断言是空洞的，请检查断言口径。');
      process.exit(1);
    }
    console.log('OK [mutation]：删掉隔离探测分支后，隔离关闭场景被正确判红（断言可证伪）');
  } finally {
    try {
      fs.unlinkSync(mutatedPath);
    } catch (e) {
      // 清理失败不影响结论
    }
  }
}

function main(filePath) {
  console.log('preload 冒烟：' + filePath);

  const off = runChild(filePath, 'isolated-off');
  assertNoBridging(off, 'isolated-off');

  const unknown = runChild(filePath, 'isolated-unknown');
  assertNoBridging(unknown, 'isolated-unknown');

  const on = runChild(filePath, 'isolated-on');
  if (on.threw) {
    console.error('FAIL [isolated-on]：require() 抛出异常 — ' + on.threw);
    process.exit(1);
  }
  if (on.bridgeCalls === 0) {
    console.error('FAIL [isolated-on]：require() 成功但 exposeInMainWorld 一次都没被调用 —');
    console.error('      initPlatformPreload 没有真正执行（常见根因：CJS/ESM interop 空壳，');
    console.error('      检查 esbuild 是否报 commonjs-variable-in-esm 类警告）。');
    process.exit(1);
  }
  console.log('OK [isolated-on]：真实宿主桥接了 ' + on.bridgeCalls + ' 个 API');

  mutationSelfCheck(filePath);

  console.log('OK: preload 冒烟通过（隔离关闭 / 未声明 / 开启 三态 + 变异自验）');
}
