# 图片工具箱

> 基于 Fabric.js 的轻量图片编辑工具，支持 uTools、ZTools、Web 浏览器多端运行。

当前版本：**v2.4.1**

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
| 形状 | `S` | 矩形、圆形、三角形、五角星、箭头、菱形、平行四边形等 |
| 调色 | — | 滤镜预设 + 亮度 / 对比度 / 饱和度 / 色相 / 模糊参数调整 |
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
│   ├── package.json       # @img-toolbox/core 包定义
│   └── src/
│       ├── index.js       # 公共无环境依赖入口
│       ├── EventBus.js     # 事件总线
│       ├── CanvasManager.js# 画布管理器（Fabric.js 封装）
│       ├── LayerManager.js # 图层管理器
│       ├── HistoryManager.js # 历史记录（撤销/重做）
│       ├── ToolManager.js  # 工具管理器
│       ├── updateRecords.js# 版本更新记录
│       ├── preloadHelpers.js # preload 公共逻辑
│       ├── app/            # 跨平台应用入口
│       ├── adapters/       # 宿主适配器基类
│       ├── identity/       # 轻量认证客户端
│       ├── modules/        # 功能模块（9 个工具）
│       ├── ui/             # UI 组件
│       ├── utils/          # 工具函数
│       ├── runtime/        # Fabric.js 运行时入口
│       └── lib/            # Fabric.js 5.x 本地库文件
├── clients/                # 各平台入口
│   ├── utools/            # uTools 插件
│   ├── ztools/            # ZTools 插件
│   └── web/               # Web 浏览器版
├── build.ps1               # 构建脚本
├── deploy-cf-pages.ps1    # Cloudflare Pages 部署脚本
└── README.md              # 本文档
```

## 开发

### 环境要求

- Node.js（用于构建时 `node --check` 语法校验）
- PowerShell（执行构建脚本）
- 无需 `npm install`，项目无外部依赖，Fabric.js 为本地引入

### 构建

```powershell
.\build.ps1
```

构建流程：
1. 清理 `dist/` 下旧的平台目录
2. 对每个平台（uTools、zTools、web）：复制 `clients/<platform>/` 和 `core/src/` 到 `dist/<platform>/`
3. 自动修正 import 路径
4. 对所有 JS 文件执行 `node --check` 语法校验

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
| 语言 | 纯 JavaScript（ES Module） |
| 引擎 | Fabric.js 5.x（本地引入，非 CDN） |
| UI | 原生 HTML / CSS / JS，无前端框架 |
| 构建 | PowerShell 脚本，无打包工具 |
| 部署 | Cloudflare Pages（Web 端） |

## 更新日志

| 版本 | 日期 | 要点 |
|------|------|------|
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

完整更新记录见 `core/src/updateRecords.js`。
