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
│       ├── HistoryManager.js # 历史记录（撤销/重做）
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
pnpm build
```

构建流程（均由 `scripts/build.mjs` 编排，任一失败即构建失败）：
1. 校验版本号一致性（`scripts/version-check.mjs`）：`packages/changelog/src/changelog.js` 的 `APP_VERSION` 必须与两个 `plugin.json`、`package.json`、`README.md` 声明一致
2. 对每个平台（uTools、zTools、web）用 esbuild 产出 `index.html` / `app.js` / `index.css` 三件套；Electron 端额外产出 `preload.js`，并原样拷贝 `plugin.json`、`logo.png`
3. 依次执行门禁：metafile 输入来源白名单、产物语法与 `#core/` 残留、preload 运行时冒烟、bundle 真实执行冒烟、Web 站点根 404 复算、安全加固 + 变异自验、别名重写安全、UTF-8 BOM 不变量

> 构建脚本是 Node 而非 PowerShell：整条工具链本来就是 Node，PowerShell 层只会带来第二套编码规则——正是那套规则在历史上把 BOM 凭空写进产物（详见 `scripts/bom-report.ps1` 头部说明）。

### 部署 Web 端

```powershell
.\deploy-cf-pages.ps1
```

会自动执行构建 + 修正资源路径 + 部署到 Cloudflare Pages。

### 本地开发

**uTools / ZTools**：将 `dist/uTools/`（或 `dist/zTools/`）放入对应开发者插件目录，加载本地插件即可。

**Web**：将 `dist/web/` 部署到任意静态服务器，或使用 `npx wrangler pages dev dist/web` 本地预览。

### 浏览器端像素级验证（橡皮擦框选模式）

橡皮擦「框选」擦除的像素级行为需要在真实浏览器里验证（`destination-out` 后 alpha 是否归零、
`canvas.getPointer` 的视口坐标换算、撤销恢复等）：

```powershell
.\build.ps1
node scripts/verify-eraser-rect-browser.mjs
```

脚本自包含：起静态服务 → 拉起无头浏览器 → 通过 CDP 注入 `scripts/browser-eraser-rect.page.js`
执行断言 → 收尾清理。可用 `IMG_TOOLBOX_BROWSER` 指定其它 Chromium 系浏览器路径。

> 退出码 `2` 表示**环境不支持**（而非断言失败）。部分 Windows 环境的进程沙箱会阻断
> Chromium 的 mojo 命名管道，浏览器启动即 `FATAL platform_channel.cc Check failed: 0x5 拒绝访问`，
> 此时需换到无该限制的机器或 CI 上运行。

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
