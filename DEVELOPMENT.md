# 图片工具箱 — uTools 插件开发文档

> 基于 Fabric.js 的图片编辑助手，作为 uTools 插件运行。
> 当前版本：v0.1（基础功能） | 最后更新：2026-06-08

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [uTools 插件规范](#3-utools-插件规范)
4. [目录结构](#4-目录结构)
5. [架构设计](#5-架构设计)
6. [核心模块](#6-核心模块)
   - [6.1 画布管理器](#61-画布管理器-canvasmanager)
   - [6.2 打码模块](#62-打码模块-mosaicmodule)
   - [6.3 剪切模块](#63-剪切模块-cropmodule)
    - [6.4 加字模块](#64-加字模块-textmodule)
    - [6.5 图形工具](#65-图形工具-shapemodule)
    - [6.6 导出模块](#66-导出模块-exportmodule)
    - [6.7 历史记录模块](#67-历史记录模块-historymodule)
7. [plugin.json 配置](#7-pluginjson-配置)
8. [preload.js 设计](#8-preloadjs-设计)
9. [UI 布局设计](#9-ui-布局设计)
   - [9.1 整体布局（五区结构）](#91-整体布局五区结构)
   - [9.2 配色方案](#92-配色方案)
   - [9.3 主题切换实现](#93-主题切换实现)
   - [9.4 工具栏按钮设计](#94-工具栏按钮设计)
   - [9.5 选项栏](#95-选项栏按工具动态切换)
   - [9.6 属性面板](#96-属性面板右侧上)
   - [9.7 图层面板](#97-图层面板右侧下)
   - [9.8 状态栏](#98-状态栏)
10. [功能扩展指南](#10-功能扩展指南)
11. [编码规范](#11-编码规范)
12. [构建与调试](#12-构建与调试)
13. [待办与路线图](#13-待办与路线图)

---

## 1. 项目概述

**图片工具箱**是一款运行在 uTools 中的图片编辑助手插件。用户通过 uTools 搜索框快速呼出，对图片进行**打码（马赛克/模糊）、剪切（裁剪）、加字（文字标注）**等基础编辑操作，编辑完成后导出或复制到剪贴板。

### 核心设计理念

- **轻量即用**：不依赖重型编辑器，通过 uTools 快速呼出，用完即走
- **非破坏性编辑**：所有操作基于 Fabric.js 画布层，不修改原始图片数据，支持撤销/重做
- **模块化扩展**：每个编辑功能封装为独立模块，方便后续添加新功能
- **可配置化**：工具栏按钮、快捷键、默认参数均可通过配置调整

---

## 2. 技术栈

| 层 | 技术 | 版本 | 说明 |
|---|------|------|------|
| 运行环境 | uTools + Electron | ≥ 3.0 | uTools 内置 Chromium / Node.js |
| 画布引擎 | Fabric.js | 5.x | 核心图片编辑能力 |
| UI 框架 | 原生 HTML/CSS/JS | — | 轻量无框架依赖，直接操作 DOM |
| 图标库 | Lucide / 自定义 SVG | — | 工具栏图标 |
| 构建工具 | 无（直接加载） | — | 纯静态资源，uTools 直接运行 |
| 代码规范 | ESLint + Prettier | — | 可选，保持风格一致 |

### 为什么不引入框架？

- uTools 插件窗口小（默认 544px 高），不需要重型前端框架
- 插件功能聚焦于画布操作，DOM 操作量不大
- 减少打包体积，加快插件加载速度
- 如需引入，推荐 Preact（3KB）或 Vue 3 CDN 引入

---

## 3. uTools 插件规范

### 3.1 插件生命周期

```
uTools 启动
  └→ 加载 plugin.json
       └→ 加载 preload.js（Node.js 环境，可访问 fs、path 等）
            └→ 打开 main（index.html）
                 └→ 用户输入关键词匹配 → utools.onPluginEnter 触发
                      └→ 插件运行
                           └→ 用户退出 / 切换功能 → 窗口隐藏/销毁
```

### 3.2 关键 API

| API | 用途 | 调用时机 |
|-----|------|---------|
| `utools.onPluginEnter(callback)` | 插件入口，接收 feature code 和 payload | 用户进入插件时 |
| `utools.onPluginOut(callback)` | 插件退出回调，用于清理资源 | 用户退出插件时 |
| `utools.setExpendHeight(h)` | 设置窗口高度 | 动态调整 UI 时 |
| `utools.showOpenDialog(opts)` | 打开文件选择对话框 | 导入图片时 |
| `utools.showSaveDialog(opts)` | 打开文件保存对话框 | 导出图片时 |
| `utools.copyImage(imgPath)` | 复制图片到剪贴板 | 导出到剪贴板 |
| `utools.showNotification(body)` | 系统通知 | 操作完成提示 |
| `utools.setSubInput(callback)` | 设置子输入框 | 搜索/参数输入 |
| `utools.removeSubInput()` | 移除子输入框 | 关闭子输入 |

### 3.3 插件匹配方式

图片工具箱支持以下入口方式：
1. **关键词搜索**：输入"打码""图片编辑""马赛克"等命中功能指令
2. **图片匹配（img）**：在 uTools 中粘贴截图或拖入图片时自动匹配
3. **文件匹配（files）**：选中图片文件后通过超级面板呼出

---

## 4. 目录结构

```
图片工具箱 - uTools/
├── plugin.json              # uTools 插件核心配置
├── preload.js               # 预加载脚本（Node.js 环境）
├── logo.png                 # 插件 Logo (128×128)
├── README.md                # 用户说明
├── DEVELOPMENT.md           # 本文件 — 开发文档
│
├── src/                     # 前端源码
│   ├── index.html           # 插件主页面
│   ├── index.js             # 主入口逻辑
│   ├── style.css            # 全局样式
│   │
│   ├── core/                # 核心层
│   │   ├── CanvasManager.js # 画布管理器（封装 Fabric.js）
│   │   ├── LayerManager.js  # 图层管理器（z-order / 显隐 / 锁定）
│   │   ├── ToolManager.js   # 工具管理器（工具栏状态、切换）
│   │   ├── HistoryManager.js# 历史记录（撤销/重做）
│   │   └── EventBus.js      # 事件总线（模块间通信）
│   │
│   ├── modules/             # 功能模块
│   │   ├── MosaicModule.js  # 打码（马赛克/模糊）
│   │   ├── CropModule.js    # 剪切（裁剪）
│   │   ├── TextModule.js    # 加字（文字标注）
│   │   └── BaseModule.js    # 模块基类
│   │
│   ├── ui/                  # UI 组件
│   │   ├── Toolbar.js       # 工具栏
│   │   ├── OptionsBar.js    # 选项栏（顶部动态参数控件）
│   │   ├── PropertyPanel.js # 属性面板（字号/颜色/描边等）
│   │   ├── LayerPanel.js    # 图层面板（显隐/锁定/排序）
│   │   └── StatusBar.js     # 状态栏（尺寸/图层数/导出）
│   │
│   └── utils/               # 工具函数
│       ├── image.js         # 图片加载/导出工具
│       └── constants.js     # 常量定义
│
└── assets/                  # 静态资源
    ├── icons/               # SVG 图标
    └── fonts/               # 字体文件（如需内嵌）
```

---

## 5. 架构设计

### 5.1 分层架构

```
┌─────────────────────────────────────┐
│             UI 层                    │
│  Toolbar  PropertyPanel  StatusBar  │
└──────────────┬──────────────────────┘
               │ 事件 (EventBus)
┌──────────────▼──────────────────────┐
│           工具管理层                  │
│  ToolManager → 工具栏状态 | 工具切换  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│           功能模块层                  │
│  MosaicModule CropModule TextModule │
│  (继承 BaseModule)                  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│           核心层                     │
│  CanvasManager  HistoryManager      │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│           Fabric.js 画布引擎         │
└─────────────────────────────────────┘
```

### 5.2 数据流

```
用户操作 → Toolbar 发出事件
  → ToolManager 切换当前工具
    → Module.activate() 激活功能模块
      → CanvasManager 修改画布状态
        → Fabric.js Canvas 渲染更新
          → HistoryManager 记录操作快照
```

### 5.3 事件总线设计

使用发布-订阅模式解耦模块间通信：

```js
// EventBus 核心事件
EventBus.on('tool:changed', (toolName) => { /* 工具栏切换 */ })
EventBus.on('module:activated', (moduleName) => { /* 模块激活 */ })
EventBus.on('canvas:updated', () => { /* 画布变更 */ })
EventBus.on('history:changed', (state) => { /* 撤销/重做状态变化 */ })
EventBus.on('image:loaded', (img) => { /* 图片加载完成 */ })
EventBus.on('export:request', (format) => { /* 导出请求 */ })
```

---

## 6. 核心模块

### 6.1 画布管理器 (CanvasManager)

封装 Fabric.js 画布的创建、配置和基础操作，作为所有编辑功能的底层依赖。

```js
class CanvasManager {
  constructor(canvasElId) {
    this.canvas = null       // Fabric.Canvas 实例
    this.originalImage = null// 原始图片（未编辑状态）
    this.zoomLevel = 1       // 当前缩放级别
  }

  // ── 生命周期 ──
  init(options)              // 初始化画布
  destroy()                  // 销毁画布，释放内存

  // ── 图片操作 ──
  loadImage(source)          // 加载图片（支持 URL / File / DataURL / 剪贴板）
  replaceImage(source)       // 替换当前图片
  getImageData()             // 获取画布当前图片数据 (DataURL)
  fitToCanvas()              // 图片自适应画布大小

  // ── 画布控制 ──
  setZoom(level, point)      // 设置缩放
  zoomIn() / zoomOut()       // 放大 / 缩小
  resetZoom()                // 重置为 100%
  toggleGrid(show)           // 显示/隐藏网格

  // ── 物件管理 ──
  addObject(obj)             // 添加物件
  removeObject(obj)          // 移除物件
  getActiveObject()          // 获取选中物件
  clearOverlays()            // 清除所有覆盖层（保留原图）
  toJSON() / fromJSON()      // 序列化/反序列化画布状态
}
```

#### 初始化配置

```js
const DEFAULT_CANVAS_OPTIONS = {
  width: 800,
  height: 600,
  backgroundColor: '#2c2c2c',     // 深色背景，突出图片
  preserveObjectStacking: true,    // 保持物件堆叠顺序
  selection: true,                 // 允许框选
  stopContextMenu: true,           // 禁用右键菜单
  fireRightClick: true,            // 允许右键事件
}
```

---

### 6.2 打码模块 (MosaicModule)

实现马赛克和模糊两种打码效果。用户在图片上拖拽绘制矩形区域，该区域被打码处理。

```js
class MosaicModule extends BaseModule {
  constructor(canvasManager) { /* ... */ }

  // ── 核心方法 ──
  activate(options)          // 激活打码模式
  deactivate()               // 退出打码模式

  // ── 配置 ──
  setMode(mode)              // 'mosaic' | 'blur'
  setMosaicSize(size)        // 马赛克块大小（像素），默认 10
  setBlurRadius(radius)      // 模糊半径，默认 8

  // ── 操作 ──
  applyMosaic(rect)          // 对指定矩形区域打码
  removeLastMosaic()         // 移除最后一个打码区域
  clearAllMosaics()          // 清除所有打码
}
```

#### 马赛克实现原理

```
1. 用户拖拽绘制矩形选框 (fabric.Rect, 半透明边框)
2. 松手后：
   a. 获取选框范围在画布上的像素数据 (Fabric → Canvas2D → ImageData)
   b. 按 mosaicSize 对像素块取均值 → 马赛克效果
   c. 将处理后的 ImageData 绘制到新 fabric.Image 上
   d. 替换选框为打码后的图像块
3. 打码区域作为独立 fabric.Object，可选中删除
```

#### 模糊实现原理

```
方案 A：CSS filter（简单、性能好，但导出时需特殊处理）
  → 使用 fabric.Image.filters.Blur

方案 B：Canvas2D 原生模糊（兼容性好）
  → 使用 CanvasRenderingContext2D.filter = 'blur(Npx)'

推荐方案 A，Fabric.js 5.x 原生支持滤镜序列化到 toJSON。
```

#### 备选方案：画笔式打码

除矩形选框外，增加自由画笔打码模式（类似 Photoshop 马赛克画笔）：

```js
// 开启画笔模式
canvas.isDrawingMode = true
canvas.freeDrawingBrush = new MosaicBrush(canvas, { size: 20 })
```

---

### 6.3 剪切模块 (CropModule)

对图片进行裁剪。支持自由裁剪和固定比例裁剪。

```js
class CropModule extends BaseModule {
  constructor(canvasManager) { /* ... */ }

  // ── 核心方法 ──
  activate(options)          // 激活裁剪模式
  deactivate()               // 退出裁剪模式

  // ── 配置 ──
  setAspectRatio(ratio)      // 设置固定比例（如 1:1, 4:3, 16:9），null = 自由
  setCropArea(rect)          // 编程方式设置裁剪区域

  // ── 操作 ──
  applyCrop()                // 执行裁剪
  cancelCrop()               // 取消裁剪
  rotateCropArea()           // 旋转裁剪框 90°
}
```

#### 裁剪实现原理

```
方案 A：画布 clipPath（推荐，非破坏性）
  1. 激活裁剪模式 → 禁用画布交互，添加裁剪框 (fabric.Rect)
  2. 用户拖拽/调整裁剪框
  3. 确认 → canvas.clipPath = cropRect → renderAll()
  4. 导出 → canvas.toDataURL() 自动应用 clipPath

方案 B：图片 cropX/cropY（破坏性，适合固定裁剪）
  → image.set({ cropX, cropY, width, height }) → canvas.renderAll()

推荐方案 A，与 Fabric.js 5.x 的 clipPath 机制深度整合，
裁剪前后保持画布状态，方便撤销。
```

#### 蒙版效果

裁剪时画布非裁剪区域加深半透明蒙版：

```js
// 创建蒙版
const mask = new fabric.Rect({
  left: 0, top: 0,
  width: canvas.width, height: canvas.height,
  fill: 'rgba(0,0,0,0.5)',
  selectable: false, evented: false,
  excludeFromExport: true
})
```

---

### 6.4 加字模块 (TextModule)

在图片上添加文字标注。支持多种字体、颜色、大小和样式。

```js
class TextModule extends BaseModule {
  constructor(canvasManager) { /* ... */ }

  // ── 核心方法 ──
  activate(options)          // 激活文字模式
  deactivate()               // 退出文字模式

  // ── 文字创建 ──
  addText(text, position)    // 在指定位置添加文字
  addTextOnClick()           // 点击位置添加文字（默认行为）

  // ── 样式设置 ──
  setFontFamily(family)      // 字体
  setFontSize(size)          // 字号
  setFontWeight(weight)      // 粗细
  setFontStyle(style)        // 样式（斜体等）
  setTextColor(color)        // 文字颜色
  setTextAlign(align)        // 对齐
  setStroke(color, width)    // 描边
  setBackgroundColor(color)  // 文字背景色

  // ── 编辑 ──
  editText(textObj)          // 进入编辑模式
  commitEdit()               // 确认编辑
}
```

#### 文字对象类型选择

| 类型 | 用途 | 特点 |
|------|------|------|
| `fabric.Text` | 单行文字 | 简单标注 |
| `fabric.Textbox` | 多行文字 | 自动换行，适合段落 |
| `fabric.IText` | 可编辑文字 | **推荐**：双击进入编辑，支持选中/复制/粘贴 |

#### 默认文字样式

```js
const DEFAULT_TEXT_STYLE = {
  fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
  fontSize: 24,
  fill: '#FF0000',         // 红色（醒目）
  stroke: null,            // 默认无描边
  strokeWidth: 0,
  fontWeight: 'normal',
  textAlign: 'left',
  editable: true,
}
```

#### 预置快速样式

提供几组常用的文字样式模板，方便用户一键切换：
- **标注红**：红色粗体 + 白色描边，适合重点标注
- **说明白**：白色 + 半透明黑底，适合图片说明
- **标题黄**：黄色粗体 + 黑色描边，适合标题文字

---

### 6.5 图形工具 (ShapeModule)

在图片上绘制多种几何图形，支持矩形、圆形、星星、心形、梯形、直线和箭头等。

```js
class ShapeModule extends BaseModule {
  constructor(canvasManager, historyManager, defaultOptions) { /* ... */ }

  // ── 核心方法 ──
  activate(options)              // 激活图形绘制模式
  deactivate()                   // 退出图形绘制模式

  // ── 图形配置 ──
  setShapeType(type)             // 设置图形类型
  setFill(color)                 // 设置填充色（支持 rgba）
  setStroke(color)               // 设置边框色
  setStrokeWidth(width)          // 设置边框宽度（1-20px）

  // ── 预设快捷 ──
  applyPreset(presetName)        // 应用预设样式

  // ── UI 生成 ──
  getOptionsBarHTML()            // 选项栏 HTML
  getPropertyPanelHTML()         // 属性面板 HTML
}
```

#### 支持的图形类型

| 类型 | 说明 | 使用场景 |
|------|------|---------|
| `rect` | 矩形 | 标注区域、划重点 |
| `circle` | 圆形 | 圆形高亮、标注关键点 |
| `star` | 五角星 | 重要标记、评级标注 |
| `heart` | 心形 | 个性标注、收藏标记 |
| `trapezoid` | 梯形 | 特殊形状标注 |
| `line` | 直线 | 指向箭头前驱、分割线 |
| `arrow` | 箭头 | 指示方向、重点突出 |

#### 默认图形样式

```js
const DEFAULT_SHAPE_OPTIONS = {
  shapeType: 'rect',             // 默认图形类型
  fill: 'rgba(255, 0, 0, 0.3)',  // 半透明红色填充
  stroke: '#ff0000',             // 红色边框
  strokeWidth: 2,                // 2px 边框
}
```

#### 绘制交互

- **拖拽绘制**：鼠标按下 → 移动 → 释放，完成图形绘制
- **实时预览**：拖拽过程中实时显示将要生成的图形轮廓
- **自动保存**：释放鼠标时自动保存到历史记录，支持撤销/重做
- **最小尺寸**：宽度和高度均需大于 5px，过小的图形会被忽略

#### 预设快捷按钮

**图形类型快捷**：
- `shape-type-rect` / `shape-type-circle` / `shape-type-star` / 等

**填充色快捷**：
- `shape-fill-red` / `shape-fill-blue` / `shape-fill-green` / `shape-fill-yellow` / `shape-fill-none`

**边框色快捷**：
- `shape-stroke-red` / `shape-stroke-blue` / `shape-stroke-green` / `shape-stroke-black`

**边框宽度快捷**：
- `shape-width-thin` (1px) / `shape-width-medium` (2px) / `shape-width-thick` (4px) / `shape-width-heavy` (6px)

---

### 6.6 导出模块 (ExportModule)

将编辑结果导出为图片文件或复制到剪贴板。

```js
class ExportModule {
  constructor(canvasManager) { /* ... */ }

  // ── 导出方式 ──
  exportToFile(format, quality)         // 保存为文件
  exportToClipboard()                   // 复制到剪贴板
  exportToDataURL(format, quality)      // 获取 DataURL

  // ── 格式支持 ──
  // format: 'png' | 'jpeg' | 'webp'
  // quality: 0-1 (仅 jpeg/webp 有效)

  // ── 导出选项 ──
  exportWithOptions({
    format: 'png',
    multiplier: 1,          // 导出倍率（2x 用于 Retina）
    quality: 1,
    includeOverlays: true,  // 是否包含标注层
    clipPath: true,         // 是否应用裁剪
  })
}
```

#### 导出流程

```
确认导出
  ├→ exportToFile → utools.showSaveDialog → fs.writeFile → 通知完成
  └→ exportToClipboard → canvas.toDataURL → utools.copyImage → 通知完成
```

---

### 6.6 历史记录模块 (HistoryModule)

实现撤销（Undo）和重做（Redo）功能，支持快捷键 Ctrl+Z / Ctrl+Shift+Z。

```js
class HistoryManager {
  constructor(canvasManager, maxSteps = 30) {
    this.undoStack = []      // 撤销栈
    this.redoStack = []      // 重做栈
    this.maxSteps = maxSteps // 最大历史步数
  }

  // ── 核心方法 ──
  saveState()               // 保存当前画布状态
  undo()                    // 撤销
  redo()                    // 重做
  canUndo()                 // 是否可撤销
  canRedo()                  // 是否可重做
  clear()                   // 清空历史

  // ── 内部 ──
  _captureState()           // 快照画布 JSON 状态
  _restoreState(json)       // 恢复画布到指定状态
}
```

#### 实现策略

使用 Fabric.js 的 `canvas.toJSON()` / `canvas.loadFromJSON()` 序列化/反序列化：

```js
// 保存
saveState() {
  const json = this.canvas.toJSON(['clipPath', 'filters', 'id'])
  this.undoStack.push(json)
  // 限制栈大小
  if (this.undoStack.length > this.maxSteps) {
    this.undoStack.shift()
  }
  this.redoStack = [] // 新操作清空重做栈
}

// 撤销
undo() {
  if (!this.canUndo()) return
  const currentState = this.undoStack.pop()
  this.redoStack.push(this._captureState())
  this._restoreState(currentState)
}
```

> **注意**：`canvas.toJSON()` 默认不序列化 `clipPath` 和 `filters`，必须在调用时通过参数指定包含的属性名数组。

---

## 7. plugin.json 配置

```json
{
  "main": "src/index.html",
  "logo": "logo.png",
  "preload": "preload.js",
  "pluginSetting": {
    "single": true,
    "height": 560
  },
  "features": [
    {
      "code": "image-edit",
      "explain": "图片工具箱 — 打码、剪切、加字等图片编辑功能",
      "icon": "logo.png",
      "cmds": [
        "图片工具箱",
        "图片编辑",
        "打码",
        "马赛克",
        "图片加字",
        "裁剪图片",
        {
          "type": "img",
          "label": "图片编辑"
        },
        {
          "type": "files",
          "label": "编辑图片",
          "fileType": "file",
          "extensions": ["png", "jpg", "jpeg", "webp", "bmp", "gif", "svg"],
          "minLength": 1,
          "maxLength": 1
        }
      ]
    }
  ]
}
```

### 关键配置说明

| 配置项 | 说明 |
|--------|------|
| `single: true` | 单例模式，避免同时打开多个编辑窗口 |
| `height: 560` | 初始窗口高度，加载图片后可动态调高 |
| `img` 匹配 | 支持粘贴截图或拖入图片触发插件 |
| `files` 匹配 | 在文件管理器选中图片 → 超级面板呼出 |
| `extensions` | 支持的图片格式列表 |

---

## 8. preload.js 设计

`preload.js` 运行在 Node.js 环境中，拥有完整的文件系统和 Electron API 访问权限。主要用于：

1. **文件读写**：图片的读取与保存
2. **剪贴板操作**：图片复制到系统剪贴板
3. **窗口通信**：与 uTools 主进程交互

```js
// preload.js 核心结构

const fs = require('fs')
const path = require('path')
const { clipboard, nativeImage } = require('electron')

// ── 文件操作 ──
window.readImageFile = (filePath) => {
  return fs.readFileSync(filePath)
}

window.writeImageFile = (filePath, buffer) => {
  fs.writeFileSync(filePath, buffer)
  return true
}

// ── 剪贴板操作 ──
window.copyImageToClipboard = (dataURL) => {
  const img = nativeImage.createFromDataURL(dataURL)
  clipboard.writeImage(img)
}

window.readImageFromClipboard = () => {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  return img.toDataURL()
}

// ── 导出文件对话框 ──
window.showSaveImageDialog = (defaultName) => {
  return utools.showSaveDialog({
    title: '保存图片',
    defaultPath: utools.getPath('pictures') + '/' + (defaultName || 'edited'),
    filters: [
      { name: 'PNG 图片', extensions: ['png'] },
      { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      { name: 'WebP 图片', extensions: ['webp'] },
    ],
  })
}

// ── 插件生命周期 ──
utools.onPluginEnter(({ code, type, payload }) => {
  if (code === 'image-edit') {
    let imageSource = null

    switch (type) {
      case 'img':
        // 从剪贴板图片进入
        imageSource = clipboard.readImage().toDataURL()
        break
      case 'files':
        // 从文件选择进入
        const filePath = payload[0].path
        imageSource = 'file://' + filePath
        break
      default:
        // 关键词搜索进入 → 等待用户导入图片
        break
    }

    // 通过 window 对象将图片源传递给前端
    window.__imageSource = imageSource
  }
})

// 插件退出时清理
utools.onPluginOut(() => {
  window.__imageSource = null
})
```

---

## 9. UI 布局设计

参考 Photoshop 经典布局，采用**深色主题 + 五区布局**，同时支持一键切换浅色主题。

### 9.1 整体布局（五区结构）

```
┌─ 选项栏 ─────────────────────[主题切换]──┐  ← 42px，工具参数动态切换
├────┬─────────────────────────┬──────────┤
│    │                         │ 属性面板  │  ← 上半：选中物件参数（字号/颜色/描边等）
│ 工 │      画布编辑区           ├──────────┤
│ 具 │   Fabric.js Canvas      │ 图层面板  │  ← 下半：图层列表（显隐/锁定/排序）
│ 栏 │   + 标签页 + 缩放滑块     │          │
│    │                         │          │
├────┴─────────────────────────┴──────────┤
│  状态栏  1280×720 | 图层:4 | [导出▼][剪贴板] │  ← 28px，蓝色底条
└─────────────────────────────────────────┘
```

| 区域 | 宽度/高度 | 定位 | 说明 |
|------|:---:|------|------|
| 选项栏 | 全宽 × 42px | 顶部 | 根据当前工具动态渲染控件，右侧固定放置主题切换按钮 |
| 工具栏 | 52px × 全高 | 左侧 | 竖排图标，分为编辑工具 / 标注工具 / 视图工具三组 + 前景背景色 |
| 画布区 | 自适应 | 中央 | Fabric.js Canvas，网格背景，顶部标签页 + 底部缩放滑块 |
| 属性面板 | 132px | 右侧上 | 选中图层/物件时显示对应参数：字号、颜色、描边、不透明度等 |
| 图层面板 | 132px | 右侧下 | 图层列表（拖拽排序、显隐切换、锁定、重命名），底部 +/- 按钮 |
| 状态栏 | 全宽 × 28px | 底部 | 图片尺寸、图层数、引擎版本 + 导出/剪贴板快捷按钮 |

### 9.2 配色方案

#### 深色主题（默认）

| 用途 | 色值 | 说明 |
|------|------|------|
| 窗口底色 | `#1e1e1e` | 最外层背景 |
| 面板/工具栏 | `#252526` | 面板区域背景 |
| 面板内部 | `#1e1e1e` | 属性/图层面板卡片底色 |
| 画布背景 | `#2c2c2c` | 画布深灰底 + 棋盘格网格 |
| 选中高亮 | `#094771` | 图层选中 / 工具激活（同 PS 选中蓝） |
| 状态栏 | `#007acc` | 底部状态栏（VS Code 蓝） |
| 文字主色 | `#cccccc` | 主要内容文字 |
| 文字辅助 | `#858585` | 标签、说明文字 |
| 边框 | `#3e3e3e` | 面板、输入框边框 |

#### 浅色主题（切换后）

| 用途 | 色值 | 说明 |
|------|------|------|
| 窗口底色 | `#f5f5f5` | 最外层背景 |
| 面板/工具栏 | `#e8e8e8` | 面板区域背景 |
| 面板内部 | `#ffffff` | 属性/图层面板卡片底色 |
| 画布背景 | `#e0e0e0` | 画布浅灰底 + 浅色棋盘格 |
| 选中高亮 | `#cce5ff` | 图层选中 / 工具激活 |
| 状态栏 | `#007acc` | 底部状态栏（保持不变） |
| 文字主色 | `#333333` | 主要内容文字 |
| 文字辅助 | `#666666` | 标签、说明文字 |
| 边框 | `#d0d0d0` | 面板、输入框边框 |

### 9.3 主题切换实现

通过 CSS 变量统一管理颜色，切换主题 = 替换 `document.documentElement` 上的变量值。

**选项栏右侧放置切换按钮**：凹凸圆角开关，点击切换 `data-theme="dark" | "light"`。

```css
/* 定义两套变量 */
:root, [data-theme="dark"] {
  --bg-window: #1e1e1e;
  --bg-panel: #252526;
  --bg-card: #1e1e1e;
  --bg-canvas: #2c2c2c;
  --bg-active: #094771;
  --color-text: #cccccc;
  --color-text-secondary: #858585;
  --color-border: #3e3e3e;
}

[data-theme="light"] {
  --bg-window: #f5f5f5;
  --bg-panel: #e8e8e8;
  --bg-card: #ffffff;
  --bg-canvas: #e0e0e0;
  --bg-active: #cce5ff;
  --color-text: #333333;
  --color-text-secondary: #666666;
  --color-border: #d0d0d0;
}
```

主题偏好写入 `localStorage`，初始化时读取。

### 9.4 工具栏按钮设计

```
┌──────┐
│  ✋   │  移动 / 框选（选中物件、拖拽移动）
│  ⊞   │  框选打码（拖拽矩形区域马赛克）
│  ▣   │  画笔打码（自由涂抹马赛克/模糊）
│  ∫   │  剪切（裁剪框叠加）
├──────┤  ← 分隔线
│  T   │  文字标注（点击添加 IText）
│  □   │  矩形标注（框选区域）
│  ⬚   │  箭头标注
├──────┤
│  ⊖   │  缩小
│  ⊕   │  放大
├──────┤
│  ■   │  前景色
│  □   │  背景色
└──────┘
```

- 选中工具高亮：左侧蓝色竖条 + 深蓝背景 `#094771`
- 带下拉的工具：右键或长按弹出子菜单（如打码模式切换、裁切比例选择）

### 9.5 选项栏（按工具动态切换）

**打码模式**：
```
马赛克块大小: [━━━━━●━━━] 10px  │  模式: [马赛克 ▼]  [模糊强度: 8px]  │  颜色: [■]
```

**加字模式**：
```
字体: [Microsoft YaHei ▼]  字号: [24 ▼]  │  颜色: [■]  B  I  U  │  描边: [□] 宽: [2 ▼]
```

**剪切模式**：
```
比例: [自由 ▼]  [1:1] [4:3] [16:9]  │  [应用] [取消]
```

### 9.6 属性面板（右侧上）

根据选中图层的类型动态渲染，选中文字物件时示例：
```
属性 ─────────────────
  字号      [24 ▼]
  颜色      [■ #FF0000]
  描边      [□ 无]
  不透明度  [━━━━●━━] 80%
  字间距    [━━●━━━━] 0
  行高      [1.5]
  [应用]
```

### 9.7 图层面板（右侧下）

```
图层 ─────────────────
  [👁] T 文字-标注    ✓
  [👁] ⊞ 马赛克-1
  [👁] ⊞ 形状-框
  [👁] ⊞ 原图      🔒
  [+]  [-]
```

- 点击图层 = 选中对应画布物件并高亮
- 拖拽 = 调整 z-order
- 👁 图标 = 切换可见性
- 🔒 图标 = 锁定图层（不可选不可动）

### 9.8 状态栏

```
1280 × 720 px  |  图层: 4  |  Fabric.js 5.x          [导出 ▼] [剪贴板]
```

- 左侧：图片尺寸 + 图层数量 + 引擎版本
- 右侧：导出下拉（PNG / JPEG / WebP）+ 复制到剪贴板按钮

---

## 10. 功能扩展指南

### 10.1 添加新功能的步骤

以添加「形状标注」功能为例：

**Step 1：创建模块文件**

```js
// src/modules/ShapeModule.js
import BaseModule from './BaseModule.js'

class ShapeModule extends BaseModule {
  static name = 'shape'
  static label = '形状标注'
  static icon = 'square'

  activate({ shapeType = 'rect', color = '#FF0000' } = {}) {
    super.activate()
    this.shapeType = shapeType
    this.color = color
    this.canvasManager.canvas.selection = false
  }

  deactivate() {
    super.deactivate()
    this.canvasManager.canvas.selection = true
  }

  addShape(x, y) {
    const shapeMap = {
      rect: fabric.Rect,
      circle: fabric.Circle,
      arrow: fabric.Triangle, // 需自定义
    }
    const Shape = shapeMap[this.shapeType]
    const shape = new Shape({
      left: x, top: y,
      width: 100, height: 80,
      fill: 'transparent',
      stroke: this.color,
      strokeWidth: 3,
    })
    this.canvasManager.addObject(shape)
    this.history.saveState()
  }
}
```

**Step 2：注册到 ToolManager**

```js
// src/core/ToolManager.js
import ShapeModule from '../modules/ShapeModule.js'

const TOOLS = [
  { name: 'mosaic',  module: MosaicModule,  icon: 'mosaic' },
  { name: 'crop',    module: CropModule,     icon: 'crop' },
  { name: 'text',    module: TextModule,     icon: 'type' },
  { name: 'shape',   module: ShapeModule,    icon: 'square' }, // ← 新增
]
```

**Step 3：添加工具栏按钮**

```html
<!-- src/index.html -->
<button class="toolbar-btn" data-tool="shape" title="形状标注">
  <svg><!-- 形状图标 --></svg>
  <span>形状</span>
</button>
```

**Step 4：（可选）添加属性面板**

ShapeModule 可以在 `getPropertyPanelHTML()` 方法中返回对应的 HTML 片段，由 PropertyPanel 渲染。

### 10.2 模块基类 (BaseModule)

所有功能模块的抽象基类：

```js
class BaseModule {
  constructor(canvasManager, historyManager) {
    this.canvasManager = canvasManager
    this.history = historyManager
    this.active = false
  }

  // 子类必须实现
  activate(options = {}) { this.active = true }
  deactivate() { this.active = false }

  // 可选实现
  getPropertyPanelHTML() { return '' }      // 返回属性面板 HTML
  onPropertyChange(key, value) { }          // 属性变更回调
  onKeyDown(e) { }                          // 键盘事件
  onMouseDown(e) { }                        // 鼠标事件
  onMouseMove(e) { }
  onMouseUp(e) { }
}
```

### 10.3 规划中的功能

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 涂鸦/画笔 | 自由绘制线条和箭头 |
| P0 | 撤销/重做 | Ctrl+Z / Ctrl+Shift+Z |
| P1 | 形状标注 | 矩形、圆形、箭头的标注框 |
| P1 | 图片滤镜 | 亮度、对比度、饱和度调整 |
| P1 | 旋转/翻转 | 图片旋转和镜像翻转 |
| P2 | 水印 | 图片/文字水印叠加 |
| P2 | 贴纸/Emoji | 预置贴纸库 |
| P2 | 序号标注 | 自动编号的圆形序号标记 |
| P3 | 局部放大 | 放大镜效果 / 局部截图放大 |
| P3 | AI 抠图 | 移除背景（需后端或 WASM 支持） |
| P3 | OCR 文字提取 | 识别图片文字（需后端支持） |

---

## 11. 编码规范

### 11.1 JavaScript

```js
// ✓ 使用 ES Module
import { CanvasManager } from './core/CanvasManager.js'

// ✓ 类名 PascalCase
class MosaicModule extends BaseModule { }

// ✓ 方法/变量 camelCase
const canvasManager = new CanvasManager('canvas')

// ✓ 常量 UPPER_SNAKE_CASE
const MAX_HISTORY_STEPS = 30
const DEFAULT_MOSAIC_SIZE = 10

// ✓ JSDoc 注释
/**
 * 在指定位置添加文字
 * @param {string} text - 文字内容
 * @param {{x: number, y: number}} position - 位置坐标
 * @returns {fabric.IText} 创建的文本对象
 */
addText(text, position) { /* ... */ }

// ✓ 错误处理
try {
  await this.canvasManager.loadImage(source)
} catch (err) {
  console.error('[CanvasManager] 图片加载失败:', err)
  utools.showNotification('图片加载失败，请检查格式')
}
```

### 11.2 CSS

```css
/* ✓ BEM 命名规范 */
.toolbar { }
.toolbar__btn { }
.toolbar__btn--active { }
.toolbar__separator { }

/* ✓ CSS 变量统一管理主题色（深色/浅色切换，见 9.3 节） */
:root, [data-theme="dark"] {
  --bg-window: #1e1e1e;
  --bg-panel: #252526;
  --bg-card: #1e1e1e;
  --bg-canvas: #2c2c2c;
  --bg-active: #094771;
  --bg-statusbar: #007acc;
  --color-text: #cccccc;
  --color-text-secondary: #858585;
  --color-border: #3e3e3e;
  --color-danger: #f44747;
  --toolbar-width: 52px;
  --optionsbar-height: 42px;
  --panel-width: 132px;
  --statusbar-height: 28px;
}

[data-theme="light"] {
  --bg-window: #f5f5f5;
  --bg-panel: #e8e8e8;
  --bg-card: #ffffff;
  --bg-canvas: #e0e0e0;
  --bg-active: #cce5ff;
  --color-text: #333333;
  --color-text-secondary: #666666;
  --color-border: #d0d0d0;
}
```

### 11.3 文件命名

| 类型 | 命名规则 | 示例 |
|------|---------|------|
| 模块文件 | PascalCase + Module 后缀 | `MosaicModule.js` |
| 核心管理类 | PascalCase + Manager 后缀 | `CanvasManager.js` |
| UI 组件 | PascalCase | `Toolbar.js` |
| 工具函数 | camelCase | `image.js` |
| 样式文件 | kebab-case | `style.css` |
| 资源图标 | kebab-case | `icon-mosaic.svg` |

---

## 12. 构建与调试

### 12.1 本地开发

1. 将项目文件夹放入 uTools 开发者插件目录：
   ```
   Windows: %USERPROFILE%\.utools-dev\
   macOS:   ~/.utools-dev/
   ```

2. 打开 uTools → 插件应用市场 → 开发者菜单 → 加载本地插件

3. 在 uTools 搜索框中输入 `图片编辑` 或 `打码` 即可进入插件

### 12.2 调试技巧

```js
// preload.js 中开启开发者工具
// uTools 内部是 Chromium，可在 preload 中注入
// 注意：仅在开发时使用
utools.onPluginEnter(() => {
  // 在插件窗口内右键 → 检查元素（某些版本支持）
})

// 开发时保留 console 日志
window.__DEBUG__ = true
if (window.__DEBUG__) {
  console.log('[Plugin] 插件入口:', { code, type, payload })
}
```

### 12.3 发布流程

1. 更新 `plugin.json` 中的版本号
2. 确保 `logo.png` 符合规范（128×128，PNG）
3. 删除调试代码和 `console.log`
4. 将整个项目文件夹打包为 `.upxs`（通过 uTools 开发者工具导出）
5. 提交到 uTools 插件市场

---

## 13. 待办与路线图

### v0.1 — 基础功能（已完成 ✅）

- [x] 项目搭建 & 开发文档编写
- [x] CanvasManager 画布管理器
- [x] LayerManager 图层管理器
- [x] MosaicModule 打码功能（矩形选框马赛克 + 模糊）
- [x] CropModule 剪切功能（clipPath 非破坏性裁剪）
- [x] TextModule 加字功能（fabric.IText + 预设样式）
- [x] ExportModule 导出功能（PNG/JPEG/WebP 文件 + 剪贴板）
- [x] 完整 UI（工具栏 + 选项栏 + 画布 + 属性面板 + 图层面板 + 状态栏）
- [x] 深色/浅色主题切换（CSS 变量 + localStorage）
- [x] plugin.json 配置 & preload.js

### v0.2 — 体验增强（已完成 ✅）

- [x] HistoryManager 撤销/重做
- [x] 画笔打码（模糊模式 — Canvas2D filter）
- [x] 滚轮缩放
- [x] 快捷键支持（Ctrl+Z/Ctrl+Shift+Z / Delete / 工具快捷键 V/M/B/C/T）
- [ ] 图层拖拽排序

### v0.3+

- [ ] 涂鸦/箭头标注
- [ ] 形状标注（框、圆、线）
- [ ] 图片滤镜（亮度/对比度/饱和度）
- [ ] 贴纸/水印
- [ ] 多图编辑（Tab 切换）

---

> 本文档随项目持续更新。有任何设计决策变更，请同步修改本文档对应章节。
