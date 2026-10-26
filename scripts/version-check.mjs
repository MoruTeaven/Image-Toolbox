/**
 * scripts/version-check.mjs
 *
 * App version consistency gate. Ported from scripts/version-check.ps1 when the
 * build moved from PowerShell to pnpm (see scripts/build.mjs); the assertions
 * are the same, byte for byte, so a version that used to fail the build still
 * fails it.
 *
 * Background: the app version used to be defined in several places at once
 * (one plugin.json per client vs a hard-coded list in the in-app update records),
 * so the uTools store showed 2.3.2 while the in-app About page showed a
 * long-dead 1.2.3. The single source of truth is APP_VERSION in
 * packages/changelog/src/changelog.js.
 *
 * Version format: MAJOR.MINOR.PATCH, optionally with a SemVer pre-release tag
 * (e.g. 2.5.1-dev) while a release has not been published yet. All references
 * must carry the same tag, so cutting a release is one coordinated change that
 * drops it.
 *
 * Usage: node scripts/version-check.mjs [--dist-only]
 *   --dist-only   check only dist/<platform>/plugin.json (skip the source refs),
 *                 for the post-build pass where dist is the thing that matters.
 * Exit code 0 = all consistent, 1 = at least one mismatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = [
  { client: 'utools', dist: 'uTools' },
  { client: 'ztools', dist: 'zTools' },
  { client: 'web', dist: 'web' }
];
const distOnly = process.argv.includes('--dist-only');
const distRoot = path.join(ROOT, 'dist');

let ok = true;

function fail(message) {
  console.log(`  FAIL: ${message}`);
  ok = false;
}

function read(file, label) {
  try {
    // No encoding argument on purpose. Node's utf8 decoder strips a leading
    // BOM, so a file that carries one still parses correctly.
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
    return '';
  }
}

function readJson(file, label) {
  const text = read(file, label);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

const changelogPath = path.join(ROOT, 'packages/changelog/src/changelog.js');
const changelogSrc = read(changelogPath, 'packages/changelog/src/changelog.js');
const versionMatch = /export\s+const\s+APP_VERSION\s*=\s*'([^']+)'/.exec(changelogSrc);
if (!versionMatch) {
  fail('APP_VERSION not found in packages/changelog/src/changelog.js');
  process.exit(1);
}
const version = versionMatch[1];

// 1. Per-platform plugin.json - the version the app stores publish.
//    web has no plugin.json (it is not distributed through a plugin store), so
//    a missing file is not an error: only an existing one must agree.
for (const platform of PLATFORMS) {
  const pluginPath = path.join(ROOT, 'clients', platform.client, 'plugin.json');
  if (!fs.existsSync(pluginPath)) continue;
  const plugin = readJson(pluginPath, `clients/${platform.client}/plugin.json`);
  if (plugin && plugin.version !== version) {
    fail(`clients/${platform.client}/plugin.json is ${plugin.version}, expected ${version}`);
  }
}

// 2. Root package.json version.
const pkg = readJson(path.join(ROOT, 'package.json'), 'package.json');
if (pkg && pkg.version !== version) {
  fail(`package.json is ${pkg.version}, expected ${version}`);
}

// 3. The newest changelog entry must be the current version.
const latest = /CHANGELOG\s*=\s*\[\s*\{\s*version:\s*'([^']+)'/.exec(changelogSrc);
if (!latest) {
  fail('cannot parse the newest CHANGELOG entry');
} else if (latest[1] !== version) {
  fail(`newest changelog entry is ${latest[1]}, expected ${version}`);
}

// 4. Documentation that states the current version.
const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  const docSrc = read(readmePath, 'README.md');
  const anchor = /Current version|当前版本/.exec(docSrc);
  if (anchor) {
    const declared = /v([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?)/.exec(docSrc.slice(anchor.index));
    if (declared && declared[1] !== version) {
      fail(`README.md declares ${declared[1]}, expected ${version}`);
    }
  }
}

// 5. Built plugin.json must match - catches a stale dist from an older run.
//    The post-build pass runs this alone (--dist-only), with source references
//    already validated by the pre-build pass.
for (const platform of PLATFORMS) {
  const distPlugin = path.join(distRoot, platform.dist, 'plugin.json');
  if (!fs.existsSync(distPlugin)) continue;
  const distJson = readJson(distPlugin, `dist/${platform.dist}/plugin.json`);
  if (distJson && distJson.version !== version) {
    fail(`dist/${platform.dist}/plugin.json is ${distJson.version}, expected ${version}`);
  }
}

if (distOnly) console.log(`  checking dist copies against ${version} ...`);

if (ok) {
  console.log(`Version check passed: ${version}`);
} else {
  console.log(`  authoritative version is APP_VERSION in packages/changelog/src/changelog.js: ${version}`);
  console.log('  release checklist is in the header comment of that file');
}
process.exit(ok ? 0 : 1);
