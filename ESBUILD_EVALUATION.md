# esbuild 引入评估：替代 build.ps1「复制 + 路径重写」流程

> 任务：评估引入 esbuild 替代现有构建流程（t-mu21bc5p-8ldurj）
> 结论：**有条件推荐采纳**——技术可行性已全部实证，收益明确（体积 −38%、首屏请求 56→3、消灭最易出错的根镜像逻辑）；非紧急，属性价比改造。建议按文末方案先在 web 端试点。
>
> 评估日期：2026-09-29 ｜ 原型代码：`scripts/proto-esbuild-web.mjs`、`scripts/proto-smoke-bundle.mjs`、`scripts/lib/proto-vendor-wrapper.mjs`、`scripts/proto-verify-web.ps1`（产物输出在 `dist-proto/`，已加入 .gitignore）

---

## 1. 验证了什么（证据清单）

| # | 命题 | 结果 | 证据 |
|---|------|------|------|
| 1 | `#core/` 别名在 esbuild 下可解析 | ✅ | esbuild 原生支持 package.json `imports` 子路径。metafile 显示 51 个输入模块中 46 个为 `core/src/*`，全部经 `#core/` 解析进 bundle；产物内 `#core/` 零残留 |
| 2 | web 端可打包为自包含产物 | ✅ | `dist-proto/web-esbuild/`：index.html + app.js + index.css，从站点根服务实测 `/`、`/app.js`、`/index.css` 全部 200（favicon 404 属正常，与现有门禁口径一致） |
| 3 | bundle 真实可执行 | ✅ | `proto-smoke-bundle.mjs`：Node + 仓库自有 DOM 桩件（`scripts/test-env.mjs`，与安全门禁同一深度）**真实执行 bundle 产物**——真 fabric 挂载 globalThis（version 5.3.0 ✓）、JSZip 挂载 ✓、App/WebHostAdapter 类可用 ✓、EventBus emit/on ✓。压缩版 app.min.js 同套断言全过 |
| 4 | uTools/ZTools 插件目录形态可满足 | ✅ | `dist-proto/utools-esbuild/` 实证：plugin.json 原样（main=src/index.html）、preload.js 由 esbuild 打成 **CJS 单文件**（49.6KB，含 preloadHelpers 内联，`node --check` 通过，不再依赖 dist 内的 core 副本）、logo.png/src 结构齐全 |
| 5 | 体积/启动方式可量化对比 | ✅ | 见 §2 |
| 6 | 浏览器级实测（真实渲染） | ⚠️ 未在本会话完成 | 本会话沙箱拦截 Edge/浏览器子进程（crashpad 被拒），无法跑无头浏览器。已提供复现命令：本地执行 `PowerShell -ExecutionPolicy Bypass -File scripts/proto-verify-web.ps1 -Port 28137`（静态服务 + Edge dump-dom + toolbar__btn 挂载断言）。**采纳前必须完成此步** |

## 2. 三端产物形态对比

### 现状（build.ps1，v2.5.1-dev 实测）

| 端 | 体积 | 文件数 | 首屏加载方式 |
|----|------|--------|-------------|
| dist/web | 1.18 MB | 73 | index.html → 5 个静态资源 + **约 51 个 ES 模块逐个网络请求（瀑布）** |
| dist/uTools | 1.16 MB | 70 | file:// 协议加载，同样 51 文件瀑布（无 HTTP 缓存优势） |
| dist/zTools | 1.16 MB | 70 | 同上 |

### esbuild 原型（实测数据）

| 形态 | 线上体积 | 文件数 | 首屏请求 |
|------|---------|--------|---------|
| web 未压缩 | 1.08 MB | 3 | 3（html + css + js） |
| **web 压缩（minify）** | **0.75 MB** | **3** | **3** |
| uTools/zTools 压缩（推算） | ~0.85 MB/端 | ~6 | 单文件 app.js + css |

构成拆解：vendor（fabric 304 KB + jszip 95 KB，已是 min 形态）≈ 399 KB 为体积下限；自研代码 790 KB → 压缩后 ~300 KB（−62%）。**tree-shaking 收益≈0**（App 启动链把几乎全部 core 模块都用上了），真正的收益是：压缩、消除三端 3 份 core 源码副本中的重复请求形态、消灭 dist/web 的「根镜像」双份拷贝、以及可选 sourcemap。

### 启动方式变化

- **web**：静态服务不变；首屏请求从 ~56 降到 3。对 Cloudflare Pages（HTTP/2 多路复用）是次要收益，对弱网/首屏指标是主要收益。
- **uTools/ZTools**：加载协议完全不变——plugin.json → preload.js（仍是 Electron CJS `require`，产物形态兼容，且 dist 内无 package.json，不会踩 `type:module` 坑）→ file:// 页面。页面从 51 文件串行加载变 1 个文件，插件冷启动应有可感知提速（建议试点期实测对比）。
- **本地开发/部署工作流**：`dist/<platform>` 放 uTools 开发者目录、wrangler 部署 dist/web 等流程均不变。

## 3. uTools/ZTools 插件规范兼容性

| 规范点 | 兼容性 | 说明 |
|--------|--------|------|
| plugin.json `main`/`preload`/`logo` 字段 | ✅ | 产物路径由构建脚本自由摆放，esbuild 无约束（原型已验证） |
| preload 必须 CommonJS（Electron require） | ✅ | esbuild `--format=cjs --platform=node` 直出，`require("electron")` 以 external 保留（原型已验证） |
| 禁止加载网络资源 | ✅ | bundle 100% 本地，无 CDN 引用；产物内无 fetch 新依赖 |
| 第三方许可证注释 | ✅ | JSZip/fabric 的 `/*! */` 头注释经 `--legal-comments=inline` 保留在压缩产物；`jszip-LICENSE.txt` 随 core 资源照旧分发（bundled 源码副本不再进 dist，但 vendored 源文件仍在仓库） |
| 版本一致性门禁（version-check.ps1） | ✅ 不受影响 | 基于源码文件校验，与打包无关 |
| 安全门禁（verify-security-hardening + mutation-check） | ✅ 不受影响 | 二者加载 `core/src` 源码与 `clients/*` 源文件，不依赖 dist 形态 |
| `node --check` 门禁 | ⚠️ 需改目标 | 从「逐文件 70 个」变为「bundle 3 个」，脚本需适配（工作量小，门禁本身仍有效） |
| `#core/` 残留检查 | ⚠️ 需替换等价断言 | bundle 天然无别名残留；建议改为 metafile 检查（所有输入均为项目内文件、external 白名单仅 jsdom/electron）+ 保留现检查作为双保险 |

## 4. 风险与代价

1. **vendor wrapper 是新增维护面（中等）**：fabric.min.js（UMD exports 分派 + 内部裸 `fabric` 标识符）和 jszip.min.js（Browserify UMD，`module.exports = f()`）从 `<script>` 全局改为「包装成 ES 模块副作用导入」。两套 wrapper 规则不同、注释里有完整推导；**升级这两个库时必须重新过冒烟**。缓解：冒烟脚本可并入构建门禁（原型即门禁形态）。
2. **fabric 的 jsdom 死分支留在 bundle 内（低）**：`require("jsdom")` 在无 document/window 时才执行，浏览器/ESM 环境不可达（冒烟已证）。esbuild 需加 `--external:jsdom*` 才能构建，这一 flag 应写死在构建脚本。
3. **引入 npm/esbuild 依赖链（决策点）**：AGENTS.md §8.3 明确「不使用 npm/打包工具」。采纳即修订该原则（构建期 devDependency 与运行时无关，dist 依旧零依赖——可加 npm-shrinkwrap 锁版本）。这是治理决定，不是技术障碍。
4. **本会话未覆盖浏览器级实测**：Edge 无头被沙箱拦截（环境限制）。试点阶段第 1 步就是补这一脚（命令已备好）。
5. **sourcemap 体积（低）**：每 bundle ~1.7MB map。web 部署可选携带（线上更省流量，调试更好）；不携带则 map 存本地。
6. **调试方式变化（低）**：dist 不再逐文件对应源码，stack 靠 sourcemap 还原。对 uTools 插件日志排障是一次工作流习惯改变。
7. **本沙箱限制备忘**：node 内 `child_process.spawn` 外部 exe 被拦截，esbuild JS API 报 `spawn EPERM`。本次评估以直接调用 `node_modules/@esbuild/win32-x64/esbuild.exe` CLI 绕过，构建脚本设计不受影响（本地/CI 正常）。

## 5. 分步迁移方案（推荐）

**原则**：build.ps1 全程保留，每一步可独立回退；web 先行，Electron 两端最后动。

- **Phase 0（准备，半天）**：仓库根 `npm init`（**严禁加 `type:module`**，现有构建门禁已有校验）+ `npm i -D esbuild@0.28.x`（锁版）；AGENTS.md 增加「构建期 devDependency」例外说明。
- **Phase 1（web 试点，1 天）**：
  1. 把 `scripts/proto-esbuild-web.mjs` 转正为 `scripts/build-web.mjs`（入口直接指 `clients/web/src/index.js`，删掉本次为演示搭的 staging 间接层；vendor wrapper 从 proto 文件抽成正式 `scripts/lib/vendor-wrapper.mjs`）；
  2. 产物写 `dist-proto/web/` 与现有 `dist/web` 并存；
  3. 三道验收：`verify-web-root-load.mjs` 适配新形态（3 文件断言）、`proto-smoke-bundle.mjs` 并入构建、本地跑 `proto-verify-web.ps1`（Edge 真实渲染）；
  4. 手动走一遍「部署 Cloudflare Pages」确认 deploy-cf-pages.ps1 只换目录来源即可。
- **Phase 2（web 转正，半天）**：build.ps1 的 web 分支改调 `build-web.mjs`；**删除 `New-WebRootIndex`、`Copy-WebPageFile`、根镜像与逐层路径重写逻辑**（约 200 行，历史上 404 事故的根源）；Test-WebIndex 断言改为「3 文件形态 + metafile 无意外 external + node --check 产物」。
- **Phase 3（uTools/zTools，1 天）**：新增 `scripts/build-electron.mjs`：页面入口 → `src/app.js`（esm，min），preload 入口 → `preload.js`（cjs，external electron）；plugin.json/logo.png 照旧复制；产物写 `dist-proto/<平台>/`，把文件夹放进 uTools 开发者目录**实机回归**（重点：打码/裁剪/文字/ORA 导入导出/粘贴截图/关于页版本号——版本号取值链路走 plugin.json，不受打包影响）。
- **Phase 4（清理，半天）**：`Update-ImportPaths` 及 `#core/` 重写正式退役（源码继续用 `#core/` 写 import，esbuild 原生解析）；保留 `#core/` 残留检查作为 metafile 断言的兜底；门禁日志、文档、agents.md 同步。
- **回退路径**：任一 Phase 出问题，直接回到 build.ps1 原分支（复制+重写逻辑在 Phase 2/4 之前全程保留）。

## 6. 结论

- **可行性**：已验证通过——#core/ 解析、三端形态、bundle 执行、preload CJS、插件规范兼容、体积收益，全部有产物与脚本证据（`dist-proto/` 可复现）。
- **必要性**：中等。现状构建正确工作；esbuild 解决的是体积、首屏、以及 build.ps1 里最脆的一段（根镜像/路径重写）。**不是必须，但做了明显更好**。
- **建议**：采纳，走 Phase 0→4，web 先试点，Electron 两端实机回归后再切换。唯一需要用户拍板的是 AGENTS.md「不使用打包工具」原则的修订。

## 7. 复现命令（本地）

```powershell
# 原型构建（未压缩 + 压缩 + CSS + HTML 改写 + 统计）
npm i --no-save --ignore-scripts esbuild
node scripts/proto-esbuild-web.mjs --keep-vendor
node scripts/proto-esbuild-web.mjs --minify

# CLI 直打包形态（本会话实际采用，绕过 JS API 沙箱限制）
node_modules\@esbuild\win32-x64\esbuild.exe dist-proto/.staging/entry.web.js --bundle --outfile=dist-proto/web-esbuild/app.js --format=esm --platform=browser --target=chrome100 --charset=utf8 --sourcemap --external:jsdom --external:jsdom/lib/*

# Node 桩件级冒烟（与安全门禁同深度）
node scripts/proto-smoke-bundle.mjs dist-proto/web-esbuild/app.smoke.mjs
node scripts/proto-smoke-bundle.mjs dist-proto/web-esbuild/app.js

# 浏览器级实测（本机有 Edge 时）
PowerShell -ExecutionPolicy Bypass -File scripts/proto-verify-web.ps1 -Port 28137
```

注：`proto-esbuild-web.mjs` 使用 esbuild JS API；若所在环境禁止 node spawn 子进程（如本评估沙箱），改用上面第 2 行的 CLI 直调，参数完全等价。
