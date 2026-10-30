/**
 * scripts/build.mjs - the build orchestrator.
 *
 * Replaces build.ps1 (PowerShell). Why this exists as a Node script instead:
 * the whole toolchain is already Node - esbuild, every gate under scripts/, the
 * stubs - so the PowerShell layer only duplicated it and added a second set of
 * rules for text encoding. Those rules were the root cause of the BOM bug class
 * (see scripts/bom-report.ps1): on PowerShell 5.1 both
 * [System.Text.Encoding]::UTF8 and Out-File -Encoding utf8 write a BOM preamble,
 * which is how dist files and even dist/security-gate.log acquired bytes their
 * sources never had. Node writes through esbuild, Copy-Item equivalents and
 * fs.writeFileSync - none of them prepend a preamble, so the class is gone
 * structurally rather than patched call site by call site.
 *
 * Usage:
 *   pnpm build
 *   node scripts/build.mjs [--skip-version-check] [--skip-alias-gate]
 *
 * Note on `pnpm build` vs `node scripts/build.mjs`: pnpm 11 runs a deps-status
 * check before the script, which fails the whole command with
 * ERR_PNPM_IGNORED_BUILDS when a dependency's install script is not approved in
 * pnpm-workspace.yaml's `allowBuilds` (esbuild must be `true` here). The failure
 * happens before any gate runs and says nothing about the code. If you cannot
 * install (read-only or offline worktree), invoking this script directly through
 * node bypasses that check and runs the identical gates.
 *
 * Gates (any failure fails the build, exit 1). The numbers here are the ones the
 * `Gate N` banners below use, and the same order is listed in README.md and
 * AGENTS.md 6.1 - keep all three in step when a gate is added or removed:
 *   0. version-check.mjs up front (source truth) and --dist-only after all
 *      platforms are built (catches a stale dist from an interrupted run).
 *   1. verify-artifact.mjs - esbuild metafile assertions: every bundled input
 *      comes from core/src, clients/, scripts/ or the staging dir, and externals
 *      are only the whitelisted ones.
 *   2. Test-BuildOutput - node --check on the emitted bundles, no unresolved
 *      #core/ anywhere in dist, and no ancestor package.json of preload.js may
 *      declare "type": "module".
 *   3. verify-bundle-smoke.mjs - the page bundle really evaluates under the
 *      Node DOM stubs and mounts fabric 5.3.0.
 *   3b. verify-preload-smoke.mjs (Electron only) - preload.js really require()s
 *       under stubbed electron + window and completes the bridge: catches
 *       "syntactically valid but interop-shell" breakage node --check cannot.
 *       It also pins the host's real shape: uTools/ZTools run with
 *       contextIsolation off, so the preload must not call contextBridge there
 *       at all (otherwise every launch logs "contextBridge API can only be used
 *       when contextIsolation is enabled"). Three isolation states plus a
 *       mutation self-check prove that assertion can fail.
 *   4. verify-web-root-load.mjs (web only) - every first-screen request resolves
 *      on disk from the site root.
 *   5. Security regression gate: verify-security-hardening.mjs AND
 *      mutation-check-sanitizers.mjs, both required. The mutation half proves
 *      the assertions can actually fail - a red-free suite that covers nothing
 *      is the exact failure this pair exists to prevent. Both scripts' complete
 *      output goes to dist/security-gate.log, and a red gate replays that file:
 *      an exit code alone tells a reviewer nothing about which assertion failed.
 *   6. verify-alias-rewrite.mjs - no ../core/src/ rewrite trace or #core/
 *      leftover in the output, no copied core/src tree, #core/ literals survive
 *      bundling verbatim, plus a mutation self-check.
 *   7. verify-clip-path-session.mjs - the canvas-level clipPath session: one
 *      shared session object per canvas. It guards the accident where each of
 *      Mosaic/Crop kept its own backup and restored the other's temporary one,
 *      cutting the layer off for good - a failure that only surfaces later, so
 *      it needs a gate rather than eyeballing.
 *   8. verify-filter-params-table.mjs - the color params table: one definition
 *      per param in utils/filters.js, everything else derived. It asserts the
 *      color UI's slider list equals the table item by item, that no second
 *      hardcoded filter list exists, that presets / thumbnails / highlight all
 *      read the same values, and that filter order does not depend on drag order.
 *   9. bom-report.ps1 - the BOM invariant: nothing in the build may introduce a
 *      UTF-8 BOM. Kept from the PowerShell era and now extended to .log files,
 *      because the security gate writes dist/security-gate.log.
 *  10. verify-doc-refs.mjs - the gate list must match reality in both
 *      directions: every scripts/ path the docs name must exist, and every
 *      script this file spawns must be named in README (and in AGENTS.md when
 *      that local-only file is present). Carries its own falsifiability check.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const DIST_ROOT = path.join(ROOT, 'dist');

// The one place the platform table lives. Client is the source folder, Dist the
// output folder; they differ only in case for the two Electron platforms.
const PLATFORMS = [
  { client: 'utools', dist: 'uTools' },
  { client: 'ztools', dist: 'zTools' },
  { client: 'web', dist: 'web' }
];

const args = new Set(process.argv.slice(2));
let allOk = true;

// Text extensions checked by the BOM report and the alias gate. .log is here
// because the security gate writes dist/security-gate.log - previously the
// report only looked at .js/.html/.css/.json/.txt/.md and a BOM in that log
// reported OK for the whole build.
const TEXT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.txt', '.md', '.log'];

const c = {
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`
};

function log(message) {
  console.log(message);
}

// Runs a command, streams it verbatim, and returns the exit code. Unlike a
// bare spawnSync with stdio:'pipe' this keeps gate output live so a long build
// does not look hung.
//
// No shell, ever. With shell:true on Windows Node joins argv into one string
// and hands it to cmd.exe, which splits on spaces - and this repo lives at a
// path containing one ("图片工具箱 - 客户端"), so every path argument would be
// cut in half. All commands here are .exe files anyway (node, esbuild), so a
// shell adds nothing but the quoting hazard.
function run(label, command, commandArgs) {
  log(`  ${label}`);
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    log(c.red(`  FAIL: could not start ${command}: ${result.error.message}`));
    return 1;
  }
  // A signal means the child was killed; report it as a failure like a bad exit
  // code instead of pretending it succeeded.
  if (result.signal) {
    log(c.red(`  FAIL: ${command} terminated by signal ${result.signal}`));
    return 1;
  }
  return result.status ?? 1;
}

// Runs a gate command, records its exit code into allOk, and returns the code.
// Accepts (label, ...argv) or (label, command, argvArray); argv arrays are
// flattened so a caller may pass either shape.
function gate(label, ...argv) {
  const flat = argv.flat(Infinity);
  const [command, ...rest] = flat;
  const code = run(label, command, rest);
  if (code !== 0) {
    allOk = false;
  }
  return code;
}

// node scripts/x.mjs, with the shim resolved so the same call works under npm,
// pnpm and a direct node invocation.
function node(script, ...scriptArgs) {
  const target = path.join(SCRIPTS, script);
  if (!fs.existsSync(target)) throw new Error(`Gate script not found: ${script}`);
  return gate(`node ${path.relative(ROOT, target)} ${scriptArgs.join(' ')}`.trim(), process.execPath, [target, ...scriptArgs]);
}

// Like node(), but captures stdout+stderr instead of streaming it, so a gate can
// archive its own evidence (the security gate does). Exit-code arbitration is
// identical: a spawn error or a signal is a failure, never a pass.
function nodeCaptured(label, script) {
  const target = path.join(SCRIPTS, script);
  if (!fs.existsSync(target)) throw new Error(`Gate script not found: ${script}`);
  log(`  ${label}`);
  const result = spawnSync(process.execPath, [target], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    log(c.red(`  FAIL: could not start node: ${result.error.message}`));
    return { code: 1, text, stdout: '' };
  }
  if (result.signal) {
    log(c.red(`  FAIL: node terminated by signal ${result.signal}`));
    return { code: 1, text, stdout: '' };
  }
  return { code: result.status ?? 1, text, stdout: result.stdout ?? '' };
}

// node --check <file> for files outside scripts/ (the emitted bundles).
function nodeCheck(label, file) {
  return gate(`node --check (${label})`, process.execPath, ['--check', file]);
}

function resolveEsbuild() {
  // .exe first: a .CMD shim cannot be execFileSync'd on Windows (EINVAL - a
  // shell is required), while esbuild.exe exists in every layout here, including
  // pnpm's strict node_modules.
  const candidates = [
    path.join(ROOT, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.join(ROOT, 'node_modules/@esbuild/win32-arm64/esbuild.exe'),
    path.join(ROOT, 'node_modules/.bin/esbuild.exe'),
    path.join(ROOT, 'node_modules/.bin/esbuild')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // pnpm strict layout: the real binary only lives under .pnpm.
  const pnpmDir = path.join(ROOT, 'node_modules/.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (!/^@esbuild\+(win32|windows)-/.test(entry)) continue;
      const arch = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
      const found = path.join(pnpmDir, entry, 'node_modules/@esbuild', arch, 'esbuild.exe');
      if (fs.existsSync(found)) return found;
    }
  }
  log(c.red('FAIL: esbuild CLI not found. Run "pnpm install" first - esbuild is a devDependency.'));
  process.exit(1);
}

  const esbuild = resolveEsbuild();
const isWindows = process.platform === 'win32';

// One esbuild invocation. The exit code alone decides, so an esbuild warning
// never fails the build.
function esbuildBuild(label, buildArgs) {
  const code = run(`esbuild[${label}]`, esbuild, buildArgs);
  if (code !== 0) {
    throw new Error(`esbuild failed for ${label} (exit ${code})`);
  }
}

// Runs scripts/prepare-build.mjs and returns the staging dir it printed.
// Staging lives in the OS temp dir on purpose: it is build scratch, and it must
// stay outside dist/ where Test-BuildOutput would otherwise node --check the
// ESM stubs as if they were CommonJS products.
function getStagingDir(clientName) {
  const script = path.join(SCRIPTS, 'prepare-build.mjs');
  const out = execFileSync(process.execPath, [script, '--platform', clientName], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hit = out.split(/\r?\n/).filter((line) => /-> .+$/.test(line)).pop();
  if (!hit) throw new Error(`prepare-build.mjs printed no staging path for ${clientName}`);
  return hit.replace(/^.*?-> /, '').trim();
}

// Guards over one platform's dist. Two bundles, not ~70 copied source files -
// esbuild consumed the sources.
function testBuildOutput({ target, distName, pageBundle }) {
  let ok = true;

  // 1. Syntax of the emitted bundles. app.js is format=esm and is checked
  //    through an .mjs copy under ESM rules. Historically the copy was .cjs
  //    ("prove the syntax even under CJS rules") - valid while the minified
  //    body carried no ESM-only syntax, but the AI runtime (onnxruntime-web
  //    ecosystem) legitimately uses import.meta.url, which is a syntax error
  //    under CJS parsing. The page bundle is loaded by the browser as an ES
  //    module, so ESM rules are the honest check. preload.js is cjs and stays
  //    checked in place under CJS rules.
  const pageCheck = path.join(os.tmpdir(), `imgtb-check-${distName}-${Date.now()}-${process.pid}.mjs`);
  fs.copyFileSync(pageBundle, pageCheck);
  if (nodeCheck(`${distName} page bundle`, pageCheck) !== 0) {
    log(c.red(`  FAIL: node --check on dist/${distName} page bundle`));
    ok = false;
  }
  fs.rmSync(pageCheck, { force: true });

  const preload = path.join(target, 'preload.js');
  if (fs.existsSync(preload)) {
    if (nodeCheck(`${distName}/preload.js`, preload) !== 0) {
      log(c.red(`  FAIL: node --check on dist/${distName}/preload.js`));
      ok = false;
    }
  }

  // 2. The output must not contain unresolved aliases. esbuild resolving
  //    #core/ natively makes this structural rather than a rewrite check; it
  //    stays as the belt-and-braces guard.
  const leftover = walk(target).filter((file) => ['.js', '.html'].includes(path.extname(file)))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('#core/'));
  if (leftover.length > 0) {
    log(c.red(`  FAIL: unresolved #core/ alias in dist/${distName}`));
    for (const file of leftover) log(`    ${file}`);
    ok = false;
  }

  // 3. preload.js is loaded by Electron via CommonJS require(). If an ancestor
  //    package.json declares "type": "module", Node rejects it with
  //    "require() of ES Module ... not supported" and the plugin fails to load.
  //    No encoding is passed to readFileSync: Node strips a leading BOM, so a
  //    file that carries one is still read correctly.
  if (fs.existsSync(preload)) {
    let dir = path.dirname(preload);
    let type = null;
    while (dir && !type) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        type = /"type"\s*:\s*"module"/.test(fs.readFileSync(candidate, 'utf8')) ? 'module' : 'commonjs';
      }
      dir = path.dirname(dir);
    }
    if (type === 'module') {
      log(c.red(`  FAIL: dist/${distName}/preload.js would be treated as an ES module.`));
      log(c.red('        Electron requires it as CommonJS, so it would fail to load.'));
      log(c.red('        Remove the "type": "module" field from the ancestor package.json.'));
      ok = false;
    }
  }

  return ok;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate 0a - version consistency from the sources.
// ---------------------------------------------------------------------------
log(c.cyan('Checking app version consistency ...'));
if (args.has('--skip-version-check')) {
  log('  skipped by --skip-version-check');
} else {
  node('version-check.mjs');
}

fs.mkdirSync(DIST_ROOT, { recursive: true });

// Remove legacy single-target dist output, but keep other platform folders.
for (const legacy of ['src', 'core', 'plugin.json', 'preload.js', 'logo.png']) {
  fs.rmSync(path.join(DIST_ROOT, legacy), { recursive: true, force: true });
}
// Metafile scratch dir from a previous run (esbuild writes them inside dist
// because the sandbox may deny %TEMP% writes to the esbuild child process).
fs.rmSync(path.join(DIST_ROOT, '.meta'), { recursive: true, force: true });
// dist/.build is where staging used to live before it moved to the temp dir;
// remove it if present. Best effort: it is inert scratch, never deployed.
fs.rmSync(path.join(DIST_ROOT, '.build'), { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Per-platform build + gates.
// ---------------------------------------------------------------------------
for (const platform of PLATFORMS) {
  const { client, dist: distName } = platform;
  const clientRoot = path.join(ROOT, 'clients', client);
  const target = path.join(DIST_ROOT, distName);
  const isElectron = client !== 'web';

  log(c.cyan(`Building dist/${distName}/ ...`));
  if (!fs.existsSync(clientRoot)) {
    throw new Error(`Client not found: ${clientRoot}`);
  }

  const stage = getStagingDir(client);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  let pageOut;
  let cssOut;
  let htmlOut;
  if (isElectron) {
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    pageOut = path.join(target, 'src', 'app.js');
    cssOut = path.join(target, 'src', 'index.css');
    htmlOut = path.join(target, 'src', 'index.html');
  } else {
    pageOut = path.join(target, 'app.js');
    cssOut = path.join(target, 'index.css');
    htmlOut = path.join(target, 'index.html');
  }

  // 1. Page bundle. The staging entry imports the vendor wrappers first and
  //    then the real client entry, mirroring the old <script> order; jsdom
  //    stays external because the vendored fabric.min.js keeps a Node-only
  //    require("jsdom") branch that never runs in a browser and would not
  //    resolve from this repo.
  //
  //    Metafiles are written under dist/.meta/, NOT the OS temp dir: the
  //    esbuild child process may be denied %TEMP% writes entirely (sandbox /
  //    antivirus policy on this machine — a probe write from the orchestrator
  //    succeeds while esbuild gets "Access is denied"), while writes inside
  //    the repo always succeed. The bundle itself already goes to dist/ for
  //    the same reason. Files here are build scratch: verify-artifact reads
  //    them right away and the next build wipes dist/ wholesale.
  const metaDir = path.join(DIST_ROOT, '.meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const metaPagePath = path.join(metaDir, `meta-page-${distName}-${process.pid}.json`);
  const metaPreloadPath = path.join(metaDir, `meta-preload-${distName}-${process.pid}.json`);
  esbuildBuild(`page-${distName}`, [
    path.join(stage, 'entry.js'),
    '--bundle',
    `--outfile=${pageOut}`,
    '--format=esm',
    '--platform=browser',
    '--target=chrome100',
    '--charset=utf8',
    '--define:global=globalThis',
    // AI 运行时只用 wasm 执行提供器：把 rmbg-webgpu 写死的 webgpu 入口
    // 重定向到主入口，避免把 25.6MB 的 jsep（含 WebGPU/Dawn）wasm 卷进资产
    // —— 主入口对应的 ort-wasm-simd-threaded.wasm 只有 12.9MB。
    '--alias:onnxruntime-web/webgpu=onnxruntime-web',
    '--minify',
    '--legal-comments=inline',
    '--external:jsdom',
    '--external:jsdom/lib/*',
    '--log-level=warning',
    `--metafile=${metaPagePath}`
  ]);

  // 2. Stylesheet.
  esbuildBuild(`css-${distName}`, [
    path.join(ROOT, 'core/src/style.css'),
    '--bundle',
    `--outfile=${cssOut}`,
    '--minify',
    '--log-level=warning'
  ]);

  // 3. Page copy. The staging HTML was already rewritten and asserted by
  //    scripts/prepare-build.mjs; it is copied byte for byte, never patched
  //    here. Node's writeFileSync emits no BOM, unlike PowerShell's
  //    Out-File -Encoding utf8.
  fs.copyFileSync(path.join(stage, 'index.html'), htmlOut);

  // 4. Client assets. plugin.json / preload.js are Electron-only, logo.png is
  //    the plugin icon on Electron and kept as a favicon on web.
  fs.copyFileSync(path.join(clientRoot, 'logo.png'), path.join(target, 'logo.png'));

  // 4b. AI runtime assets (AI tool). File names mirror AI_ASSET_FILES in
  //     core/src/ports/AIPort.js — keep the two in step:
  //   - the wasm glue .mjs ships on every platform: onnxruntime-web loads it
  //     with a runtime dynamic import under the wasmPaths prefix;
  //   - .wasm and the u2netp model only ship on web, which fetches them on
  //     demand by relative URL. Electron platforms inline both as base64 via
  //     the staging ai-assets-inline.js (see prepare-build.mjs) and feed them
  //     to onnxruntime-web as byte buffers, so no file copy and no page-level
  //     fetch of local files on restricted host protocols.
  //     Electron pages live under src/, so the directory must go there too or
  //     the relative './assets/ai/' prefix resolves outside the plugin payload.
  // AI 资产（AI 修图工具）。文件名与 core/src/ports/AIPort.js 的
  // AI_ASSET_FILES 一一对应，改动须两处同步：
  //   - 胶水 .mjs + 运行时 .wasm 用「非 jsep」变体（esbuild 已把
  //     onnxruntime-web/webgpu alias 到主入口，对应 ort-wasm-simd-threaded.*，
  //     12.9MB，而非 25.6MB 的 jsep 变体）；
  //   - 三端都拷 .mjs（onnxruntime-web 运行时按 wasmPaths 前缀动态 import 它）；
  //   - .wasm 与 u2netp 模型仅 Web 端按相对 URL 按需 fetch；Electron 端两者
  //     经 prepare-build 生成的 ai-assets-inline.js 以 base64 内联、字节直喂
  //     onnxruntime-web，受限页面协议下零本地 fetch。
  //     Electron 页面在 src/ 下，目录必须落在 src/assets/ai 才与
  //     './assets/ai/' 前缀对得上。
  const ortDist = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const rmbgModel = path.join(ROOT, 'node_modules', '@planby-tech', 'rmbg-webgpu', 'models', 'u2netp.onnx');
  const aiAssetsTarget = path.join(isElectron ? path.join(target, 'src') : target, 'assets', 'ai');
  fs.mkdirSync(aiAssetsTarget, { recursive: true });
  fs.copyFileSync(path.join(ortDist, 'ort-wasm-simd-threaded.mjs'), path.join(aiAssetsTarget, 'ort-wasm-simd-threaded.mjs'));
  if (!isElectron) {
    fs.copyFileSync(path.join(ortDist, 'ort-wasm-simd-threaded.wasm'), path.join(aiAssetsTarget, 'ort-wasm-simd-threaded.wasm'));
    fs.copyFileSync(rmbgModel, path.join(aiAssetsTarget, 'u2netp.onnx'));
  }

  if (isElectron) {
    fs.copyFileSync(path.join(clientRoot, 'plugin.json'), path.join(target, 'plugin.json'));

    // 5. preload: CommonJS bundle for Electron's require(). electron stays
    //    external; node builtins (fs/path/os/child_process) stay external by
    //    --platform=node.
    esbuildBuild(`preload-${distName}`, [
      path.join(clientRoot, 'preload.js'),
      '--bundle',
      `--outfile=${path.join(target, 'preload.js')}`,
      '--platform=node',
      '--format=cjs',
      '--external:electron',
      '--charset=utf8',
      '--log-level=warning',
      `--metafile=${metaPreloadPath}`
    ]);
  }

  // Gate 1: metafile scope assertions.
  node('verify-artifact.mjs',
    metaPagePath,
    '--staging', stage,
    '--allow-external', 'jsdom',
    '--label', `page-${distName}`);

  if (isElectron) {
    node('verify-artifact.mjs',
      metaPreloadPath,
      '--allow-external', 'electron,fs,path,os,child_process,events,util',
      '--label', `preload-${distName}`);

    // Gate 3b: the preload bundle must really evaluate under stubbed electron +
    // window. node --check cannot catch CJS/ESM interop breakage.
    node('verify-preload-smoke.mjs', path.join(target, 'preload.js'));
  }

  // Gate 2: output guards.
  if (!testBuildOutput({ target, distName, pageBundle: pageOut })) {
    allOk = false;
  }

  // Gate 3: the page bundle must evaluate with the vendored globals mounted.
  // The copy keeps the .mjs name so Node treats the ESM result as ESM.
  const smokeFile = path.join(os.tmpdir(), `imgtb-smoke-${distName}-${Date.now()}-${process.pid}.mjs`);
  fs.copyFileSync(pageOut, smokeFile);
  node('verify-bundle-smoke.mjs', smokeFile);
  fs.rmSync(smokeFile, { force: true });

  // Gate 4 (web only): recompute every first-screen request from the site root.
  if (!isElectron) {
    node('verify-web-root-load.mjs', target);
  }

  if (allOk) log(c.green(`Build complete: dist/${distName}/`));
}

// ---------------------------------------------------------------------------
// Gate 0b - version consistency of the dist copies.
// ---------------------------------------------------------------------------
if (!args.has('--skip-version-check')) {
  node('version-check.mjs', '--dist-only');
}

// ---------------------------------------------------------------------------
// Gate 5 - security regression gate. Two checks, both required.
// ---------------------------------------------------------------------------
if (process.env.SKIP_SECURITY_GATE === '1') {
  log(c.cyan('Security gate: SKIP_SECURITY_GATE=1 set - skipped (local iteration only, never for a release).'));
} else {
  log(c.cyan('Running security regression gate ...'));
  const gateLog = path.join(DIST_ROOT, 'security-gate.log');
  const results = [];
  let gateOk = true;
  for (const gateScript of ['verify-security-hardening.mjs', 'mutation-check-sanitizers.mjs']) {
    const r = nodeCaptured(`node scripts/${gateScript}`, gateScript);
    results.push({ script: gateScript, code: r.code, text: r.text, stdout: r.stdout });
    if (r.code !== 0) gateOk = false;
  }
  // The log is the evidence a reviewer reads after a red build, so it carries
  // both scripts' complete output rather than only their exit codes: "exit=1"
  // alone never says which assertion failed, and the previous version of this
  // gate wrote nothing else into the file. This log is also a build artifact
  // and must not carry a BOM: PowerShell's Out-File -Encoding utf8 used to
  // prepend one here, and the old BOM report never scanned .log files, so the
  // whole build still reported OK.
  const logText = results.map((r) => `# ${r.script} (exit=${r.code})\n${r.text.trimEnd()}`).join('\n\n');
  fs.writeFileSync(gateLog, `${logText}\n`, 'utf8');
  if (!gateOk) {
    allOk = false;
    log(c.red('Security gate FAILED - full output follows (also written to dist/security-gate.log):'));
    log(fs.readFileSync(gateLog, 'utf8'));
  } else {
    // Green path: print each script's own summary line instead of replaying
    // every assertion into the build output. Read it from stdout only - the
    // scripts also log warnings on stderr, and those would otherwise become
    // the "summary" just because they were emitted last.
    for (const r of results) {
      const lines = r.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const summary = lines.filter((line) => /通过/.test(line)).pop() ?? lines.pop() ?? '';
      log(c.green(`  ${r.script}: ${summary}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Gate 6 - alias rewrite safety. Runs last because it audits the whole dist
// tree plus the build chain itself, and it bundles its own fixture.
// ---------------------------------------------------------------------------
if (args.has('--skip-alias-gate')) {
  log(c.cyan('Alias rewrite gate: skipped by --skip-alias-gate'));
} else {
  log(c.cyan('Checking #core/ alias rewrite safety ...'));
  const code = run('node scripts/verify-alias-rewrite.mjs', process.execPath, [path.join(SCRIPTS, 'verify-alias-rewrite.mjs'), DIST_ROOT]);
  if (code !== 0) allOk = false;
}

// ---------------------------------------------------------------------------
// Gate 7 - canvas level clipPath session. Two modules share one session object
// because the accident class it guards (each module keeping its own backup of
// the canvas-level clipPath and restoring the other's temporary value, cutting
// the layer off for good) never surfaces at mount time.
// ---------------------------------------------------------------------------
log(c.cyan('Checking canvas clipPath session ...'));
// node() already folds a non-zero exit into allOk, so the return value is only
// needed here when a gate should change what runs next.
node('verify-clip-path-session.mjs');

// ---------------------------------------------------------------------------
// Gate 8 - color params table. The params live in one table and everything
// else is derived; this gate keeps that true. Adding a slider must not require
// touching ColorModule or the preset chain again.
// ---------------------------------------------------------------------------
log(c.cyan('Checking color params table ...'));
node('verify-filter-params-table.mjs');

// ---------------------------------------------------------------------------
// Gate 9 - UTF-8 BOM invariant. The one gate that still lives in PowerShell,
// because it is a byte-level assertion about a whole directory tree and
// reimplementing a working byte reader in Node would only add risk. It turns
// the BOM class of bug into a build failure instead of a manual report.
// ---------------------------------------------------------------------------
log(c.cyan('Checking UTF-8 BOM invariant ...'));
const bomReport = path.join(SCRIPTS, 'bom-report.ps1');
if (fs.existsSync(bomReport)) {
  const code = run('powershell bom-report.ps1', isWindows ? 'powershell' : 'pwsh', [
    '-ExecutionPolicy', 'Bypass', '-File', bomReport
  ]);
  if (code !== 0) allOk = false;
} else {
  log(c.red('  FAIL: scripts/bom-report.ps1 missing - the BOM invariant is now unchecked.'));
  allOk = false;
}

// ---------------------------------------------------------------------------
// Gate 10 - documentation references. This one is about the gate list itself:
// the docs are the only thing anyone reads to judge what is verified, so a doc
// that names a script which does not exist (verify-clip-path-session.mjs was
// listed for months before the file was ever committed) and a gate that runs
// without being documented (verify-filter-params-table.mjs) both make a reader
// reach a wrong conclusion. Checks both directions, plus a self-check proving
// the checks can fail.
// ---------------------------------------------------------------------------
log(c.cyan('Checking documentation references ...'));
node('verify-doc-refs.mjs');

if (!allOk) {
  log(c.red('Build failed!'));
  process.exit(1);
}
log(c.green('Build succeeded.'));
