/**
 * verify-security-hardening.mjs
 *
 * 对「限制 preload 暴露面与 Web 端 ?img= 外部源加载」两项加固做回归自验。
 * 纯 Node 运行，不依赖浏览器或 Electron：
 *
 *   1. Web 端 ?img= 校验逻辑（直接调用 imageSourceGuard.mjs 的纯函数）
 *   2. preload 路径白名单逻辑（在伪造的 window/electron 环境里加载 preloadHelpers）
 *   3. 静态断言：preload 不再把宿主对象挂到页面 window；宿主 plugin.json 不再声明
 *      不生效的 contextIsolation / nodeIntegration 死配置
 *
 * 用法：node scripts/verify-security-hardening.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * 粗略剥离注释后再做代码级断言。
 *
 * 注释里常常会写「不再嗅探 window.utools」这类说明，直接做正则匹配会把
 * 说明文字也当成违规代码，产生假阳性。这里去掉块注释与行注释，只留代码。
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ══════════════════════════════════════════════════════════════
// 1. 路径白名单（preloadHelpers.cjs）
// ══════════════════════════════════════════════════════════════

section('1. preload 路径白名单');

// 构造一个最小的伪造环境来加载 CommonJS 的 preloadHelpers.cjs。
// 它 require('electron') 只为拿 contextBridge / clipboard / nativeImage，
// 这里给出最小替身即可让模块正常加载。
const stubElectron = {
  clipboard: { writeImage: () => {} },
  nativeImage: { createFromBuffer: () => ({}) },
  contextBridge: {
    exposeInMainWorld: (key, value) => {
      globalThis.__bridgeCalls = globalThis.__bridgeCalls || [];
      globalThis.__bridgeCalls.push({ key, value });
    },
  },
};

const ModuleProto = require('node:module').prototype;
const originalLoad = ModuleProto.require;
ModuleProto.require = function patchedRequire(id) {
  if (id === 'electron') return stubElectron;
  return originalLoad.apply(this, arguments);
};

// preloadHelpers 在加载期就会读 process 上的若干环境变量，但所有 setup 函数
// 都要求 window 存在；这里在加载后手工构造 window 再调用 initPreload。
globalThis.window = globalThis.window || {};
globalThis.window.hostTools = {
  showOpenDialog: () => null,
  showSaveDialog: () => null,
};
// openHostExternal 在没有宿主 shellOpenExternal 时会退回 window.open，
// 这里给一个空实现，避免真实调用把测试进程打断。
globalThis.window.open = () => null;

// core/package.json 声明了 "type": "module"，直接 require 源码会被当成 ESM。
// 但 preload 在真实运行时是 CommonJS（见 AGENTS.md §5.5：dist 中由 Electron
// 的 require() 加载），因此这里把源码复制成 .cjs 再加载，与产物形态一致。
const preloadSrcPath = path.join(ROOT, 'core', 'src', 'preloadHelpers.cjs');
const tmpPreloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-toolbox-preload-'));
const tmpPreloadPath = path.join(tmpPreloadDir, 'preloadHelpers.cjs');
fs.copyFileSync(preloadSrcPath, tmpPreloadPath);

const preloadHelpers = require(tmpPreloadPath);

let preloadLoadError = null;
try {
  preloadHelpers.initPreload({
    getName: () => 'TestHost',
    getApiKeys: () => ['hostTools'],
    getUserFnName: () => 'getTestUser',
    getContactUrl: () => '',
  });
} catch (e) {
  preloadLoadError = e;
}

check('preloadHelpers 可正常初始化', preloadLoadError === null,
  preloadLoadError ? preloadLoadError.message : '');

const win = globalThis.window;

// —— 未授权路径必须被拒绝 ——
const outsidePath = path.join(os.homedir(), 'definitely-not-authorized-77.txt');

check('readBinaryFile 拒绝未授权路径',
  win.readBinaryFile(outsidePath) === null);
check('writeBinaryFile 拒绝未授权路径',
  win.writeBinaryFile(outsidePath, new ArrayBuffer(4)) === false);
check('readImageFile 拒绝未授权路径',
  win.readImageFile(outsidePath) === null);
check('writeImageFile 拒绝未授权路径',
  win.writeImageFile(outsidePath, 'data:image/png;base64,AAAA') === false);
check('installFont 拒绝未授权路径',
  win.installFont(outsidePath) === false);
check('detectFontName 拒绝未授权路径',
  win.detectFontName(outsidePath) === null);

// —— 路径穿越必须被拒绝（字符串匹配会被绕过，这里验证 resolve 后判定）——
const traversal = path.join(os.homedir(), 'allowed-dir', '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts');
check('含 .. 的穿越路径同样被拒绝',
  win.readBinaryFile(traversal) === null);

// —— 授权后必须放行 ——
// 通过 save 对话框返回一个真实临时文件路径来授权，再验证可读可写。
// 用 .png 而非 .bin：写盘接口的扩展名白名单只允许图片与 ORA 工程（见 WRITABLE_EXTENSIONS）。
const tmpFile = path.join(os.tmpdir(), 'img-toolbox-verify-77.png');
try { fs.writeFileSync(tmpFile, Buffer.from('hello')); } catch (e) { /* ignore */ }

globalThis.window.hostTools.showOpenDialog = () => tmpFile;
const authorized = win.showOpenDialog({ properties: ['openFile'] });
check('showOpenDialog 返回用户选定路径', authorized === tmpFile);

// —— V4：打开对话框的 options 白名单透传 ——
// 页面曾可逐字透传 options，把 defaultPath 指到任意目录（引导用户在
// 错误位置确认）、用 title/buttonLabel 伪装对话框文案。
let receivedOpenOptions = null;
globalThis.window.hostTools.showOpenDialog = (opts) => {
  receivedOpenOptions = opts;
  return tmpFile;
};
win.showOpenDialog({
  properties: ['openFile', 'multiSelections'],
  filters: [{ name: '图片', extensions: ['png'] }],
  defaultPath: path.join(os.homedir(), '.ssh'),
  title: '伪装的对话框标题',
  buttonLabel: '立即授权',
});
check('V4: defaultPath 不透传给宿主', !receivedOpenOptions || receivedOpenOptions.defaultPath === undefined,
  `实际 defaultPath=${receivedOpenOptions && receivedOpenOptions.defaultPath}`);
check('V4: title 不透传给宿主', !receivedOpenOptions || receivedOpenOptions.title === undefined,
  `实际 title=${receivedOpenOptions && receivedOpenOptions.title}`);
check('V4: buttonLabel 不透传给宿主', !receivedOpenOptions || receivedOpenOptions.buttonLabel === undefined,
  `实际 buttonLabel=${receivedOpenOptions && receivedOpenOptions.buttonLabel}`);
check('V4: properties/filters 正常透传（不误伤功能）',
  receivedOpenOptions
  && Array.isArray(receivedOpenOptions.properties)
  && receivedOpenOptions.properties.includes('openFile')
  && Array.isArray(receivedOpenOptions.filters)
  && receivedOpenOptions.filters[0] && receivedOpenOptions.filters[0].name === '图片');

// —— V4 后半段：宿主返回对象不整体回传，只提取干净路径结构 ——
globalThis.window.hostTools.showOpenDialog = () => ({
  canceled: false,
  filePaths: [tmpFile],
  __hostInternalProbe: 'host-secret-method-ref',
});
const sanitizedResult = win.showOpenDialog({ properties: ['openFile'] });
check('V4: 返回对象不携带宿主内部字段',
  sanitizedResult && sanitizedResult.__hostInternalProbe === undefined,
  `实际=${Object.keys(sanitizedResult || {}).join(',')}`);
check('V4: 返回对象仍保留 filePaths（功能不回归）',
  sanitizedResult && Array.isArray(sanitizedResult.filePaths)
  && sanitizedResult.filePaths[0] === tmpFile);

const readBack = win.readBinaryFile(tmpFile);
check('授权后 readBinaryFile 可读取', readBack !== null && readBack.byteLength === 5);

const writeOk = win.writeBinaryFile(tmpFile, Buffer.from('world').buffer);
check('授权后 writeBinaryFile 可写入', writeOk === true);

// —— 授权目录内的兄弟路径不得越界 ——
// 验证用 path.relative 而不是字符串前缀匹配：'tmp-evil' 不应被当成 'tmp' 之内。
const siblingDir = `${os.tmpdir()}-evil`;
const siblingFile = path.join(siblingDir, 'x.bin');
check('前缀相似的兄弟目录不被误放行',
  win.readBinaryFile(siblingFile) === null);

// —— 对话框建议名不得让默认路径逃出目标目录 ——
// suggestedName 由页面完全控制，path.join 会吃掉其中的 '..'，
// 若不净化即可把 defaultPath 指到任意位置，用户回车后该路径就被授权。
//
// 断言用「净化后的精确文件名」而非只看 dirname：净化函数被删空时，
// 目录兜底断言会把 defaultPath 拉回 ~/Desktop（得到兜底名而非
// 期望文件名），只查 dirname 会误判为通过 —— 变异自验要求套件
// 对「净化函数失效」也必须变红，见 mutation-check-sanitizers.mjs。
const desktopDir = path.join(os.homedir(), 'Desktop');
const escapePayloads = [
  ['Windows 分隔符逃逸', '..\\..\\..\\..\\Windows\\System32\\pwn.png'],
  ['POSIX 分隔符逃逸', '../../../../etc/passwd'],
  ['指向 ssh 目录', '..\\.ssh\\authorized_keys'],
];
for (const [label, payload] of escapePayloads) {
  globalThis.window.hostTools.showSaveDialog = (opts) => opts.defaultPath;
  const escaped = win.showSaveImageDialog(payload);
  const expected = path.join(desktopDir, path.posix.basename(payload.replace(/\\/g, '/')));
  check(`保存对话框默认路径不被「${label}」带出目标目录`,
    escaped === expected,
    `期望=${expected}，实际 defaultPath=${escaped}`);
}
// ORA 保存走同一个净化路径，单独验一次
globalThis.window.hostTools.showSaveDialog = (opts) => opts.defaultPath;
const oraEscaped = win.showSaveOraDialog('..\\..\\..\\evil.ora');
check('ORA 保存对话框默认路径不被带出目标目录',
  oraEscaped === path.join(desktopDir, 'evil.ora'),
  `期望=${path.join(desktopDir, 'evil.ora')}，实际=${oraEscaped}`);

// —— 字体目录是「只读」授权，绝不能被当作可写目录 ——
// 这是关键回归项：getFontsDirectory 曾把系统字体目录注入可写白名单，
// 页面调用一次字体枚举即可写入字体目录（macOS/Linux 上该目录用户可写）。
const fontsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'img-toolbox-fonts-'));
const fakeSystemRoot = path.join(fontsRoot, 'winroot');
fs.mkdirSync(path.join(fakeSystemRoot, 'Fonts'), { recursive: true });
const savedWindir = process.env.WINDIR;
process.env.WINDIR = fakeSystemRoot;

const fontsDirs = win.getFontsDirectory();
check('getFontsDirectory 返回字体目录', Array.isArray(fontsDirs) && fontsDirs.length > 0,
  JSON.stringify(fontsDirs));

const fontDirPath = fontsDirs[0];
check('枚举字体后仍可读取字体目录内文件（只读不回归）', (() => {
  const probe = path.join(fontDirPath, 'probe.ttf');
  fs.writeFileSync(probe, Buffer.from('fontdata'));
  return win.readBinaryFile(probe) !== null;
})());

check('枚举字体后不得写入字体目录（.dll 任意扩展名）',
  win.writeBinaryFile(path.join(fontDirPath, 'evil.dll'), Buffer.from('MZ').buffer) === false);
check('枚举字体后不得写入字体目录（.png 也在白名单扩展名内）',
  win.writeImageFile(path.join(fontDirPath, 'x.png'), 'data:image/png;base64,AAAA') === false);

process.env.WINDIR = savedWindir;

// —— 写盘扩展名白名单：已授权的 .ora 可写，可执行扩展名不可写 ——
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-toolbox-ext-'));
globalThis.window.hostTools.showSaveDialog = () => path.join(extDir, 'project.ora');
const oraPath = win.showSaveOraDialog('project.ora');
check('已授权的 .ora 可正常写入（不误伤正常导出）',
  win.writeBinaryFile(oraPath, Buffer.from('ora').buffer) === true);

globalThis.window.hostTools.showSaveDialog = (opts) => opts.defaultPath;
const dllPath = win.showSaveImageDialog('payload.dll');
check('可执行扩展名即使被授权也拒绝写入',
  win.writeBinaryFile(dllPath, Buffer.from('MZ').buffer) === false);

// —— installFont 必须校验文件内容，仅改扩展名不得通过 ——
const fakeFontPath = path.join(extDir, 'not-a-font.woff');
fs.writeFileSync(fakeFontPath, Buffer.from('THIS IS PLAIN TEXT, NOT A FONT'));
globalThis.window.hostTools.showOpenDialog = () => fakeFontPath;
win.showOpenDialog({ properties: ['openFile'] });
check('installFont 拒绝「扩展名是字体但内容不是」的文件',
  win.installFont(fakeFontPath) === false);

// —— 外部链接只允许 http(s) ——
check('openHostExternal 拒绝 file: 协议',
  win.openHostExternal('file:///C:/Windows/System32/calc.exe') === false);
check('openHostExternal 拒绝自定义 URI scheme',
  win.openHostExternal('ms-settings:') === false);
check('openHostExternal 放行 https（不误伤正常外链）',
  win.openHostExternal('https://example.com/ok') === true);

// —— 未被授权写入的路径不得因 mkdirSync 而产生空目录 ——
const ghostDir = path.join(os.tmpdir(), `img-toolbox-ghost-${Date.now()}`);
win.writeBinaryFile(path.join(ghostDir, 'x.png'), Buffer.from('x').buffer);
check('越权写入不产生空目录残留', fs.existsSync(ghostDir) === false);

// —— 页面全局不得再挂宿主对象 ——
check('页面 window 不再被补挂 hostTools 别名（未新增宿主键）',
  typeof win.utools === 'undefined' && typeof win.ztools === 'undefined');

// ══════════════════════════════════════════════════════════════
// 2. Web 端 ?img= 来源校验
// ══════════════════════════════════════════════════════════════

section('2. Web 端 ?img= 协议/来源校验');

// imageSourceGuard.js 是 ESM，用动态 import 从源码加载
const guardPath = path.join(ROOT, 'clients', 'web', 'src', 'imageSourceGuard.js');
const guard = await import(`file://${guardPath.replace(/\\/g, '/')}`);

const PAGE = 'https://toolbox.example.com/editor/index.html';

const rejectCases = [
  ['http:// 明文外部源', 'http://evil.example.net/x.png'],
  ['javascript: 伪协议', 'javascript:alert(1)'],
  ['file: 本地文件', 'file:///C:/Windows/win.ini'],
  ['ftp: 协议', 'ftp://evil.example.net/x.png'],
  ['data:text/html', 'data:text/html;base64,PHNjcmlwdD4='],
  ['协议走私（内嵌换行）', 'java\nscript:alert(1)'],
  ['空字符串', '   '],
];

for (const [label, value] of rejectCases) {
  const r = guard.validateImageSource(value, PAGE);
  check(`拒绝：${label}`, r.ok === false, `实际 reason=${r.reason}`);
}

const acceptCases = [
  ['同源相对路径', 'images/pic.png'],
  ['同源根路径', '/assets/a.jpg'],
  ['同源绝对地址', 'https://toolbox.example.com/a.png'],
  ['data:image base64', 'data:image/png;base64,iVBORw0KGgo='],
  ['blob: URL', 'blob:https://toolbox.example.com/uuid'],
  // 跨源 https 一律放行（经确认的安全模型，见 imageSourceGuard.js 文件头）；
  // 图床不支持 CORS 时由浏览器拦截加载，不构成可利用面。
  ['跨源 https 外部图片', 'https://cdn.example.org/pic.png'],
  ['协议相对 // 跨源（解析为 https）', '//cdn.example.org/pic.png'],
];

for (const [label, value] of acceptCases) {
  const r = guard.validateImageSource(value, PAGE);
  check(`放行：${label}`, r.ok === true, `实际 reason=${r.reason}`);
}

// —— 拒绝时不得写入 __imageSource ——
const fakeWin = {};
const applied = guard.applyImageSourceParam('http://evil.example.net/x.png', fakeWin);
check('被拒绝的参数不写入 __imageSource',
  applied.ok === false && fakeWin.__imageSource === undefined);

const appliedOk = guard.applyImageSourceParam('/local.png', fakeWin, PAGE);
check('合规参数正常写入 __imageSource',
  appliedOk.ok === true && fakeWin.__imageSource === 'https://toolbox.example.com/local.png');

// —— blob: 必须限同源，不能成为唯一的「不做来源校验」通道 ——
const blobRejectCases = [
  ['blob: 跨源 origin', 'blob:https://evil.example.net/uuid'],
  ['blob: 空 origin', 'blob:null/abc'],
  ['blob: 明文 http 跨源', 'blob:http://127.0.0.1:8000/x'],
  ['blob: 同域但端口不同', 'blob:https://toolbox.example.com:8080/uuid'],
];
for (const [label, value] of blobRejectCases) {
  const r = guard.validateImageSource(value, PAGE);
  check(`拒绝：${label}`, r.ok === false, `实际 reason=${r.reason}`);
}
check('放行：同源 blob URL（不误伤站内 Blob）',
  guard.validateImageSource('blob:https://toolbox.example.com/uuid', PAGE).ok === true);

// ══════════════════════════════════════════════════════════════
// 3. 静态断言：暴露面与宿主隔离配置
// ══════════════════════════════════════════════════════════════

section('3. 静态断言');

const preloadSrc = fs.readFileSync(preloadSrcPath, 'utf8');

check('preload 使用 contextBridge.exposeInMainWorld',
  /contextBridge\.exposeInMainWorld/.test(preloadSrc));
check('preload 不再把宿主对象回写 window.hostTools（代码级）',
  !/window\.hostTools\s*=\s*api/.test(stripComments(preloadSrc)));
check('页面 API 走白名单清单 PAGE_API_NAMES',
  /PAGE_API_NAMES\s*=\s*\[/.test(preloadSrc));

const webIndexSrc = fs.readFileSync(path.join(ROOT, 'clients', 'web', 'src', 'index.js'), 'utf8');
check('Web 入口不再直接赋值 __imageSource',
  !/window\.__imageSource\s*=\s*imgSrc/.test(webIndexSrc));
check('Web 入口调用来源校验函数',
  /applyImageSourceParam/.test(webIndexSrc));

// 各宿主 plugin.json 的 pluginSetting：**不要**在这里断言 contextIsolation === true。
//
// 历史事故：本套件曾断言 plugin.json 里 pluginSetting.contextIsolation === true 并
// 据此认为「页面拿不到宿主全量 API」，从而给出虚假安全感。实际上 uTools 在创建
// 插件窗口时把 webPreferences 写死为字面量对象（contextIsolation: !1），
// 只在存在 preload 时补一项 preload，从不合并 pluginSetting —— 该字段无人读取。
// ZTools 同族实现，行为一致。
//
// 也就是说：隔离**关闭**是本项目的既定运行前提，页面里 window.hostTools / utools /
// ztools 是可读的。防护不能建立在「隔离存在」这个不成立的前提上，必须落在
// 「页面源码不主动读宿主原始对象」这一真实可控的约束上（由下方 core 遍历断言保障）。
for (const platform of ['utools', 'ztools']) {
  const manifestPath = path.join(ROOT, 'clients', platform, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const setting = manifest.pluginSetting || {};

  // pluginSetting 里不得再出现 contextIsolation / nodeIntegration。
  //
  // uTools 的插件加载代码只从 pluginSetting 里取这几个键（已反查 7.8.0 的
  // dist/main.js）：single / height / outKill / enterDetach / runAtAppOpen /
  // mainPushPower，然后整体替换内部配置对象。contextIsolation 与
  // nodeIntegration 不在白名单内 —— 窗口的 webPreferences 在另一处被写死为
  // contextIsolation: !1（关闭），与 plugin.json 无关。
  //
  // 也就是说这两个字段是「死配置」：写了不会生效，却会让审阅者以为隔离已开启。
  // 断言它们缺席，避免后来者重新写回去。
  for (const deadKey of ['contextIsolation', 'nodeIntegration']) {
    check(`${platform} plugin.json 不再声明无效的 ${deadKey}`,
      !Object.prototype.hasOwnProperty.call(setting, deadKey),
      `实际 = ${JSON.stringify(setting[deadKey])}（宿主不读取该字段，写了不生效反而误导）`);
  }
}

// preload 必须显式探测隔离状态，而不是「contextBridge 存在就桥接」。
// 否则 uTools 每次初始化都会刷出 contextBridge 报错噪音，掩盖真正的 preload 告警。
const preloadBridgeSrc = fs.readFileSync(preloadSrcPath, 'utf8');
check('preload 显式探测 contextIsolation 后再桥接',
  /_isContextIsolationEnabled\s*\(/.test(preloadBridgeSrc));
check('preload 用 process.contextIsolated 作为权威信号',
  /process\.contextIsolated/.test(preloadBridgeSrc));

// 页面源码不得再直接引用宿主原始对象
const coreDir = path.join(ROOT, 'core', 'src');
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const offenders = [];
for (const file of walk(coreDir)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // 两处允许的例外：
  //  - utils/host.js：兼容探测，已加注释说明
  //  - preloadHelpers.cjs：preload 自身，宿主对象本就存在于它的世界里
  if (rel.endsWith('utils/host.js') || rel.endsWith('preloadHelpers.cjs')) continue;
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  if (/window\.(hostTools|utools|ztools)\b/.test(src)) offenders.push(rel);
}
check('core 页面代码不再直接读宿主原始对象',
  offenders.length === 0, offenders.join(', '));

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════

ModuleProto.require = originalLoad;

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
