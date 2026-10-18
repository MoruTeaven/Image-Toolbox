/**
 * canvas 级 clipPath 门禁（挂载为构建门禁第 8 项）。
 *
 * 守护 AGENTS.md §8.1 记载的事故类别：裁剪/打码模块把画布级 clipPath 临时摘掉，
 * 两个模块各自缓存备份会互相覆盖，恢复时把对方的临时 clipPath 当成原始值写回，
 * 图层被永久裁掉。这类bug 不会立刻报错，要等后续操作才显形，所以必须有门禁。
 *
 * 用法：node scripts/verify-clip-path-session.mjs
 * 退出码 0 = 全部通过；非 0 = 有断言失败。
 *
 * 三个层次：
 *   1. 会话本身的不变量（同一实例写回、逐对象还原、幂等、残留检测）；
 *   2. 跨会话隔离——当年的事故正是两个模块各持一份状态；
 *   3. 源码级断言——两个模块真的用了共享会话，而不是又各自实现一份。
 */

import path from 'node:path';
import fs from 'node:fs';
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

// ── fabric 桩件：只需要 clipPath / getObjects / set / requestRenderAll ──

function makeObject(id, clipPath = null) {
  return {
    __id: id,
    clipPath,
    dirty: false,
    set(key, value) {
      if (key === 'clipPath') this.clipPath = value;
      else this[key] = value;
    },
  };
}

function makeCanvas(objects = []) {
  let renders = 0;
  return {
    clipPath: null,
    objects,
    getObjects() { return this.objects; },
    requestRenderAll() { renders += 1; },
    get renderCount() { return renders; },
  };
}

const { acquireClipPathSession, releaseClipPathSession } = await import(
  '../core/src/utils/ClipPathSession.js'
);

// ── 1. 会话不变量 ──

{
  // 同一实例写回：恢复后的 canvas.clipPath 必须是原来那个对象，
  // 不能是等价副本——副本会让「撤销」恢复到错误的状态。
  const original = makeObject('original');
  const canvas = makeCanvas([makeObject('a'), makeObject('b')]);
  canvas.clipPath = original;

  const session = acquireClipPathSession(canvas, { exclude: [] });
  session.detach();
  check('detach 后画布级 clipPath 被摘除', canvas.clipPath === null);
  check('对象级临时挂上了等价 clipPath', canvas.objects.every((o) => o.clipPath === original));

  session.release();
  check('release 后 canvas.clipPath 是同一实例', canvas.clipPath === original,
    canvas.clipPath === original ? '' : '写回了副本或 null');
  check('release 后对象级 clipPath 全部还原为 null',
    canvas.objects.every((o) => o.clipPath === null));
}

{
  // 逐对象还原：各对象原值不同，不得整批写成同一个。
  const shared = makeObject('shared');
  const canvas = makeCanvas([
    makeObject('keepOwn', makeObject('ownA')),
    makeObject('keepNull', null),
  ]);
  canvas.clipPath = shared;

  const session = acquireClipPathSession(canvas, {});
  session.detach();
  session.release();

  check('各对象的 clipPath 写回自己的原值（互不污染）',
    canvas.objects[0].clipPath !== null && canvas.objects[0].clipPath.__id === 'ownA'
    && canvas.objects[1].clipPath === null,
    `a=${canvas.objects[0].clipPath && canvas.objects[0].clipPath.__id} b=${canvas.objects[1].clipPath}`);
}

{
  // exclude：辅助图形不参与临时挂载。
  const shared = makeObject('shared');
  const helper = makeObject('helper');
  const canvas = makeCanvas([makeObject('normal'), helper]);
  canvas.clipPath = shared;

  const session = acquireClipPathSession(canvas, { exclude: [helper] });
  session.detach();
  const helperUntouched = helper.clipPath === null;
  session.release();
  check('exclude 列出的辅助对象不被临时挂载', helperUntouched);
}

{
  // 幂等：重复 release 不得把 canvas.clipPath 写成 null。
  const original = makeObject('original');
  const canvas = makeCanvas([]);
  canvas.clipPath = original;
  const session = acquireClipPathSession(canvas, {});
  session.detach();
  session.release();
  session.release();
  session.release();
  check('重复 release 幂等（clipPath 不被清空）', canvas.clipPath === original);
}

{
  // 残留持有者必须显式炸掉，而不是静默接管另一个会话的备份。
  const canvas = makeCanvas([makeObject('x')]);
  canvas.clipPath = makeObject('c1');
  const first = acquireClipPathSession(canvas, {});
  first.detach();

  let secondThrew = false;
  try {
    acquireClipPathSession(canvas, {});
  } catch {
    secondThrew = true;
  }
  check('同一画布上的第二个会话被拒绝（不静默覆盖备份）', secondThrew);

  first.release();
  const afterRelease = (() => {
    try { acquireClipPathSession(canvas, { return: null }).release(); return true; }
    catch { return false; }
  })();
  check('release 后可再次取得会话（无泄漏）', afterRelease);
}

// ── 2. 跨会话隔离（当年事故的复现场景） ──

{
  // 复盘事故本体：两个模块各自维护状态时，后进入者恢复会把先者的备份
  // 当成原始值写回。共享会话下这个交叉不可能发生——第二个会话根本拿不到。
  const original = makeObject('original');
  const canvas = makeCanvas([makeObject('obj')]);
  canvas.clipPath = original;

  const mosaicLike = acquireClipPathSession(canvas, { exclude: [] });
  mosaicLike.detach();
  // 打码模块此时也想进入：旧实现是 new 一份自己的缓存并直接改 canvas.clipPath。
  // 新实现必须被拒绝，于是 mosaic 的备份不可能被覆盖。
  let cropBlocked = false;
  try { acquireClipPathSession(canvas, { exclude: [] }); }
  catch { cropBlocked = true; }

  mosaicLike.release();
  check('事故场景：后进入者无法覆盖先者的备份', cropBlocked);
  check('事故场景：先者恢复后 clipPath 仍是原始实例', canvas.clipPath === original);
}

{
  // 漏调 release 时的兜底：显式释放接口必须能清掉残留持有者。
  const canvas = makeCanvas([]);
  const s = acquireClipPathSession(canvas, {});
  s.detach();
  releaseClipPathSession(canvas);
  check('releaseClipPathSession 清掉残留持有者', canvas.__clipPathSession === null);
}

// ── 3. 源码级断言：两个模块真的用共享会话 ──

const sessionSrc = fs.readFileSync(path.join(ROOT, 'core/src/utils/ClipPathSession.js'), 'utf8');
check('ClipPathSession.js 导出 acquireClipPathSession', /export function acquireClipPathSession/.test(sessionSrc));

for (const [label, file] of [
  ['MosaicModule', 'core/src/modules/MosaicModule.js'],
  ['CropModule', 'core/src/modules/CropModule.js']
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const usesShared = /ClipPathSession/.test(src);
  const hasPrivateCache = /this\._objectClipPathBackups\s*=/.test(src)
    && /this\._detachedCanvasClipPath\s*=/.test(src);
  check(`${label} 改用共享会话（import ClipPathSession）`, usesShared);
  check(`${label} 不再各自缓存 clipPath 备份`, !hasPrivateCache,
    hasPrivateCache ? '仍持有 _objectClipPathBackups / _detachedCanvasClipPath' : '');
}

console.log('');
if (failures.length > 0) {
  console.error(`❌ clipPath 会话门禁失败：${failures.length} 项`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ 通过：${passed} 项断言（会话不变量 + 跨会话隔离 + 模块已收敛到共享会话）`);
