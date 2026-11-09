/**
 * scripts/verify-alias-rewrite.mjs
 *
 * #core/ alias rewrite safety gate. Ported from scripts/verify-alias-rewrite.ps1
 * when the build moved from PowerShell to pnpm (see scripts/build.mjs).
 *
 * Background (actually happened, not hypothetical):
 *   The old build rewrote the alias with an unbounded plain-text replacement:
 *     $newContent = $content.Replace("#core/", ($prefix + "core/src/"))
 *   It did not distinguish code / string / comment / URL context, so the JSDoc
 *   example at the top of core/src/preloadHelpers.js (renamed to .cjs after the
 *   esbuild migration: a CJS helper inside a type:module package must carry the
 *   .cjs extension - Node's own rule) came out in dist as a mangled relative
 *   path. The check of that era only scanned for leftover "#core/", and a
 *   munged line no longer contains it - so this class of corruption was
 *   completely invisible to the build, which still printed Build complete.
 *
 * Since the esbuild migration the build no longer rewrites paths (#core/ is
 * resolved natively by esbuild). This gate pins that down and adds the reverse
 * direction the old check was missing:
 *   - forward (old): no unresolved #core/ may remain in the output
 *   - reverse (new): no rewritten-into-relative-path trace may appear; no
 *                    unbounded alias text replacement may exist in the build;
 *                    #core/ string literals must survive bundling verbatim
 *
 * It self-verifies by mutation: a gate that stays green when the corruption it
 * claims to catch is reintroduced protects nothing (this repo has been burned
 * by that before).
 *
 * Usage: node scripts/verify-alias-rewrite.mjs [distRoot]
 * Exit code 0 = safe, 1 = at least one check failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist');
const esbuildExe = resolveEsbuild();

// --- detectors (pure, so the mutation self-check can call them) ---

const REWRITE_FINGERPRINT = /(?:\.\.\/)+core\/src\//;
const BLIND_REPLACE = /\.replace\("#core\/"/i;
const UNRESOLVED_ALIAS = '#core/';

function resolveEsbuild() {
  const candidates = [
    path.join(ROOT, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.join(ROOT, 'node_modules/@esbuild/win32-arm64/esbuild.exe'),
    path.join(ROOT, 'node_modules/.bin/esbuild.exe')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // pnpm keeps the real binary under .pnpm; walk it as a last resort.
  const pnpmDir = path.join(ROOT, 'node_modules/.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (!/^@esbuild\+(win32|windows)-/.test(entry)) continue;
      const arch = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
      const found = path.join(pnpmDir, entry, 'node_modules/@esbuild', arch, 'esbuild.exe');
      if (fs.existsSync(found)) return found;
    }
  }
  // Last resort on any platform: the .bin/esbuild shim needs a shell on Windows
  // (.CMD), so it is only used where that is safe.
  const shim = path.join(ROOT, 'node_modules/.bin/esbuild');
  if (fs.existsSync(shim) && process.platform !== 'win32') return shim;
  console.log('  FAIL: esbuild executable not found (run pnpm install first)');
  process.exit(1);
}

function run() {
  let failed = 0;

  const check = (name, pass, detail = '') => {
    if (pass) {
      console.log(`  OK   ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    }
  };

  // 1. No unbounded alias text replacement anywhere in the build chain.
  //    scripts/prepare-build.mjs does rewrite HTML href/src, but its patterns
  //    are anchored to <link rel="stylesheet" href="..."> and <script src="...">
  //    and it self-asserts the rewrite happened - not what this bans.
  const buildScript = path.join(ROOT, 'scripts/build.mjs');
  if (fs.existsSync(buildScript)) {
    const buildText = fs.readFileSync(buildScript, 'utf8');
    check('build has no unbounded #core/ text replacement', !BLIND_REPLACE.test(buildText));
    check('build does not re-introduce Update-ImportPaths', !/function Update-ImportPaths/.test(buildText));
  } else {
    check('build.mjs exists', false, 'build orchestrator missing');
  }

  // 2. Scan the artifacts: both directions must be clean.
  const distFiles = [];
  for (const platform of ['uTools', 'zTools', 'web']) {
    const dir = path.join(distRoot, platform);
    if (!fs.existsSync(dir)) continue;
    for (const entry of walk(dir)) {
      if (['.js', '.mjs', '.cjs', '.html', '.css'].includes(path.extname(entry))) {
        distFiles.push(entry);
      }
    }
  }

  if (distFiles.length === 0) {
    check('dist artifacts exist', false, 'nothing to verify under dist');
  } else {
    const fingerprinted = distFiles.filter((file) => REWRITE_FINGERPRINT.test(fs.readFileSync(file, 'utf8')));
    const unresolved = distFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(UNRESOLVED_ALIAS));
    check(`no rewritten-into-relative-path trace in output (${distFiles.length} files)`, fingerprinted.length === 0, fingerprinted.join(', '));
    check('no unresolved #core/ alias in output', unresolved.length === 0, unresolved.join(', '));

    // 3. No copied core/src source tree in dist - that tree was the shape that
    //    made path rewriting necessary at all. The bundles replace it.
    const copied = ['uTools', 'zTools', 'web'].filter((platform) => fs.existsSync(path.join(distRoot, platform, 'core/src')));
    check('no copied core/src tree in dist (bundles need no path rewrite)', copied.length === 0, copied.join(', '));
  }

  // 4. Behavioural check: bundle a fixture that carries #core/ literals and
  //    assert they survive verbatim - the standing form of "a file containing a
  //    #core/ string must not be mangled by the build".
  //    esbuild strips plain comments by default, so the historical "comment got
  //    mangled" corruption cannot occur at all; what can be silently polluted
  //    is a string literal, hence string / URL / template-literal contexts are
  //    the assertion targets.
  //    The fixture must live inside the repo: esbuild resolves #core/* through
  //    the nearest package.json "imports", and only the repo root declares it.
  //    A real import is included too, so "do not rewrite" cannot quietly become
  //    "do not resolve".
  const stamp = `${process.pid}-${Date.now()}`;
  const fixture = path.join(ROOT, `alias-rewrite-fixture-${stamp}.js`);
  const bundle = path.join(ROOT, `alias-rewrite-fixture-${stamp}.bundle.js`);
  const literals = [
    'literal string mentioning #core/preloadHelpers.js',
    'https://example.com/#core/thing',
    "} = require('#core/preloadHelpers.js');"
  ];

  try {
    fs.writeFileSync(fixture, [
      '/**',
      ' * Alias rewrite regression fixture: if any #core/ literal below were',
      ' * rewritten by an unbounded replacement, this gate must fail.',
      ' */',
      "export const note = 'literal string mentioning #core/preloadHelpers.js';",
      "export const url = 'https://example.com/#core/thing';",
      'export const doc = `} = require(\'#core/preloadHelpers.js\');`;',
      "import eventBus from '#core/EventBus.js';",
      'export const bus = eventBus;',
      ''
    ].join('\n'), 'utf8');

    let bundleText = '';
    try {
      execFileSync(esbuildExe, [fixture, '--bundle', `--outfile=${bundle}`, '--format=esm', '--platform=browser', '--charset=utf8', '--log-level=error'], { stdio: 'pipe' });
      bundleText = fs.readFileSync(bundle, 'utf8');
    } catch (error) {
      check('fixture bundles successfully', false, String(error.status ?? error.message));
    }

    if (bundleText) {
      for (const literal of literals) {
        check(`#core/ literal survives verbatim: ${literal}`, bundleText.includes(literal));
      }
      // The same fixture proves the alias still resolves: "do not rewrite" must
      // not quietly become "do not resolve".
      const eventBusSrc = fs.readFileSync(path.join(ROOT, 'core/src/EventBus.js'), 'utf8');
      const marker = /_idCounter\s*=\s*\d/.exec(eventBusSrc);
      check('real #core/ import still resolves (alias works)', Boolean(marker && bundleText.includes(marker[0])));
      check('fixture bundle has no rewrite trace', !REWRITE_FINGERPRINT.test(bundleText));
    }
  } catch (error) {
    check('fixture bundle and assertions ran', false, error.message);
  } finally {
    for (const scratch of [fixture, bundle]) {
      fs.rmSync(scratch, { force: true });
    }
  }

  // 5. Mutation self-check: the detectors must be falsifiable.
  const cleanSample = "const x = require('#core/preloadHelpers.js');";
  const corruptSample = "const x = require('../../core/src/preloadHelpers.js');";
  check('mutation: clean sample does not trip the rewrite detector', !REWRITE_FINGERPRINT.test(cleanSample));
  check('mutation: corrupted sample must trip the rewrite detector', REWRITE_FINGERPRINT.test(corruptSample));

  const blindSample = '$newContent = $content.Replace("#core/", ($prefix + "core/src/"))';
  const anchoredSample = 'html = html.replace(/<link rel="stylesheet" href="#core\\/style\\.css">/, ...)';
  check('mutation: unbounded replacement sample must trip the replacement detector', BLIND_REPLACE.test(blindSample));
  check('mutation: HTML-attribute-anchored rewrite is not flagged as unbounded', !BLIND_REPLACE.test(anchoredSample));

  if (failed > 0) {
    console.log(`Alias rewrite safety gate failed: ${failed} check(s)`);
  }
  return failed === 0;
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

process.exit(run() ? 0 : 1);
