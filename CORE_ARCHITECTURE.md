# 图片工具箱多端 Core 抽象设计

> 最后更新：2026-06-15  
> 目标：在不打断当前 uTools 版本迭代的前提下，把可复用编辑能力沉淀为多端共享 core。

## 1. 目标

图片工具箱后续可能运行在 uTools、普通 Web、Electron 桌面、浏览器扩展、移动端 WebView 等环境。当前代码已经有 `src/core/`，但它仍然混合了 Fabric.js、DOM、宿主 API、工具注册和 UI 行为。

新的 core 目标不是立刻替换 Fabric.js，也不是一次性把所有工具改成纯函数，而是先定义稳定边界：

| 目标 | 说明 |
|---|---|
| 编辑业务可复用 | 图层、历史、工具状态、工程序列化、命令流在多端共享 |
| 端侧能力可替换 | 文件、剪贴板、字体、存储、窗口控制由 host adapter 提供 |
| 渲染引擎可隔离 | Fabric.js 先作为默认 engine adapter，未来可替换或补充 CanvasKit / WebGL / 原生实现 |
| UI 不进入 core | 工具栏、属性面板、Toast、DOM HTML 字符串留在端侧 UI 层 |
| 渐进迁移 | 先抽接口和文档，再从低风险模块开始迁移，不做大爆炸重构 |

## 2. 当前状态判断

当前目录：

```txt
源码/src/
  core/       CanvasManager / LayerManager / HistoryManager / ToolManager / EventBus
  modules/    Select / Mosaic / Crop / Brush / Eraser / Text / Export / BaseModule
  ui/         Toolbar / OptionsBar / PropertyPanel / LayerPanel / StatusBar / AccountPage
  utils/      host / theme / image / fonts / dynamicMosaic / constants
```

现有 `src/core/` 的可复用程度：

| 文件 | 当前职责 | 多端结论 |
|---|---|---|
| `EventBus.js` | 发布订阅 | 基本可进入 core，但不应是全局单例，应该由 `EditorCore` 创建实例 |
| `HistoryManager.js` | 撤销/重做快照 | 逻辑可进入 core，但快照格式目前是 Fabric JSON，需要通过 serializer adapter 隔离 |
| `LayerManager.js` | 图层元数据、顺序、显隐、锁定 | 业务规则可进入 core，但当前保存 `fabricObj` 引用，需要改成 `LayerModel + engineObjectId` |
| `ToolManager.js` | 工具注册、切换、导出入口 | 工具状态可进入 core，但不能硬编码具体 Fabric 模块，也不应包含导出模块 |
| `CanvasManager.js` | Fabric 画布封装、DOM 尺寸、图片加载、缩放、序列化 | 应归入 `fabric-engine-adapter`，不是纯 core |
| `BaseModule.js` | 工具模块基类 | 工具生命周期可保留，但 `getOptionsBarHTML()` / `getPropertyPanelHTML()` 是 UI 泄漏 |
| `modules/*` | 具体编辑工具 | 需要拆成工具业务、效果算法、Fabric 交互三层 |
| `ExportModule.js` | 导出为文件/剪贴板、Toast | 应拆分为 core 的导出数据生成和 host/ui 的保存、复制、提示 |

主要平台耦合点：

| 耦合类型 | 典型位置 | 处理方式 |
|---|---|---|
| DOM | `document.getElementById`、`document.createElement`、Toast、Canvas 尺寸 | 移到 web/uTools app 层或 engine adapter |
| 浏览器 API | `FileReader`、`navigator.clipboard`、`localStorage`、`ResizeObserver` | 通过 host adapter 注入 |
| uTools/ZTools | `preload.js`、`utils/host.js`、`index.js` | 作为 `utools-host-adapter` |
| Fabric.js | `CanvasManager`、所有工具模块、`dynamicMosaic` | 作为 `fabric-engine-adapter` |
| UI HTML 字符串 | 各工具 `getOptionsBarHTML()`、`getPropertyPanelHTML()` | 改为工具 schema，由 UI 层渲染 |

## 3. 目标分层

建议最终形成 5 层：

```txt
App / Host Layer
  uTools app, Web app, Electron app, Browser extension

UI Layer
  Toolbar, OptionsBar, PropertyPanel, LayerPanel, StatusBar, AccountPage

Editor Core
  EditorSession, EventBus, ToolRegistry, LayerStore, HistoryStore, ProjectSerializer

Engine Adapter
  FabricEngineAdapter first, future CanvasKit/WebGL/native adapters

Effect Core
  crop geometry, mosaic pixels, blur pixels, transform helpers, color helpers
```

依赖方向必须单向：

```txt
App -> UI -> EditorCore -> EngineAdapter
App -> HostAdapter
EngineAdapter -> EffectCore
EditorCore -> EffectCore
```

禁止方向：

```txt
EditorCore -> DOM
EditorCore -> window / utools / localStorage / navigator
EditorCore -> concrete UI component
EditorCore -> fabric global
EffectCore -> DOM / fabric / host API
```

## 4. Core 应该包含什么

### 4.1 EditorSession

`EditorSession` 是多端共享入口，负责组合 core 内部对象，并只依赖抽象 adapter。

```ts
type EditorCoreOptions = {
  engine: EditorEngineAdapter;
  host?: HostAdapter;
  eventBus?: EventBus;
  maxHistorySteps?: number;
};

class EditorSession {
  loadImage(source: ImageSource): Promise<LayerId>;
  setActiveTool(toolName: string, options?: object): void;
  applyToolAction(action: ToolAction): Promise<void>;
  selectLayer(layerId: LayerId | null): void;
  updateLayer(layerId: LayerId, patch: LayerPatch): void;
  reorderLayer(layerId: LayerId, targetIndex: number): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  createSnapshot(): ProjectSnapshot;
  restoreSnapshot(snapshot: ProjectSnapshot): Promise<void>;
  exportImage(options: ExportOptions): Promise<ExportResult>;
  destroy(): void;
}
```

第一阶段可以不实现完整命令系统，仍然使用 snapshot 历史；关键是 snapshot 由 core 统一管理，具体画布序列化由 engine adapter 提供。

### 4.2 EventBus

保留当前发布订阅模式，但去掉全局单例。

```ts
class EventBus {
  on(event: string, callback: Function, context?: object): () => void;
  once(event: string, callback: Function, context?: object): void;
  off(event: string, target?: number | Function): void;
  emit(event: string, ...args: unknown[]): void;
  clear(): void;
}
```

事件命名建议固定为 core 事件，不直接暴露 Fabric 事件名：

| 事件 | 载荷 |
|---|---|
| `document:loaded` | `{ imageLayerId, size }` |
| `document:changed` | `{ reason }` |
| `tool:changed` | `{ toolName, options }` |
| `selection:changed` | `{ layerIds }` |
| `layers:changed` | `{ layers }` |
| `history:changed` | `{ canUndo, canRedo, undoCount }` |
| `export:ready` | `{ format, data }` |
| `error` | `{ code, message, cause }` |

### 4.3 LayerStore

core 内保存纯数据图层模型，不保存 Fabric 对象引用。

```ts
type LayerModel = {
  id: string;
  engineId: string;
  name: string;
  type: 'background' | 'image' | 'text' | 'brush' | 'mosaic' | 'shape' | 'group';
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: TransformModel;
  metadata?: Record<string, unknown>;
};
```

`LayerStore` 负责：

| 能力 | 是否进 core | 说明 |
|---|---|---|
| 图层列表顺序 | 是 | 顶层在前、背景固定底部是业务规则 |
| 图层命名 | 是 | 当前 `LayerManager` 的自动命名规则可迁移 |
| 显隐、锁定 | 是 | core 更新模型，再调用 engine adapter 同步 |
| 选择图层 | 是 | 维护 selection model，再委托 engine adapter 选中对象 |
| 删除、排序 | 是 | 规则进 core，实际 z-order 操作由 engine adapter 执行 |
| Fabric 对象读写 | 否 | 只在 Fabric adapter 内部处理 |

### 4.4 HistoryStore

短期保留快照模式，长期可切换命令模式。

```ts
type HistorySnapshot = {
  editorState: EditorState;
  engineState: unknown;
};

class HistoryStore {
  save(snapshot: HistorySnapshot): void;
  undo(current: HistorySnapshot): HistorySnapshot | null;
  redo(current: HistorySnapshot): HistorySnapshot | null;
  clear(): void;
  getState(): { canUndo: boolean; canRedo: boolean; undoCount: number };
}
```

阶段策略：

| 阶段 | 方案 | 原因 |
|---|---|---|
| v1 | snapshot/memento | 和当前 Fabric JSON 最兼容，风险最低 |
| v2 | command + checkpoint | 大图多步编辑时节省内存，支持精细撤销 |
| v3 | per-tool operation log | 支持协作、云同步、跨端重放 |

### 4.5 ToolRegistry

core 只关心工具注册、当前工具、工具选项和工具 action，不直接渲染工具栏，也不返回 HTML。

```ts
type ToolDefinition = {
  name: string;
  label: string;
  group: 'edit' | 'annotate' | 'export' | string;
  shortcut?: string;
  defaultOptions?: object;
  controls?: ToolControlSchema[];
  presets?: ToolPreset[];
  handler: ToolHandler;
};

type ToolControlSchema = {
  key: string;
  label: string;
  type: 'number' | 'range' | 'color' | 'select' | 'toggle' | 'button-group';
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string | number | boolean }>;
};
```

当前工具模块里的 `getOptionsBarHTML()` 和 `getPropertyPanelHTML()` 后续应迁移为 `controls` 和 `presets` schema。UI 层根据 schema 渲染 Web DOM、React Native 控件或原生控件。

### 4.6 ProjectSerializer

多端必须有稳定工程格式，不能把 Fabric JSON 当成唯一工程格式。

```ts
type ProjectSnapshot = {
  version: 1;
  app: 'image-toolbox';
  document: {
    width: number;
    height: number;
    backgroundColor?: string | null;
    crop?: ClipModel | null;
  };
  layers: LayerModel[];
  selection: string[];
  tool: {
    active: string | null;
    options: Record<string, object>;
  };
  engine: {
    name: string;
    version: string;
    state: unknown;
  };
};
```

第一阶段允许 `engine.state` 保存 Fabric JSON，因为这是当前撤销/恢复最可靠的数据。以后再逐步把常见图层类型转成 engine-independent schema。

## 5. Engine Adapter

Fabric.js 仍然是近期主引擎，但需要被 adapter 包起来。

```ts
interface EditorEngineAdapter {
  init(target: EngineTarget, options: EngineInitOptions): Promise<void>;
  destroy(): void;

  loadImage(source: ImageSource): Promise<EngineObjectRef>;
  replaceImage(layerId: string, source: ImageSource): Promise<EngineObjectRef>;
  exportImage(options: ExportOptions): Promise<ExportResult>;

  getObjects(): EngineObjectRef[];
  getObject(engineId: string): EngineObjectRef | null;
  addObject(input: AddObjectInput): Promise<EngineObjectRef>;
  updateObject(engineId: string, patch: EngineObjectPatch): void;
  removeObject(engineId: string): void;
  reorderObject(engineId: string, targetIndex: number): void;

  getSelection(): string[];
  setSelection(engineIds: string[]): void;
  setInteractivity(engineId: string, interactive: boolean): void;

  getViewport(): ViewportModel;
  setViewport(viewport: ViewportModel): void;
  fitToViewport(options?: FitOptions): void;

  serialize(): unknown;
  restore(state: unknown): Promise<void>;

  on(event: EngineEventName, callback: Function): () => void;
}
```

Fabric adapter 可以复用现有 `CanvasManager` 的大量实现，但需要调整职责：

| 当前 `CanvasManager` 能力 | 迁移位置 |
|---|---|
| `fabric.Canvas` 初始化 | `FabricEngineAdapter.init()` |
| `loadImage()` 中 FileReader | 图片 source 归一化移到 host/app，Fabric adapter 只接收 dataURL/url/blob/canvas |
| `fitToCanvas()`、缩放 | adapter 保留，core 通过通用 viewport API 调用 |
| `toJSON()`、`fromJSON()` | adapter 提供 `serialize()`、`restore()` |
| DOM 尺寸读取、ResizeObserver | Web/uTools app 层监听后调用 adapter `resize()` |
| Fabric 事件转发 | adapter 转成通用 engine event |

## 6. Host Adapter

端侧能力统一通过 `HostAdapter` 注入。

```ts
interface HostAdapter {
  pickImage?(): Promise<ImageSource | null>;
  readImageFile?(path: string): Promise<ImageSource>;
  saveImage?(data: ExportResult, suggestedName?: string): Promise<boolean>;
  copyImage?(data: ExportResult): Promise<boolean>;
  getSystemFonts?(): Promise<string[]>;
  getStorageItem?(key: string): Promise<string | null>;
  setStorageItem?(key: string, value: string): Promise<void>;
  openExternal?(url: string): Promise<boolean>;
  setWindowHeight?(height: number): void;
  onPluginEnter?(callback: (payload: HostEntryPayload) => void): () => void;
}
```

各端实现：

| 端 | Adapter |
|---|---|
| uTools/ZTools | `UtoolsHostAdapter`，封装 `preload.js` 暴露的 `window.*` 和宿主 API |
| Web | `WebHostAdapter`，使用 file input、Clipboard API、localStorage |
| Electron 独立版 | `ElectronHostAdapter`，通过 IPC 调主进程文件/剪贴板能力 |
| 移动端 WebView | `WebViewHostAdapter`，通过 JS bridge 调原生能力 |

## 7. 工具模块拆分方式

每个工具建议拆成三部分：

| 部分 | 职责 | 示例 |
|---|---|---|
| Tool definition | 工具元信息、快捷键、默认参数、控件 schema | `brush.tool.ts` |
| Tool handler | 处理通用 pointer/action，调用 core 和 engine adapter | `BrushToolHandler` |
| Engine implementation | Fabric 对象创建、事件绑定、光标预览 | `FabricBrushTool` |

短期可以先做轻量拆分：

```txt
modules/BrushModule.js
  保留 Fabric 交互
  导出 brushToolDefinition
  getOptionsBarHTML -> controls schema

ui/OptionsBar.js
  从 currentModule.getOptionsBarHTML()
  改为 renderToolControls(toolDefinition.controls, currentOptions)
```

长期目标：

```txt
packages/editor-core/tools/brush.ts
packages/fabric-adapter/tools/FabricBrushTool.ts
apps/utools/src/ui/BrushControls.ts
```

## 8. 效果算法拆分

当前马赛克、模糊、橡皮擦栅格化都混在 Fabric 工具模块里。真正可跨端复用的是像素算法和几何计算。

建议抽出 `effect-core`：

```ts
type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

function applyMosaic(input: PixelBuffer, options: MosaicOptions, mask?: PixelBuffer): PixelBuffer;
function applyBlur(input: PixelBuffer, options: BlurOptions, mask?: PixelBuffer): PixelBuffer;
function createRectMask(size: Size, rect: Rect): PixelBuffer;
function createBrushMask(size: Size, points: Point[], brushSize: number): PixelBuffer;
function normalizeCropGeometry(input: CropGeometry): ClipModel;
```

Fabric adapter 负责把画布区域读成 `PixelBuffer`，调用算法，再把结果转回 `fabric.Image` 或 canvas texture。

## 9. 建议目录结构

现阶段不一定马上引入 monorepo。可以先在当前 `源码/src/` 内形成边界：

```txt
源码/src/
  app/
    utoolsApp.js              # 原 index.js 中宿主/DOM 入口逻辑逐步迁入
  core/
    EditorSession.js
    EventBus.js
    HistoryStore.js
    LayerStore.js
    ToolRegistry.js
    ProjectSerializer.js
    schema.js
  adapters/
    fabric/
      FabricEngineAdapter.js
      FabricObjectMapper.js
      FabricSerializer.js
      tools/
        FabricBrushTool.js
        FabricEraserTool.js
        FabricMosaicTool.js
        FabricCropTool.js
        FabricTextTool.js
    host/
      UtoolsHostAdapter.js
      WebHostAdapter.js
  effects/
    mosaic.js
    blur.js
    mask.js
    geometry.js
  modules/
    legacy/                   # 迁移完成前保留旧模块
  ui/
    ...
```

如果后续引入构建工具或多端仓库，再升级为：

```txt
packages/
  editor-core/
  effect-core/
  fabric-adapter/
  web-ui/
  host-utools/
apps/
  utools/
  web/
  electron/
```

## 10. 迁移路线

### Phase 0：只立边界，不改行为

产出：

| 任务 | 说明 |
|---|---|
| 新增本文档 | 明确 core 边界和迁移顺序 |
| 补充依赖约束 | 约定 core 不直接访问 DOM / window / fabric |
| 梳理事件清单 | 把现有 eventBus 事件整理成 core event 和 UI event |

风险：无业务行为变更。

### Phase 1：抽 HostAdapter

优先拆端侧能力，因为风险低且收益明显。

| 当前代码 | 目标 |
|---|---|
| `utils/host.js` | `adapters/host/UtoolsHostAdapter.js` |
| `preload.js` 暴露 `window.readImageFile` 等 | 保持不变，但由 adapter 统一调用 |
| `ExportModule` 直接调用 `window.showSaveImageDialog` | 改为 `host.saveImage()` |
| `index.js` 直接处理 uTools payload | 改为 `host.onPluginEnter()` |

验收标准：同一套编辑代码能在 uTools 和普通浏览器降级环境打开图片、导出、复制。

### Phase 2：EventBus 和 HistoryStore 去单例化

| 当前代码 | 目标 |
|---|---|
| `EventBus.js` 默认导出单例 | 导出类，app 创建实例并注入 |
| 各模块直接 import `eventBus` | 构造函数接收 `eventBus` 或通过 `EditorContext` 获取 |
| `HistoryManager` 直接依赖 `CanvasManager` | 改为依赖 `snapshotProvider` 和 `snapshotRestorer` |

验收标准：可以创建两个独立编辑实例，事件和历史互不串扰。

### Phase 3：LayerStore 纯数据化

| 当前代码 | 目标 |
|---|---|
| layer meta 内保存 `fabricObj` | 保存 `engineId` |
| 图层命名和 Fabric 对象属性混合 | core 负责命名，adapter 负责同步 metadata |
| UI 直接拿 `fabricObj` | UI 只拿 `LayerModel` |

验收标准：LayerPanel 不再依赖 Fabric 对象；Fabric 对象替换后图层 id 仍稳定。

### Phase 4：ToolRegistry schema 化

| 当前代码 | 目标 |
|---|---|
| `ToolManager` 硬编码 `SelectModule` 等 | app 注册工具定义 |
| 工具模块返回 HTML | 工具定义返回 controls/presets schema |
| OptionsBar/PropertyPanel 调模块 HTML | UI 根据 schema 渲染控件 |

验收标准：新增一个端不需要复用旧 DOM HTML，只要渲染同一份 schema。

### Phase 5：FabricEngineAdapter 成型

| 当前代码 | 目标 |
|---|---|
| `CanvasManager` 暴露 Fabric canvas | app/core 只接触 adapter API |
| modules 直接操作 `canvas` | 逐步变为 adapter tool implementation |
| `CanvasManager.toJSON()` | `engine.serialize()` |

验收标准：core 不再直接 import 或引用 `fabric`。

### Phase 6：EffectCore 提纯

| 当前代码 | 目标 |
|---|---|
| `MosaicModule` 内像素算法 | `effects/mosaic.js` |
| `dynamicMosaic.js` 混合 Fabric 和算法 | 算法进入 effect-core，Fabric 捕获/回写留 adapter |
| `EraserModule` 栅格化混合 Fabric | mask/geometry 进入 effect-core |

验收标准：马赛克/模糊算法能用离屏 canvas 或测试 PixelBuffer 单独验证。

## 11. 第一轮最小改造建议

如果开始写代码，建议按下面顺序做，不建议直接重写全部 `core`。

1. 新增 `src/core/EventBus.js` 的类导出，同时保留默认单例过渡。
2. 新增 `src/core/EditorContext.js`，集中保存 `eventBus`、`engine`、`host`、`history`、`layers`。
3. 新增 `src/adapters/host/UtoolsHostAdapter.js`，先只封装打开、保存、复制、插件进入、高度设置。
4. 把 `ExportModule` 改为依赖 `host`，Toast 改成 eventBus 事件，由 UI 处理。
5. 把 `ToolManager._registerBuiltinModules()` 改成外部传入工具列表，先不改工具内部实现。
6. 把 `LayerPanel` 使用的图层数据收敛成纯 `LayerModel`，减少 UI 对 Fabric 的感知。

这样每一步都能独立验证，且不会破坏当前 uTools 版本。

## 12. 不建议现在做的事

| 不建议 | 原因 |
|---|---|
| 立刻移除 Fabric.js | 当前工具交互大量依赖 Fabric，替换成本高且没有直接收益 |
| 立刻引入 React/Vue 重写 UI | 多端 core 的关键是边界，不是 UI 框架 |
| 立刻做命令式历史系统 | 当前 snapshot 已能满足功能，先抽象接口即可 |
| 立刻做完整工程格式迁移 | Fabric JSON 仍是最可靠恢复格式，先包进 `engine.state` |
| 让 core 处理文件路径 | 文件路径是宿主能力，core 只处理 `ImageSource` |

## 13. 判断标准

后续每次新增代码，可以用这几个问题判断是否该进入 core：

| 问题 | 如果答案是“是” |
|---|---|
| 是否需要访问 DOM、window、document、navigator、localStorage？ | 不进 core，放 app/ui/host adapter |
| 是否需要调用 uTools/ZTools/Electron API？ | 不进 core，放 host adapter |
| 是否直接 new `fabric.*` 或访问 `fabric.Canvas`？ | 不进 core，放 Fabric adapter |
| 是否描述图层、历史、工具状态、工程数据？ | 可以进 core |
| 是否是像素算法或几何算法，输入输出可纯数据表达？ | 可以进 effect-core |
| 是否返回 HTML 字符串或操作 CSS class？ | 不进 core，放 UI layer |

## 14. Core v1 边界结论

Core v1 应该抽象出：

| 模块 | 进入 v1 |
|---|---|
| `EventBus` 类 | 是 |
| `HistoryStore` | 是，使用 adapter snapshot |
| `LayerStore` | 是，纯数据模型 |
| `ToolRegistry` | 是，工具定义和选项状态 |
| `ProjectSerializer` | 是，包装 `editorState + engineState` |
| `CanvasManager` | 否，迁到 Fabric adapter |
| `ExportModule` 文件/剪贴板部分 | 否，迁到 HostAdapter |
| `ExportModule` 导出 dataURL 计算 | 暂在 Fabric adapter，未来抽 `ExportService` |
| 工具 UI HTML | 否，迁到 UI schema |
| 马赛克/模糊像素算法 | 是，进入 effect-core |

最终一句话：core 管“编辑是什么”和“状态怎么变”，adapter 管“在这个端怎么画、怎么读写文件、怎么和用户界面交互”。
