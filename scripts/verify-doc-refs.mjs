/**
 * 文档引用门禁（构建门禁第 10 项）。
 *
 * 守护的是本仓库已经踩过两次的那类缺陷：**文档与门禁各说各话**。
 *
 *   - `scripts/verify-clip-path-session.mjs` 曾被 AGENTS.md 与 README 列为门禁，
 *     但文件从未入库，git 全历史（--all）也没有任何记录。手动跑必然
 *     `ERR_MODULE_NOT_FOUND`，而文档描述的断言项没有任何东西在守。
 *   - 反过来，`scripts/verify-filter-params-table.mjs` 在构建里真实运行，
 *     文档却一字未提；它后来因为引用已删除的 ColorPanel.js 而把整个构建卡红，
 *     也没人从文档里看出它存在。
 *
 * 两种偏差后果相同：**读文档的人会得出错误的结论**。因此这里双向检查：
 *
 *   1. 文档里出现的每个 `scripts/<文件>` 必须真实存在；
 *   2. `build.mjs` 实际 spawn 的每个脚本，必须在 README 的门禁清单里被点名。
 *
 * 检查对象刻意收窄：
 *   - `README.md`（入库，是门禁清单的权威副本）——双向检查；
 *   - `AGENTS.md`（.gitignore 排除，只在本地存在）——仅做正向检查，
 *     存在才查，缺失时**明确打印跳过原因**而不是静默通过；
 *   - `ESBUILD_EVALUATION.md` 等历史评估文档**不在检查范围**：它们记录的是
 *     一次已结束的评估，里面提到的 `proto-*` 原型脚本按设计已被删除，
 *     把历史文档当现行契约检查只会产生假阳性。
 *
 * 用法：node scripts/verify-doc-refs.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 纯函数部分：输入是文本，输出是问题清单 ──
//
// 全部检查都走这两个函数，好处是自检可以喂合成文本证明它们真的会报错，
// 而不必去改动真实文档（改真实文件再还原的写法一旦中断就会留下脏文件）。

/** 从文档正文里抽出所有 scripts/<文件> 引用，去重。 */
export function extractScriptRefs(text) {
  const re = /scripts\/[A-Za-z0-9._/-]+\.(?:mjs|ps1|cjs)/g;
  return [...new Set(text.match(re) || [])];
}

/**
 * 判断每个引用是否指向真实存在的文件。
 * @returns {{ref: string, exists: boolean}[]}
 */
export function resolveRefs(refs, exists) {
  return refs.map((ref) => ({ ref, exists: exists(ref) }));
}

/**
 * 从 build.mjs 源码里抽出它实际 spawn 的脚本名（不含 esbuild 这类外部程序）。
 * 覆盖四种调用形态：
 *   node('x.mjs')                          → 门禁/校验脚本
 *   run('node scripts/x.mjs', ...)         → 需要实时输出的脚本
 *   path.join(SCRIPTS, 'x.ps1')            → PowerShell 门禁
 *   for (const gateScript of ['x.mjs', …]) → 成组执行的门禁（安全检查就是这样跑的）
 */
export function extractBuildInvocations(buildSrc) {
  const names = new Set();
  for (const m of buildSrc.matchAll(/node\('([A-Za-z0-9._-]+\.mjs)'/g)) {
    names.add(m[1]);
  }
  for (const m of buildSrc.matchAll(/run\('node scripts\/([A-Za-z0-9._-]+\.mjs)'/g)) {
    names.add(m[1]);
  }
  for (const m of buildSrc.matchAll(/path\.join\(SCRIPTS,\s*'([A-Za-z0-9._-]+\.(?:mjs|ps1))'\)/g)) {
    names.add(m[1]);
  }
  // 成组循环：for (const x of ['a.mjs', 'b.mjs']) { … node(x) … }
  for (const m of buildSrc.matchAll(/for \(const \w+ of \[([^\]]+)\]\)/g)) {
    for (const q of m[1].matchAll(/'([A-Za-z0-9._-]+\.(?:mjs|ps1))'/g)) {
      names.add(q[1]);
    }
  }
  return [...names].sort();
}

/** 找出「构建实际调用但文档没点名」的脚本。 */
export function findUndocumented(invoked, docText) {
  return invoked.filter((name) => !docText.includes(name));
}

// ── 真实检查 ──

console.log('\n1. 文档引用的脚本必须真实存在');

const README = path.join(ROOT, 'README.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const existsRel = (ref) => fs.existsSync(path.join(ROOT, ref));

const readmeText = fs.readFileSync(README, 'utf8');
const readmeRefs = extractScriptRefs(readmeText);
const readmeResolved = resolveRefs(readmeRefs, existsRel);

check('README.md 引用了至少一个脚本（否则本门禁空转）', readmeRefs.length > 0,
  `refs=${readmeRefs.length}`);
check('README.md 的脚本引用全部存在', readmeResolved.every((r) => r.exists),
  readmeResolved.filter((r) => !r.exists).map((r) => r.ref).join(', '));

let agentsText = null;
if (fs.existsSync(AGENTS)) {
  agentsText = fs.readFileSync(AGENTS, 'utf8');
  const agentsResolved = resolveRefs(extractScriptRefs(agentsText), existsRel);
  check('AGENTS.md 的脚本引用全部存在', agentsResolved.every((r) => r.exists),
    agentsResolved.filter((r) => !r.exists).map((r) => r.ref).join(', '));
} else {
  // 这个文件被 .gitignore 排除（ab4812e 起不再入库），全新 worktree 与 CI 里都不存在。
  // 明说跳过原因，避免把「没查」伪装成「查过了」。
  console.log('  · AGENTS.md 不存在（.gitignore 排除，不入库）——本项跳过');
}

console.log('\n2. 构建实际调用的脚本必须在 README 门禁清单里点名');

const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts/build.mjs'), 'utf8');
const invoked = extractBuildInvocations(buildSrc);

check('从 build.mjs 里解析出了调用清单（否则解析已失效）', invoked.length > 0,
  `invoked=${invoked.length}`);
check('构建调用的每个脚本都真实存在',
  invoked.every((name) => fs.existsSync(path.join(ROOT, 'scripts', name))),
  invoked.filter((name) => !fs.existsSync(path.join(ROOT, 'scripts', name))).join(', '));

const undocumented = findUndocumented(invoked, readmeText);
check('构建调用的每个脚本都在 README 里被点名', undocumented.length === 0,
  undocumented.length ? `未在 README 出现：${undocumented.join(', ')}` : '');

if (agentsText) {
  const undocumentedInAgents = findUndocumented(invoked, agentsText);
  check('构建调用的每个脚本都在 AGENTS.md §6.1 里被点名', undocumentedInAgents.length === 0,
    undocumentedInAgents.length ? `未在 AGENTS.md 出现：${undocumentedInAgents.join(', ')}` : '');
}

// ── 3. 可证伪性自检 ──
//
// 断言如果抓不住它声称守护的东西，比没有断言更危险：它会一直报告「已验证」。
// 这里喂合成输入，证明两条检查都能真的失败。

console.log('\n3. 自检：这两条检查确实会失败');

const ghostDoc = '见 scripts/__definitely-not-a-real-gate__.mjs';
const ghostResolved = resolveRefs(extractScriptRefs(ghostDoc), existsRel);
check('合成文档里的假引用被识别为不存在',
  ghostResolved.length === 1 && ghostResolved[0].exists === false,
  JSON.stringify(ghostResolved));

const ghostBuild = "node('__ghost-gate__.mjs');";
const ghostInvoked = extractBuildInvocations(ghostBuild);
check('合成 build.mjs 里的调用被解析出来',
  ghostInvoked.length === 1 && ghostInvoked[0] === '__ghost-gate__.mjs',
  JSON.stringify(ghostInvoked));
check('构建调用了但文档没点名时，检查会报出它',
  findUndocumented(ghostInvoked, '这里什么都没提').length === 1);
check('构建调用了且文档点名时，检查不误报',
  findUndocumented(ghostInvoked, '这里提到了 __ghost-gate__.mjs').length === 0);

console.log('');
if (failures.length > 0) {
  console.error(`❌ 文档引用门禁失败：${failures.length} 项`);
  for (const f of failures) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(`✅ 通过：${passed} 项断言（文档引用存在性 + 构建调用已登记 + 可证伪自检）`);
