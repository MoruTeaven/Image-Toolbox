/**
 * mutation-check-sanitizers.mjs
 *
 * 变异自验：证明 verify-security-hardening.mjs 的断言「能被证伪」。
 *
 * 背景（t-mubexmzv-q92e5x 的复核结论）：该回归套件曾出现「带病全绿」——
 * 第一轮 38/38 全绿时 V1/V2 漏洞仍在；第二轮修复后，逃逸断言仍可被
 * _buildDefaultSavePath 的兜底网掩盖：把 _sanitizeSuggestedName 整个
 * 删空，16 条逃逸断言照常全绿。一个删掉修复代码仍然全绿的测试，
 * 证明不了任何事。
 *
 * 本脚本把「测试必须能失败」固化为构建门禁，对净化逻辑做两种变异：
 *
 *   M1 删空 _sanitizeSuggestedName（保留兜底网）
 *       —— 即上述盲区；套件必须出现断言失败。
 *   M2 在 M1 基础上禁用 _buildDefaultSavePath 的两道兜底断言
 *       —— 还原原始漏洞形态（defaultPath 可逃出目标目录）；
 *          套件必须出现断言失败。
 *
 * 每次变异后运行回归套件，要求「退出码非 0 且输出含失败断言（✗）」。
 * 只看退出码不够：变异方法失效导致的崩溃（如锚点失配引发语法错误）
 * 也会返回非 0，那是脚本自己坏了，不是断言在起作用，必须同样判失败。
 *
 * 变异前后源文件逐字节校验恢复；任一步不满足即退出码非 0。
 *
 * 用法：node scripts/mutation-check-sanitizers.mjs
 * 退出码 0 = 自验通过（断言确实能抓住每一层失效）；非 0 = 门禁失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'core', 'src', 'preloadHelpers.js');
const VERIFY = path.join(ROOT, 'scripts', 'verify-security-hardening.mjs');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-toolbox-mutation-'));
const outFile = path.join(outDir, 'verify-out.txt');

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

/** 运行回归套件，返回 { code, out }。stdio 走文件重定向（沙箱禁止管道捕获）。 */
function runVerify() {
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(process.execPath, [VERIFY], { stdio: ['ignore', fd, fd], cwd: ROOT });
  fs.closeSync(fd);
  return { code: r.status, out: fs.readFileSync(outFile, 'utf8') };
}

/** 统计一次运行中的失败断言数（✗ 行数），崩溃时为 0。 */
function countFailedAssertions(out) {
  return out.split(/\r?\n/).filter((l) => l.includes('\u2717')).length;
}

const original = fs.readFileSync(SRC, 'utf8');

// ── 变异定义 ──
// 每个变异 = 若干次字符串替换；任一锚点缺失返回 null（视为自验配置失效）。

const SANITIZE_ANCHOR = 'const _sanitizeSuggestedName = (suggestedName, fallback) => {';

/** M1：把净化函数替换为「页面给什么就返回什么」的透传（漏洞原始形态）。 */
function mutateSanitizerToPassThrough(src) {
  const start = src.indexOf(SANITIZE_ANCHOR);
  if (start === -1) return null;
  const end = src.indexOf('\n};', start);
  if (end === -1) return null;
  const replacement = `${SANITIZE_ANCHOR}
  if (typeof suggestedName !== 'string') return fallback;
  return suggestedName;
}`;
  return src.slice(0, start) + replacement + src.slice(end + 3);
}

/** _buildDefaultSavePath 的两道兜底断言锚点。 */
const NET_ANCHORS = [
  'if (path.resolve(path.dirname(candidate)) !== path.resolve(dir)) {',
  'if (path.basename(safeName) !== safeName) {'
];

/** M2：在 M1 基础上把两道兜底断言改成 if (false)，还原「无任何防护」。 */
function disableContainmentNets(src) {
  let out = src;
  for (const anchor of NET_ANCHORS) {
    if (!out.includes(anchor)) return null;
    out = out.replace(anchor, 'if (false) {');
  }
  return out;
}

const MUTATIONS = [
  ['M1 删空净化函数（保留兜底网，历史盲区）', (s) => mutateSanitizerToPassThrough(s)],
  ['M2 净化与兜底断言全部禁用（还原原始漏洞）', (s) => {
    const m1 = mutateSanitizerToPassThrough(s);
    return m1 === null ? null : disableContainmentNets(m1);
  }]
];

// ── 自验流程 ──

try {
  section('0. 基线：当前代码必须全绿（否则无从谈变异）');
  const base = runVerify();
  check('基线回归套件通过', base.code === 0 && countFailedAssertions(base.out) === 0,
    `exit=${base.code}, 失败断言=${countFailedAssertions(base.out)}`);

  for (const [label, apply] of MUTATIONS) {
    section(label);

    const mutated = apply(original);
    if (mutated === null || mutated === original) {
      // 锚点失配 = 变异没打上去。此时套件当然全绿，若放行就等于
      // 「自验证明不了任何事却报告成功」——正是要防的假绿。
      check(`${label}: 变异锚点命中`, false, '锚点未匹配，净化/断言结构已变化，请同步更新本脚本');
      continue;
    }

    fs.writeFileSync(SRC, mutated, 'utf8');
    let r;
    try {
      r = runVerify();
    } finally {
      fs.writeFileSync(SRC, original, 'utf8');
    }

    const failedCount = countFailedAssertions(r.out);
    check(`${label}: 变异后套件必须出现断言失败`,
      r.code !== 0 && failedCount > 0,
      `exit=${r.code}, 失败断言=${failedCount}（崩溃或全绿都算失败——说明断言已被兜底掩盖或变异未生效）`);
    if (failedCount > 0) {
      console.log(`      捕获到 ${failedCount} 条失败断言（明细见上一次套件运行输出）`);
    }
  }

  section('恢复校验');
  const restored = fs.readFileSync(SRC, 'utf8');
  check('变异结束后源文件逐字节恢复', restored === original);
} finally {
  fs.writeFileSync(SRC, original, 'utf8');
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`变异自验通过：${passed} 项（断言可被证伪）`);
  process.exit(0);
} else {
  console.log(`变异自验失败 ${failures.length} 项：`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
