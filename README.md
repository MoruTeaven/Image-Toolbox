# 图片工具箱

> 基于 Fabric.js 的轻量图片编辑工具，支持 uTools、ZTools、Web 浏览器多端运行。

当前版本：**v3.0.0-dev**

项目官网：[https://image-toolbox.moruteaven.com](https://image-toolbox.moruteaven.com)

## 功能一览

| 工具 | 快捷键 | 说明 |
|------|--------|------|
| 移动/框选 | `V` | 选中并移动图层，支持旋转 / 翻转 / 缩放 |
| 打码 | `M` | 矩形框选或画笔涂抹，支持马赛克 / 模糊，自由选区模式 |
| 剪切 | `C` | 自由或固定比例裁剪，支持非矩形裁剪 |
| 文字 | `T` | 添加文字标注，支持描边（内外）/ 背景 / 删除线 / 系统字体 |
| 画笔 | `B` | 自由涂鸦，可选颜色和粗细 |
| 橡皮擦 | `E` | 擦除当前图层像素，实时显示擦除效果 |
| 形状 | `S` | 矩形、圆形、三角形、五角星、箭头、菱形、平行四边形、五边形等 |
| 调色 | — | 效果图预览的滤镜预设 + 亮度 / 对比度 / 饱和度 / 色相 / 模糊参数调整 |
| 导出 | — | 保存为 PNG / JPEG / WebP，或复制到剪贴板 |

**通用操作**：撤销（`Ctrl+Z`）/ 重做（`Ctrl+Y`）、滚轮缩放（以鼠标位置为中心）、深色 / 浅色主题切换。

## 多端支持

| 平台 | 状态 | 说明 |
|------|------|------|
| uTools | ✅ 已上线 | 支持「图片编辑」关键词、拖拽图片、文件右键进入 |
| ZTools | ✅ 已上线 | 与 uTools 功能对等，按 ZTools 插件规范独立加载 |
| Web | ✅ 已上线 | 浏览器直接使用 |

## 架构

```text
┌─────────────────────────────────────────────────┐
│  App / Host Layer (uTools / ZTools / Web)       │
├─────────────────────────────────────────────────┤
│  UI Layer (Toolbar / OptionsBar / PropertyPanel)│
├─────────────────────────────────────────────────┤
│  Editor Core (EventBus / LayerStore / History)  │
├─────────────────────────────────────────────────┤
│  Engine Adapter (Fabric.js 5.x)                 │
├─────────────────────────────────────────────────┤
│  Effect Core (Mosaic / Blur / Crop 像素算法)     │
└─────────────────────────────────────────────────┘
```

核心设计原则：`core/` 只依赖统一接口，不判断平台。各客户端在 `clients/*/src/adapters/host/` 中实现自己的 `HostAdapter`，通过依赖注入提供文件、剪贴板、窗口、存储等端侧能力。

详见 [CORE_ARCHITECTURE.md](CORE_ARCHITECTURE.md)。

## 目录结构

```text
图片工具箱 - 客户端/
├── core/                   # 跨端共享核心
│   ├── package.json       # @moruteaven/img-toolbox_core 包定义
│   └── src/
│       ├── index.js       # 公共无环境依赖入口
│       ├── EventBus.js     # 事件总线
│       ├── CanvasManager.js# 画布管理器（Fabric.js 封装）
│       ├── LayerManager.js # 图层管理器
│       ├── HistoryManager.js # 历史记录（撤销/重做 + 时间线）
│       ├── ToolManager.js  # 工具管理器
│       ├── preloadHelpers.cjs # preload 公共逻辑（CJS，见 AGENTS.md §7.2）
│       ├── app/            # 跨平台应用入口
│       ├── adapters/       # 宿主适配器基类
│       ├── identity/       # 轻量认证客户端
│       ├── modules/        # 功能模块（9 个工具）
│       ├── ui/             # UI 组件
│       ├── utils/          # 工具函数
│       ├── runtime/        # Fabric.js 运行时入口
│       └── lib/            # Fabric.js 5.x 本地库文件
├── packages/              # 可独立子包（pnpm workspace: ora, changelog）
│
├── clients/                # 各平台入口
│   ├── utools/            # uTools 插件
│   ├── ztools/            # ZTools 插件
│   └── web/               # Web 浏览器版
├── scripts/
│   ├── build.mjs               # 构建编排入口（`pnpm build`，替代原 build.ps1）
├── deploy-cf-pages.ps1    # Cloudflare Pages 部署脚本
└── README.md              # 本文档
```

## 开发

### 环境要求

- Node.js（构建、门禁、`node --check` 语法校验）
- 构建前需 `pnpm install`（esbuild 是构建期 devDependency）；运行时依赖（Fabric.js 本地文件；fflate/fast-xml-parser、ag-psd 经 npm 安装打包；Teaven Identity SDK npm 安装）不依赖 CDN
- Teaven Identity SDK 经 npm 安装，升级用 `pnpm update @moruteaven/identity-sdk`

### 构建

```powershell
pnpm install   # 首次或依赖变更后必须执行（esbuild 是 devDependency）
pnpm build
```

构建流程（均由 `scripts/build.mjs` 编排，任一失败即构建失败）：
1. 校验版本号一致性（`scripts/version-check.mjs`）：`packages/changelog/src/changelog.js` 的 `APP_VERSION` 必须与两个 `plugin.json`、`package.json`、`README.md` 声明一致
2. 对每个平台（uTools、zTools、web）用 `scripts/prepare-build.mjs` 准备暂存（vendor 包装 + bundle 入口 + 页面改写，脚本自带断言），再由 esbuild 产出 `index.html` / `app.js` / `index.css` 三件套；Electron 端额外产出 `preload.js`，并原样拷贝 `plugin.json`、`logo.png`
3. 依次执行门禁（任一失败即构建失败），清单如下：

| # | 脚本 | 检查什么 |
|---|------|----------|
| 0 | `scripts/version-check.mjs` | 版本号一致性（源码与 dist 各跑一次） |
| 1 | `scripts/verify-artifact.mjs` | esbuild metafile 的输入来源与 external 白名单 |
| 2 | `scripts/verify-bundle-smoke.mjs` | 页面 bundle 在 DOM 桩件下真实执行 |
| 3 | `scripts/verify-preload-smoke.mjs` | preload bundle 真 `require()` 并完成桥接；隔离关闭（uTools 真实形态）时断言一次 contextBridge 都不许调；含变异自验 |
| 4 | `scripts/verify-web-root-load.mjs` | Web 产物按站点根复算首屏请求，有 404 即失败 |
| 5 | `scripts/verify-security-hardening.mjs` + `scripts/mutation-check-sanitizers.mjs` | 安全加固断言 + 变异自验；两项完整输出写入 `dist/security-gate.log`，失败时全文回放 |
| 6 | `scripts/verify-alias-rewrite.mjs` | `#core/` 别名重写安全 |
| 7 | `scripts/verify-clip-path-session.mjs` | canvas 级 clipPath 会话 |
| 8 | `scripts/verify-filter-params-table.mjs` | 调色参数表唯一来源 |
| 9 | `scripts/bom-report.ps1` | UTF-8 BOM 不变量 |
| 10 | `scripts/verify-doc-refs.mjs` | 本文与 `AGENTS.md` 引用的脚本必须真实存在，且构建实际调用的门禁必须在本文列出 |

> 上表与 `scripts/build.mjs` 的实际调用**互为镜像**，第 10 项门禁就是查这件事：
> 它同时检查两个方向——文档提到的脚本必须存在、构建调用的门禁必须在本文出现。
> 历史上 `verify-clip-path-session.mjs` 曾在文档里被列为门禁而文件从未入库（手动跑必 `ERR_MODULE_NOT_FOUND`），
> `verify-filter-params-table.mjs` 则相反——它在构建里跑，文档却一字未提。
> 两种偏差都会让人按文档判断质量，而结论是错的。
>
> 因此新增或删除门禁脚本时，**必须同时改三处**：`build.mjs` 的调用与头部编号注释、本节上表、`AGENTS.md` §6.1。
> 漏改任何一处，第 10 项门禁会直接让构建失败并指名道姓。

> 构建脚本是 Node 而非 PowerShell：整条工具链本来就是 Node，PowerShell 层只会带来第二套编码规则——正是那套规则在历史上把 BOM 凭空写进产物（详见 `scripts/bom-report.ps1` 头部说明）。
>
> 另一个原因来自 PowerShell 5.1 的流语义：native 命令写到 stderr 的**任何**一行都会被包成
> ErrorRecord，遇到 `$ErrorActionPreference = "Stop"` 就升级为终止错误。原 `build.ps1`
> 因此在 uTools 端把一条「preload API 未注册」的告警当成构建失败（产物其实已经齐全），
> 只能在每个 `node` 调用点临时放宽偏好来绕开。改由 Node 编排后，这类「构建成功却报失败」
> 不再可能发生；**不要把构建入口再引回 PowerShell 层**（`scripts/verify-web-deploy.ps1`
> 里对 Edge 的临时放宽是脚本内的局部处理，不是构建入口）。

#### 全新 worktree 首次构建前必读

pnpm 11 起，`pnpm build` 会先跑一次 deps-status 检查，要求所有依赖的安装脚本都已在
`pnpm-workspace.yaml` 的 `allowBuilds` 中显式批准；未批准时安装即以
`ERR_PNPM_IGNORED_BUILDS` 失败，`pnpm build` 在构建脚本开始前就中断。本仓库需要
`esbuild`（postinstall 负责校验平台二进制），因此该条目必须是确定的 `true`：

```yaml
allowBuilds:
  esbuild: true
```

占位值（pnpm 自动写入的 `set this to true or false`）不算批准，同样会让检查失败。
若在只读或离线环境下不方便跑安装，可绕过该检查直接执行编排脚本
`node scripts/build.mjs`（等价于 `pnpm build`，全部门禁一致）。

### 部署 Web 端

```powershell
.\deploy-cf-pages.ps1
```

会自动执行构建 + 修正资源路径 + 部署到 Cloudflare Pages。

### 本地开发

**uTools / ZTools**：将 `dist/uTools/`（或 `dist/zTools/`）放入对应开发者插件目录，加载本地插件即可。

**Web**：将 `dist/web/` 部署到任意静态服务器，或使用 `npx wrangler pages dev dist/web` 本地预览。

## 技术栈

| 项目 | 选型 |
|------|------|
| 语言 | 纯 JavaScript（ES Module），`#core/` 别名引用共享核心 |
| 引擎 | Fabric.js 5.x（本地引入，非 CDN） |
| UI | 原生 HTML / CSS / JS，无前端框架 |
| 构建 | `pnpm build`（Node 编排 `scripts/build.mjs` 调用 esbuild 打包并执行门禁） |
| 部署 | Cloudflare Pages（Web 端） |

## 更新日志

| 版本 | 日期 | 要点 |
|------|------|------|
| 2.6.1-dev | 2026-10-06 | 调色新增中间调参数；新增通透、浓郁、褪色等滤镜预设；暖色、鲜艳等预设改用自然饱和度 |
| 2.6.0 | 2026-10-06 | 图层复制、右键菜单（复制/重命名/删除）、图层对齐与分布、图层混合模式、调色自然饱和度参数；修复打开插件初始化失败的问题 |
| 2.5.0 | 2026-09-23 | 调色预设改为效果图卡片，直接显示当前图层调色效果；新增贴纸功能；橡皮擦新增框选模式，拖拽即可一次擦除整片区域；修复保存图片或 ORA 工程文件失败时没有任何提示的问题；修复 Web 版样式丢失、ORA 无法导入导出的问题 |
| 2.4.3 | 2026-08-31 | 新增五边形图形、画笔光标指示修复与增强 |
| 2.4.2 | 2026-08-22 | ORA 工程文件导入/导出、马赛克/橡皮擦工具鼠标状态修复 |
| 2.4.1 | 2026-08-21 | 字体检测跨平台兼容、图片加载与重复进入修复、滚轮缩放以鼠标位置为中心 |
| 2.4 | 2026-08-04 | 工具栏展开/收起、菱形图形、统一账号系统接入 |
| 2.3.1 | 2026-07-17 | 侧栏图标文字选项、调色面板内存修复、ZTools 适配器修复 |
| 2.3 | 2026-07-09 | 调色工具（滤镜预设 + 参数调整）、多项 Bug 修复 |
| 2.2.2 | 2026-06-29 | 平行四边形图形、文字删除线、JPEG/WebP 格式修复 |
| 2.2.1 | 2026-06-26 | 三角形/双箭头图形、文字描边位置、异步字体加载 |
| 2.2 | 2026-06-23 | ZTools 客户端、图形工具、多端适配 |
| 2.1.1 | 2026-06-15 | 马赛克自由选区模式、动态重算 |
| 2.1 | 2026-06-13 | 画笔工具、橡皮擦工具、非矩形裁剪 |
| 2.0 | 2026-06-12 | 面板布局切换、裁剪多项修复 |
| 1.0 | 2026-06-10 | 首个可用版本 |

完整更新记录与版本号定义见 `packages/changelog/src/changelog.js`。
