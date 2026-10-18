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
 * Gates (any failure fails the build, exit 1):
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
 *   4. verify-web-root-load.mjs (web only) - every first-screen request resolves
 *      on disk from the site root.
 *   5. Security regression gate: verify-security-hardening.mjs AND
 *      mutation-check-sanitizers.mjs, both required. The mutation half proves
 *      the assertions can actually fail - a red-free suite that covers nothing
 *      is the exact failure this pair exists to prevent.
 *   6. verify-alias-rewrite.mjs - no ../core/src/ rewrite trace or #core/
 *      leftover in the output, no copied core/src tree, #core/ literals survive
 *      bundling verbatim, plus a mutation self-check.
 *   7. verify-clip-path-session.mjs - the canvas-level clipPath session: one
 *      shared session object per canvas. It guards the accident where each of
 *      Mosaic/Crop kept its own backup and restored the other's temporary one,
 *      cutting the layer off for good - a failure that only surfaces later, so
 *      it needs a gate rather than eyeballing.
 *   8. bom-report.ps1 - the BOM invariant: nothing in the build may introduce a
 *      UTF-8 BOM. Kept from the PowerShell era and now extended to .log files,
 *      because the security gate writes dist/security-gate.log.
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

  // 1. Syntax of the emitted bundles. app.js is format=esm; the minified body
  //    carries no import/export statements, but parsing it through a .cjs copy
  //    proves the syntax even under CJS rules. preload.js is cjs and checked
  //    in place.
  const pageCheck = path.join(os.tmpdir(), `imgtb-check-${distName}-${Date.now()}-${process.pid}.cjs`);
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
  esbuildBuild(`page-${distName}`, [
    path.join(stage, 'entry.js'),
    '--bundle',
    `--outfile=${pageOut}`,
    '--format=esm',
    '--platform=browser',
    '--target=chrome100',
    '--charset=utf8',
    '--define:global=globalThis',
    '--minify',
    '--legal-comments=inline',
    '--external:jsdom',
    '--external:jsdom/lib/*',
    '--log-level=warning',
    `--metafile=${path.join(stage, 'meta-page.json')}`
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
      `--metafile=${path.join(stage, 'meta-preload.json')}`
    ]);
  }

  // Gate 1: metafile scope assertions.
  node('verify-artifact.mjs',
    path.join(stage, 'meta-page.json'),
    '--staging', stage,
    '--allow-external', 'jsdom',
    '--label', `page-${distName}`);

  if (isElectron) {
    node('verify-artifact.mjs',
      path.join(stage, 'meta-preload.json'),
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
  const lines = [];
  let gateOk = true;
  for (const gateScript of ['verify-security-hardening.mjs', 'mutation-check-sanitizers.mjs']) {
    const code = node(gateScript);
    lines.push(`exit=${code}  ${gateScript}`);
    if (code !== 0) gateOk = false;
  }
  // This log is a build artifact and must not carry a BOM: PowerShell's
  // Out-File -Encoding utf8 used to prepend one here, and the old BOM report
  // never scanned .log files, so the whole build still reported OK.
  fs.writeFileSync(gateLog, `${lines.join('\n')}\n`, 'utf8');
  if (!gateOk) {
    allOk = false;
    for (const line of lines) log(line);
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
// Gate 7 - BOM invariant. The one gate that still lives in PowerShell, because
// it is a byte-level assertion about a whole directory tree and reimplementing
// a working byte reader in Node would only add risk. It turns the BOM class of
// bug into a build failure instead of a manual report.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Gate 8 - canvas level clipPath session. Two modules share one session object
// because the accident class it guards (each module keeping its own backup of
// the canvas-level clipPath and restoring the other's temporary value, cutting
// the layer off for good) never surfaces at mount time.
log(c.cyan('Checking canvas clipPath session ...'));
// node() already folds a non-zero exit into allOk, so the return value is only
// needed here when a gate should change what runs next.
node('verify-clip-path-session.mjs');

// ---------------------------------------------------------------------------
// Gate 9 - UTF-8 BOM invariant.
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

if (!allOk) {
  log(c.red('Build failed!'));
  process.exit(1);
}
log(c.green('Build succeeded.'));
