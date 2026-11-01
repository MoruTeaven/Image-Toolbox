# AI 编辑功能策划（t-mv39ac2c-sw1d47）

> 状态：策划稿（待评审） · 基线版本：3.0.0-dev · 撰写日期：2026-10-30
> 本文是功能策划，不含实现代码；实施时按 §7 分期拆任务。

---

## 1. 定位与边界

**AI 编辑 = 以画布已有内容为输入的编辑型 AI 能力**，输出仍是编辑结果（图层/像素/参数），服务于「快速修图」主线。

明确不做（与 爱生图 客户端划界，避免重复建设）：

- ❌ 文生图 / 图生图 / 提示词工程 / 生图模型与服务商运营能力 → 归 爱生图
- ❌ 把图片工具箱做成 AI 客户端；AI 只作为编辑工具族的一个工具（`AIModule`）
- ✅ 允许的交集：AI 贴纸/素材生成（P2 远期，经爱生图产出后作为贴纸导入，不内嵌生图 UI）

## 2. 能力清单与分期

| 分期 | 能力 | 输入 | 推理位置 | 依赖 |
|------|------|------|----------|------|
| P0 | AI 一键抠图（去背景） | 整图/选中图层 | 本地（ONNX Runtime Web + u2netp 人像分割，~4.7MB） | 无后端、无密钥 |
| P0 | 结果入图层 + 撤销 | 抠图输出 | — | LayerManager/HistoryManager 现有链路 |
| P1 | AI 消除（Inpainting） | 框选区域 mask | 云端（后端代理，LaMa 类模型） | 新后端端点 |
| P1 | AI 扩图（Outpainting） | 画布外扩方向/尺寸 | 云端（后端代理） | 新后端端点 |
| P1 | AI 自动脱敏 | 检出人脸/文字区域 → 一键打码 | 本地检测（BlazeFace 类）+ 现有 MosaicModule | 无后端 |
| P2 | 对话式编辑 | 自然语言 → 参数 JSON | 云端文本模型（后端代理） | 白名单校验层 |
| P2 | 超分/画质增强 | 整图 | 云端（后端代理，Real-ESRGAN 类） | 新后端端点 |
| P2 | AI 贴纸/素材 | 文本描述 | 经 爱生图 产出 | 跨项目联动 |

**对话式编辑是差异化亮点**：项目已有 `FILTER_PARAMS` 唯一参数表与工具操作集，AI 只需输出受白名单约束的 JSON（如 `{tool:'color', params:{brightness:-7}}`），再驱动现有模块执行——不生成像素、不引入生图风险、调用成本低，且天然复用撤销/历史链路。

## 3. 架构设计（贴合现有分层）

### 3.1 新增文件

```text
core/src/
├── ai/
│   ├── AIProvider.js          # Provider 接口 + 能力描述（capabilities：removeBg/inpaint/...）
│   ├── AI_PROVIDERS.js        # Provider 注册表（唯一入口，模式对齐 utils/filters.js 的 FILTER_PARAMS）
│   ├── LocalOnnxProvider.js   # 本地推理（onnxruntime-web，模型资产按端策略加载）
│   ├── ServerProxyProvider.js # 业务后端 /ai/* 代理（复用 IdentityClient token）
│   └── ByokProvider.js        # 用户自带 Key（可选，P1 末评估是否保留）
├── ports/
│   └── AIPort.js              # 网络请求/资产获取唯一出口（core 非 UI 层不发裸 fetch）
├── modules/
│   └── AIModule.js            # 工具模块：选项栏（抠图/消除/扩图入口 + 进度 + 应用/放弃）
└── ui/
    └── AIPanel.js             # 侧栏/选项栏 UI（沿用现有图标体系：内联 SVG，Lucide ISC 协议可用）
```

### 3.2 关键链路

```text
AIModule（交互：框选/整图） → AIProvider（能力路由，AI_PROVIDERS 注册表）
  → AIPort（网络/资产唯一出口） → LocalOnnx / ServerProxy / Byok
  → 结果 → LayerManager 新图层 → HistoryManager 快照 → 撤销天然可用
```

- 事件：`ai:taskStarted` / `ai:taskProgress` / `ai:taskFinished` / `ai:taskFailed` 进 EventBus；进度走 StatusBar + Toast。
- 结果一律作为**新图层**插入（不原地覆盖原图），替换背景色/透明化只影响该图层；用户可删除图层回退。
- Provider 注册表是唯一权威来源：新增一种 AI 能力 = 在表里加一条（能力名、Provider、参数 schema、UI 文案），AIModule/AIPanel 由表派生，**不得**在模块里再写第二份能力清单（对齐调色参数表的既有纪律，并考虑纳入第 8 项门禁的同类断言）。
- `canvas.clipPath` 换入换出沿用 `ClipPathSession`（若消除/扩图需临时裁剪交互辅助）。

### 3.3 三端模型/资产策略

| 端 | 模型与 wasm | 说明 |
|----|-------------|------|
| Web | 首次使用时按需加载（自托管静态资源，非第三方 CDN） | 缓存到浏览器 Cache Storage |
| uTools / ZTools | 打包进插件目录（本地加载，满足「不加载网络资源」红线） | 需实测插件包体积增量（~13–17MB）；若超限改为「首次使用经后端下载到宿主存储」的降级方案 |
| 离线兜底 | 云端能力不可达时明确提示，本地能力（抠图/脱敏）不受影响 | 降级策略是硬要求（§8.2 多端兼容） |

## 4. 配置、安全与隐私

- **不硬编码任何密钥**（AGENTS.md §8.3 红线）：云端默认走业务后端代理（`api.image-toolbox.moruteaven.com`，复用 IdentityClient token，可配额/计费）；BYOK 的 key 经 `utils/preferences.js` 仅存本机，UI 脱敏显示。
- **隐私确认**：首次云端处理前弹确认框说明「图片将上传到服务器处理」，可勾选记住选择；localStorage 记录该偏好。
- **AI 请求出口唯一**：core 非 UI 层一律经 `AIPort` 发起 AI 网络请求，便于安全断言与审计。
- 安全门禁扩展：`verify-security-hardening.mjs` 新增断言——源码无密钥指纹（`sk-` 等）、AI fetch 仅存在于 AIPort、Provider 表引用合法。

## 5. 构建门禁与文档同步点（实施时必须逐项过）

1. `verify-artifact.mjs`：onnxruntime-web 进 bundle，external 白名单不变（仅打包输入来源新增 `core/src/ai/`，本来就允许）。
2. `verify-bundle-smoke.mjs` / `verify-preload-smoke.mjs`：AI 模块随 bundle 桩件冒烟，需确认 onnxruntime 在 Node 桩件下可安全空载（无模型时不初始化推理会话）。
3. `verify-security-hardening.mjs` + 变异自验：新增 §4 断言，且每层兜底可被证伪（历史教训：只断言最终结果会被兜底网掩盖）。
4. `verify-doc-refs.mjs`：本文档与 AGENTS.md §1 工具表、README 构建说明同步（新增脚本须双向点名）。
5. CHANGELOG：发布走 3.0.0-dev 条目追加规则；文案只写用户可见内容（如「新增 AI 一键抠图」）。
6. ESLint/编码规范照旧（2 空格、单引号、`#core/` 别名、BEM 样式、开源图标不用 emoji）。

## 6. 交互草案（P0 抠图）

1. 工具栏新增「AI」按钮（组 `enhance`，图标 Lucide `wand-2` 风格内联 SVG），无快捷键或 `W`（待定）。
2. 选项栏：`[抠图范围: 整图 | 当前图层]` `[边缘羽化: 0–7px，默认 2]` `[输出: 抠除背景(透明) | 替换背景色]` `[开始]`。
3. 进行中：StatusBar 进度 + 可取消（AbortController 贯穿到 Provider）。
4. 完成：抠出的前景作为新图层；背景图图层可手动删除。

## 7. 分期实施计划

| 阶段 | 内容 | 预估 | 交付判据 |
|------|------|------|----------|
| P0（~7 人日） | AIPort + LocalOnnxProvider 骨架；AIModule 抠图；图层/历史/取消/进度；三端体积实测；门禁断言 + 文档 + CHANGELOG | 7 人日 | 三端可用、可撤销、构建全门禁绿 |
| P1 | 后端 AI 代理端点（另立任务，chenyande-infra Deno 栈）；AI 消除/扩图；自动脱敏；BYOK 决策落地 | 后端 7 人日 + 前端 7 人日 | 消除/扩图可用且有配额 |
| P2 | 对话式编辑（白名单 JSON → 现有工具链）；超分；AI 贴纸联动爱生图 | 另行评估 | — |

## 8. 风险与开放问题

- **uTools 插件包体积上限待验证**：模型+wasm 本地化约 +13–17MB，超限时走「首次下载」降级（§3.3）。
- **模型许可逐个核验**：红线仅 MIT/Apache/BSD 等非传染协议；@imgly/background-removal 等现成轮子协议存疑，默认不选，以 onnxruntime-web(MIT) + Apache-2.0 模型组合为基线。
- **本地小模型精度取舍**：u2netp 4.7MB 优先保人像，通用物体分割需更大模型，P0 文案不承诺通用抠图。
- **后端为跨项目依赖**：P1 全部云端能力依赖新后端端点，需在基础设施仓库另立看板任务（跨工作区放权流程见用户既有约定）。
- **当前工作区遗留 3 个未提交文件**（`core/src/utils/filters.js`、`packages/changelog/src/changelog.js`、`scripts/verify-filter-params-table.mjs`）：非本任务产物，实施前需先确认归属并处理。

## 9. 待用户决策

1. P0 路线：**本地模型抠图（推荐，零成本零依赖）** vs 先做云端再补本地？
2. 云端推理：**业务后端代理（推荐，可配额计费）** vs 纯 BYOK 自带 Key？
3. 入口形态：**工具栏第 11 个工具按钮（推荐）** vs 侧栏 tab？
4. BYOK 与 爱生图 的「自定义服务商」是否共用一套组件（P1 末评估）？
