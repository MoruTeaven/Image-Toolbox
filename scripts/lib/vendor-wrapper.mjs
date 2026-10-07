// 把 classic-script 的 fabric.min.js 包装成可被 esbuild 打包的 ES 模块。
//
// 源码页面里 fabric 以 <script> 全局方式加载（core/src/lib/fabric.min.js），
// 其余模块裸用全局 fabric。打包后没有 <script> 标签，
// 所以用本模块生成「副作用导入」包装，让库在 bundle 顶层自行挂到 globalThis。
import fs from 'node:fs';
import path from 'node:path';

export function readVendorSource(root) {
  return {
    fabric: fs.readFileSync(path.join(root, 'core', 'src', 'lib', 'fabric.min.js'), 'utf8')
  };
}

// fabric.min.js 的 UMD 分派：
//   "undefined" != typeof exports ? exports.fabric = fabric : ...
// 文件内部又散落裸 fabric 标识符（如 fabric.util.object.extend(...)），
// 两者同时成立：既要提供真实 module/exports 接住 UMD 分派，
// 也要把结果显式挂回 globalThis.fabric 供其余模块裸用。
//
// 附带 jsdom 死分支：fabric 在「无 document/window」时 require("jsdom")。
// 浏览器与打包环境不会触达该分支（顶层若无 require 会立即 ReferenceError），
// 构建时必须 --external:jsdom* 才能通过 esbuild 的解析。
export function wrapFabric(source) {
  return [
    '// 构建期生成：classic-script 全局库 → ES 副作用模块。勿手改。',
    'const module = { exports: {} };',
    'const exports = module.exports;',
    '(function () {',
    source,
    '})();',
    'globalThis.fabric = exports.fabric;',
    "if (!globalThis.fabric) { throw new Error('fabric 未能注册到 globalThis'); }",
    'export default globalThis.fabric;',
    ''
  ].join('\n');
}
