# 图片工具箱

> 基于 Fabric.js 的轻量图片编辑工具，支持 uTools、ZTools 等多端运行。

## 功能

| 工具 | 快捷键 | 说明 |
|------|--------|------|
| 移动/框选 | V | 选中并移动图层，支持旋转/翻转 |
| 打码 | M | 矩形框选或画笔涂抹，支持马赛克/模糊 |
| 剪切 | C | 自由或固定比例裁剪图片 |
| 文字 | T | 添加文字标注，支持描边/背景 |
| 画笔 | B | 自由涂鸦，可选颜色和粗细 |
| 橡皮擦 | E | 擦除当前图层像素 |
| 形状 | S | 矩形、圆形、五角星、箭头等几何标注 |

**通用操作**：撤销（Ctrl+Z）/ 重做（Ctrl+Y）、滚轮缩放、保存/复制到剪贴板。

## 架构

```
┌─────────────────────────────────────────────────┐
│  App / Host Layer (uTools / ZTools / Web)       │
├─────────────────────────────────────────────────┤
│  UI Layer (Toolbar / OptionsBar / PropertyPanel)│
├─────────────────────────────────────────────────┤
│  Editor Core (EventBus / LayerStore / History)  │
├─────────────────────────────────────────────────┤
│  Engine Adapter (Fabric.js)                      │
├─────────────────────────────────────────────────┤
│  Effect Core (Mosaic / Blur / Crop 算法)        │
└─────────────────────────────────────────────────┘
```

详见 [CORE_ARCHITECTURE.md](CORE_ARCHITECTURE.md) 和 [PLATFORM_ADAPTERS.md](PLATFORM_ADAPTERS.md)。

## 目录

```
.
├── clients/                 # 各平台入口
│   ├── utools/             # uTools 插件
│   └── ztools/             # ZTools 插件
├── core/                   # 跨端核心（编辑逻辑、工具、历史、图层）
│   └── src/
│       ├── core/           # 核心模块
│       ├── modules/        # 功能模块（Mosaic / Crop / Text / Brush / Eraser）
│       ├── ui/             # UI 组件
│       ├── utils/          # 工具函数
│       └── adapters/       # 引擎适配器
├── dist/                   # 构建输出
│   ├── uTools/
│   └── zTools/
└── README.md              # 本文档
```

## 开发

详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 更新日志

详见 [agents.md](agents.md)。
