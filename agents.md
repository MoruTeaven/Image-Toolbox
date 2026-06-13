# 图片工具箱 — 开发代理记录

> 最后更新：2026-06-13

## 功能改进

### 画笔工具 (2026-06-13)
- [功能] **新增独立画笔工具**：
  - 新增 `BrushModule`，使用 Fabric.js 自由绘制生成可独立选择、移动、删除和排序的涂鸦路径图层
  - 工具栏新增“画笔”入口，快捷键 `B`；预设栏提供红/蓝/黄/绿/白/黑颜色预设和细/中/粗/特粗粗细预设
  - 属性面板支持自定义画笔颜色和 1-80px 粗细；落笔前写入历史，支持撤销/重做
  - 涉及文件：`BrushModule.js`、`ToolManager.js`、`Toolbar.js`、`style.css`、`updateRecords.js`

### 移动/框选变换预设 (2026-06-12)
- [功能] **移动/框选预设栏新增旋转与翻转快捷操作**：
  - 新增 `SelectModule`，保留 Fabric.js 默认移动/框选行为，同时在预设栏提供 `旋转0°`、`旋转90`、`旋转180`、`旋转270`、`左右翻转`、`前后翻转`
  - 对当前选中图层或多选对象生效；未选中对象时按钮禁用；操作写入历史，支持撤销/重做
  - 涉及文件：`SelectModule.js`、`ToolManager.js`、`OptionsBar.js`、`style.css`、`updateRecords.js`

### 修复二次裁剪范围和旋转裁剪 (2026-06-11)
- [Bug] **第一次裁剪后再次剪切，裁剪框被上一轮裁剪范围裁掉**：
  - **根因**：已应用裁剪保存在 `canvas.clipPath` 上，Fabric.js 会用画布级 clipPath 裁掉后续新增的裁剪遮罩和裁剪框，导致第二次进入剪切时裁剪框只能在上一轮裁剪范围内完整显示
  - **修复**：进入剪切模式时临时移除画布级 clipPath，避免裁剪工具自身被裁掉；同时把旧裁剪临时挂到已有图层上，让画面仍保持第一次裁剪后的结果。取消/退出剪切时恢复旧裁剪，应用剪切时把新裁剪嵌套到旧裁剪上，保证第二次裁剪仍基于第一次裁剪继续收窄
- [Bug] **裁剪框旋转后应用剪切不生效**：
  - **根因**：`applyCrop()` 只用 `left/top/width/height` 重新创建未旋转矩形，丢失了裁剪框的 `angle`、`scaleX/scaleY`、`originX/originY` 等变换信息
  - **修复**：从当前裁剪框复制完整几何变换创建 clipPath；`CanvasManager` 序列化 canvas clipPath 时额外保留 `absolutePositioned`/`inverted`，保证撤销/重做后定位语义一致
  - 涉及文件：`CropModule.js`、`CanvasManager.js`、`updateRecords.js`
- [Bug] **裁剪后打码拖选框被错误裁掉，不能像未裁剪时一样显示到图像外**：
  - **根因**：已应用裁剪保存在 `canvas.clipPath` 上，Fabric.js 会用画布级 clipPath 裁掉打码工具的临时拖选框和画笔预览；但拖选框只是交互提示，不应该受图像/裁剪边界限制
  - **修复**：进入打码模式时临时移除画布级 clipPath，并把旧裁剪临时挂到已有图层上保持画面裁剪效果；拖选框和画笔预览不加裁剪，允许显示到图像外；实际打码区域在应用时截到原图/当前裁剪图像范围内，最终覆盖层仍复制当前裁剪链
  - 涉及文件：`MosaicModule.js`、`updateRecords.js`

### 移除网络资源引用 (2026-06-10)
- [Bug] **uTools 限制不能引入网络资源的 js 或 css**：
  - **根因**：`index.html` 中引用了外部 CDN（cdnjs/unpkg），uTools 插件不允许加载网络资源
  - **修复**：创建 `src/lib/` 目录，下载 `fabric.min.js` 本地文件，将 `<script src="https://cdnjs...">` 改为 `<script src="lib/fabric.min.js">`
  - 涉及文件：`src/index.html`，新增文件：`src/lib/fabric.min.js`

### 修复文件匹配无法加载图片 (2026-06-09)
- [Bug] **通过文件匹配进入插件后图片不显示（打开面板没有刚才选择的图片）**：
  - **根因1**：`preload.js` 中 `case 'files':` — uTools 文档中 `onPluginEnter` 回调的 `type` 值为 `'file'`（单数），不匹配导致永远走 `default` 分支，`imageSource` 保持 `null`
  - **根因2**：`index.js` 的 `onPluginEnter` 处理只调 `setExpendHeight` 不处理图片加载 → 插件已打开后再次匹配文件时，`_checkExternalSource()` 不会重新轮询，图片丢失
  - **根因3**（第二轮）：仅依赖 `window.__imageSource` 不够可靠 — page 和 preload 的 `onPluginEnter` 执行顺序不确定，可能出现竞态
  - **最终修复**：`index.js` 的 `onPluginEnter` 中**直接处理 payload**：对于 file/files 类型，调用 `window.readImageFile(fileInfo.path)` 直接读取文件，不依赖 preload 的 `__imageSource`；`img` 类型仍用 `__imageSource`；`_checkExternalSource` 添加超时日志；preload 已兼容 'file'/'files' 双 type
  - 涉及文件：`preload.js`、`index.js`

### 修复裁切操作无法撤销 (2026-06-09)
- [Bug] **裁切后按撤销无法恢复**：
  - **根因**：`canvas.clipPath` 是画布级别的属性，Fabric.js 的 `canvas.toJSON()` 只序列化画布上的物件，不序列化 `canvas.clipPath` → `HistoryManager.saveState()` 的快照不含 clipPath → 撤销恢复时 clipPath 丢失
  - **修复**：`CanvasManager.toJSON()` 手动将 `canvas.clipPath` 序列化到 `json._canvasClipPath`；`fromJSON()` 用 `fabric.util.enlivenObjects` 恢复 canvas.clipPath
  - 涉及文件：`CanvasManager.js`

### 修复文字模式下属性面板不生效 (2026-06-09)
- [Bug] **文字模式下修改属性栏（字号/颜色/描边/不透明度）没有任何反应**：
  - **根因1**：`TextModule.getPropertyPanelHTML()` 使用 `id` 属性标识控件，但 `PropertyPanel._handleInput()` 通过 `target.dataset.prop` 识别 → `data-prop` 为空 → 直接 `return`，所有修改被忽略
  - **根因2**：`PropertyPanel._handleInput()` switch 中缺少 `stroke` case，描边颜色修改无法处理
  - **根因3**：`TextModule.onPropertyChange()` 使用 key `'font-size'`，但 `_handleInput` 传递的是 `'fontSize'`（驼峰），不匹配
  - **修复**：`getPropertyPanelHTML()` 所有 `id="prop-*"` → `data-prop="*"`；`onPropertyChange` 中 `'font-size'` → `'fontSize'`；`_handleInput` 新增 `case 'stroke'`
  - 涉及文件：`TextModule.js`、`PropertyPanel.js`

### 不透明度滑块缩窄 + 双重除法修复 (2026-06-09)
- [改进] **不透明度滑块太长**：`.property-range` 从 `flex: 1` 改为固定 `width: 90px; flex: 0 0 auto`。涉及文件：`style.css`
- [Bug] **不透明度调低后文字直接消失（100% 能看见，90% 就没了）**：
  - **根因**：`_handleInput()` 在 `case 'opacity'` 中把 `value` 从 `"90"` 变换为 `0.9`，之后 `onPropertyChange` 又 `parseInt(value)/100` → `parseInt(0.9)=0` → `0/100=0` → TextModule 用 `0` 覆盖了正确的 `0.9`
  - **修复**：保存 `target.value` 原始值传给 `onPropertyChange`，不复用已被变换的 `value`
  - 涉及文件：`PropertyPanel.js`

### 导出 Toast 提示 (2026-06-09)
- [改进] **复制到剪贴板/保存成功后显示应用内 Toast**：
  - 替换 `utools.showNotification` 系统通知为自建 Toast 组件
  - Toast 从顶部滑入，停留 2 秒后淡出自动消失
  - 成功用绿色（#2e7d32），失败用红色（#c62828），带 SVG 图标
  - `_showToast()` 方法同时用于 `exportToFile` 和 `exportToClipboard`
  - 涉及文件：`ExportModule.js`、`style.css`

### 状态栏按钮样式优化 (2026-06-08)
- [改进] **"保存到电脑"和"复制到剪贴板"按钮更加明显**：
  - 普通按钮（复制到剪贴板）：白色描边 `rgba(255,255,255,0.55)`，hover 背景变亮、边框更明显
  - 主按钮（保存到电脑）：白底蓝字实心 + 投影，hover 浅蓝底
  - 涉及文件：`style.css`

### 状态栏导出按钮合并 (2026-06-08)
- [改进] **PNG/JPEG/WebP 三个按钮合并为一个"保存到电脑"按钮**：
  - 格式选择交给 uTools 保存对话框的过滤器（PNG/JPEG/WebP）
  - `StatusBar`：三个格式按钮 → 单个"保存到电脑"按钮，emit `'export:requested', 'file'`
  - `ExportModule.exportToFile()`：先弹对话框 → 从返回路径提取扩展名推断格式 → 生成 dataURL → 写入
  - `index.js`：去掉 format 参数透传
  - 工具栏"导出"按钮移除（与状态栏重复）
  - 涉及文件：`StatusBar.js`、`ExportModule.js`、`index.js`、`Toolbar.js`、`ToolManager.js`

### 打码颜色偏差修复 (2026-06-08)
- [Bug] **打码覆盖层偏蓝色**：
  - **真正根因**：`_finishRect()` 在蓝色选区框还盖在画布上时调用 `getImageData` → 像素已带蓝色 → 打码结果固化蓝色
  - **修复**：`_finishRect` 中先 `_cleanupRect()` 移除选区框，再 `applyMosaic`，确保读取像素时画布干净
  - 额外优化：模糊改用双 canvas 避免自绘制预乘 alpha 色偏；覆盖层直接 `new fabric.Image(tempCanvas)` 跳过 toDataURL 往返
  - 涉及文件：`MosaicModule.js`

### 打码工具合并 (2026-06-08)
- [改进] **画笔打码和框选打码合二为一**：
  - 工具栏只保留一个"打码"按钮（快捷键 M），移除独立的"画笔打码"（原 B 快捷键）
  - 选项栏新增"绘制模式"切换：框选 / 画笔
  - **框选模式**：拖拽矩形选区打码（原有行为）
  - **画笔模式**：自由涂抹打码，实时显示画笔预览圆圈，释放时对涂抹覆盖区域应用效果（带蒙版，只打码画笔轨迹经过的像素）
  - 效果类型（马赛克/模糊）作为通用选项，框选和画笔均可使用
  - 涉及文件：`MosaicModule.js`、`ToolManager.js`、`OptionsBar.js`、`Toolbar.js`、`constants.js`
- [改进] **画笔模式选项栏顺序调整**（2026-06-08）：选项栏控件顺序从「画笔大小 → 效果 → 块大小」改为「效果 → 块大小 → 画笔大小」，更符合认知习惯。涉及文件：`MosaicModule.js`

## 项目初始化 (v0.1/v0.2)

### 已创建文件 (22个)
```
plugin.json              — uTools 插件配置
preload.js               — Node.js 预加载（文件读写/剪贴板/生命周期）
src/
  index.html             — 主页面（五区布局 DOM）
  index.js               — 主入口（App 类，全局事件/快捷键/导入导出）
  style.css              — 全局样式（CSS 变量、BEM 命名、深色/浅色主题）
  core/
    EventBus.js          — 事件总线（发布-订阅，全局单例）
    CanvasManager.js     — 画布管理器（Fabric.js 封装，8类方法）
    LayerManager.js      — 图层管理器（z-order/显隐/锁定）
    HistoryManager.js    — 历史记录（JSON快照、撤销/重做、30步上限）
    ToolManager.js       — 工具管理器（注册/切换/生命周期）
  modules/
    BaseModule.js        — 模块基类（activate/deactivate/属性面板钩子）
    MosaicModule.js      — 打码模块（马赛克Canvas2D算法/模糊CSS filter）
    CropModule.js        — 剪切模块（clipPath非破坏性/蒙版/比例控制）
    TextModule.js        — 加字模块（fabric.IText/预设样式/属性编辑）
    ExportModule.js      — 导出模块（PNG/JPEG/WebP文件/剪贴板）
  ui/
    Toolbar.js           — 工具栏（SVG图标/分组/高亮）
    OptionsBar.js        — 选项栏（动态渲染/主题切换按钮）
    PropertyPanel.js     — 属性面板（位置/大小/透明度/文字属性）
    LayerPanel.js        — 图层面板（列表/显隐/锁定/选中）
    StatusBar.js         — 状态栏（尺寸/图层数/导出按钮）
  utils/
    constants.js         — 常量定义
    image.js             — 图片工具函数
```

### 架构层级
```
UI 层 (Toolbar/OptionsBar/PropertyPanel/LayerPanel/StatusBar)
  ↓ EventBus 事件
工具管理层 (ToolManager)
  ↓ Module API
功能模块层 (MosaicModule/CropModule/TextModule/ExportModule)
  ↓ Canvas API
核心层 (CanvasManager/HistoryManager/LayerManager/EventBus)
  ↓ Fabric.js API
Fabric.js 5.x 画布引擎
```

### 已修复 Bug
- [Bug] **LayerPanel 事件死循环**（2026-06-08）：`_refreshLayerList()` → `syncLayers()` → `emit('layers:updated')` → `_refreshLayerList()` 形成无限递归，`Maximum call stack size exceeded`。修复：加 `_refreshing` 重入锁。
- [Bug] **选择图片后画布无显示**（2026-06-08，三轮修复）：
  - **真正根因**：`utools.showOpenDialog()` 返回 `string[]`（文件路径数组），代码错误地当成 `{ filePaths: [] }` 对象处理 → `result.filePaths` 永远是 `undefined` → `_loadImage` 从未被调用
  - 附带修复1：`_loadImage` 先显示容器再加载图片（防 `_updateCanvasSize` 读到 0×0）
  - 附带修复2：`fabric.Image.fromURL(url, callback, imgOptions, crossOrigin)` — `crossOrigin` 移到第4参数位置
  - 附带修复3：回调检查 `isError`/`null` + 30 秒超时保护
  - 附带修复4：`ExportModule` 中 `utools.showSaveDialog()` 返回 `string` 直接使用，同款 bug
- [Bug] **每次操作图层编号都重新排序**（2026-06-08）：`syncLayers()` 先将 `_layers` 清空为 `[]`，再调用 `_findMeta()` 在此空数组中查找已有元数据 → 永远找不到 → 每次都重建元数据分配新 ID。修复：保留 `oldLayers` 引用，先在旧列表中匹配已有对象，再构建新列表。
- [Bug] **主题切换不生效**（2026-06-08）：`OptionsBar` 构造函数中 `_bindEvents()` 先于 `_render()` 执行 → `querySelector('#theme-toggle')` 找不到 DOM 元素 → 点击事件从未绑定。修复：调换 `_render()` / `_bindEvents()` 调用顺序。
- [Bug] **工具模式下误触发图层的选中/拖动**（2026-06-08）：`canvas.selection = false` 只禁用框选，不阻止单个对象的选中和移动。用户在马赛克/剪切/文字模式下操作时，点中已有覆盖层导致 Fabric.js 误拖图层。
  - **根因**：Fabric.js 对象的 `selectable`/`evented` 默认 `true`，仅靠 `canvas.selection = false` 不够
  - **修复**：`BaseModule.activate()` 中统一调用 `_setObjectsInteractivity(false)` 禁用全部对象的 selectable/evented；`deactivate()` 恢复
  - 子类特殊处理：TextModule 激活后恢复文字对象的交互性（允许点击编辑）；CropModule 在激活后新建裁剪框，不受影响；MosaicModule 新建马赛克覆盖层时显式设 `selectable: false`
  - 涉及文件：`BaseModule.js`、`MosaicModule.js`、`CropModule.js`、`TextModule.js`
- [Bug] **放大后裁剪框消失/找不到**（2026-06-08）：裁剪模块用 `canvas.width/height`（视口像素）定位裁剪框和遮罩 → 放大平移后，视口像素对应 canvas 坐标发生偏移 → 裁剪框被渲染到屏幕外。修复：
  - 新增 `_getVisibleBounds()` / `_getVisibleCenter()` 通过 `viewportTransform` 反算可视区域在 canvas 坐标系中的位置
  - `_createMask()` / `_createCropRect()` / `_updateMask()` 全部改用可视区域坐标定位
  - 遮罩和裁剪框跟随缩放/平移实时调整（`_updateMask` 在 moving/scaling 时重新计算）
- [Bug] **图层面板顺序颠倒**（2026-06-08）：`syncLayers()` 中背景图层先 push → 背景排在面板顶部。Photoshop 惯例要求顶层物体在面板顶部、背景在底部。修复：先 push 非背景图层（topmost→bottommost），最后 push 背景。涉及文件：`LayerManager.js`
- [Bug] **下拉框无法选择，一点就关**（2026-06-08）：`OptionsBar._handleControlEvent` 对所有事件类型（`input`/`change`/`click`）都做相同处理。用户点击 `<select>` 时 `click` 事件触发 `_updateControls()` → `innerHTML` 被替换 → 原始 `<select>` DOM 被销毁，下拉框瞬间消失。修复：为所有 `<select>` 控件（`mosaic-mode`、`text-font-family`、`text-font-size`）添加 `e.type === 'change'` 条件，只在值真正改变时响应。涉及文件：`OptionsBar.js`

### 功能改进
- [改进] **工具栏撤销/重做按钮**（2026-06-08）：
  - 移除工具栏中的"放大"/"缩小"按钮（缩放仍可通过底部状态栏或滚轮操作）
  - 替换为"返回上一步"（撤销）和"撤销返回"（重做）按钮
  - 按钮根据 HistoryManager 状态自动启用/禁用（灰色不可用时）
  - 新增 Ctrl+Y 快捷键支持重做（另保留原有 Ctrl+Shift+Z）
  - 涉及文件：`Toolbar.js`、`index.js`
- [功能] **背景图层**（2026-06-08）：
  - `LayerManager.syncLayers()` 不再跳过 `originalImage`，将其作为特殊的"背景"图层显示在图层面板最底部
  - 背景图层始终锁定（不可解锁）、不可删除、不可移动排序
  - `LayerPanel` 中背景图层使用特殊图标（山水画 SVG）和灰显锁图标
  - CSS 新增 `.layer-item--background`、`.layer-item__lock--bg` 样式
  - 涉及文件：`LayerManager.js`、`LayerPanel.js`、`style.css`

### 待完成 (v0.3+)
- [ ] 图层拖拽排序
- [ ] 涂鸦/箭头标注
- [ ] 形状标注（框、圆、线）
- [ ] 图片滤镜
- [ ] 贴纸/水印
- [ ] 多图编辑（Tab 切换）
