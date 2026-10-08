# 图片工具箱 · SDK 化企划书 v2.0

> 版本：v2.0 ｜ 日期：2026-09-23 ｜ 状态：执行中
> 目标仓库：图片工具箱 - 客户端（github.com/MoruTeaven/Image-Toolbox）
> 当前版本：v2.5.1-dev

---

## 一、结论先行（v2.0 更新）

**方案已从"npm SDK 包"调整为"iframe + 版本化缓存 SDK"模式**，这是业界成熟的集成方案（百度地图、高德地图 JS SDK 均采用此模式）。

| 结论 | 说明 |
|------|------|
| ✅ **可行** | 现有 Web 端已支持 `?img=<url>` 参数导入，距离 iframe 嵌入只差消息协议和缓存层 |
| 🎯 **推荐方案** | iframe 隔离 + Service Worker 强缓存 + 版本接口检查，实现"一行 script 嵌入、秒开、自动更新" |
| 🚫 **不推荐** | npm SDK 包（体积大、集成成本高、版本管理复杂） |

### 体积对比

| 集成方式 | 宿主下载体积 | 传输体积 | 缓存命中时 |
|---------|-----------|---------|-----------|
| **iframe + 版本化缓存（新方案）** | **0 KB** | 首次 ~1MB | **0 KB（秒开）** |
| SDK npm 包（旧方案） | 160-250 KB gzip | 每次部署 | 依赖宿主缓存 |
| 纯 iframe（无缓存） | 0 KB | 每次 ~1MB | 0 KB（但重复下载） |

### 核心优势

1. **集成成本极低**：一行 `<script src="...">` + 3 行配置即可嵌入
2. **版本自动更新**：版本接口检查，宿主无感升级
3. **强缓存加速**：Service Worker 缓存，命中时 0 网络请求
4. **完全隔离**：iframe 沙箱，不污染宿主页面
5. **离线可用**：缓存命中时无需网络
6. **多实例支持**：天然支持同页多编辑器

---

## 二、架构设计

```text
┌─────────────────────────────────────────────────────────┐
│  宿主页面（任意项目）                                      │
│                                                          │
│  <script src="https://cdn.example.com/img-toolbox/sdk.js"></script>
│                                                          │
│  const editor = new ImageToolbox({                       │
│    mount: '#container',                                  │
│    image: 'https://xxx.com/img.png'                     │
│  });                                                     │
└──────────────────────┬──────────────────────────────────┘
                       │ ① 请求版本接口（< 1KB JSON）
                       ▼
┌─────────────────────────────────────────────────────────┐
│  版本接口  GET /api/version                              │
│                                                          │
│  {                                                       │
│    "version": "2.5.1",                                   │
│    "assets": {                                           │
│      "main.js":    { "url": "/v2.5.1/main.js", "hash": "abc123" },
│      "style.css":  { "url": "/v2.5.1/style.css", "hash": "def456" },
│      "fabric.js":  { "url": "/v2.5.1/fabric.js", "hash": "ghi789" }
│    }                                                     │
│  }                                                       │
└──────────────────────┬──────────────────────────────────┘
                       │ ② SDK 对比本地缓存版本
                       ▼
┌─────────────────────────────────────────────────────────┐
│  缓存检查                                                │
│                                                          │
│  if (本地缓存版本 === 远端版本) {                            │
│      ③ 直接用缓存资源 → 瞬间加载                           │
│  } else {                                                │
│      ④ 下载新资源 → 更新缓存 → 加载                       │
│  }                                                       │
└──────────────────────┬──────────────────────────────────┘
                       │ ⑤ 创建 iframe
                       ▼
┌─────────────────────────────────────────────────────────┐
│  编辑器实例（iframe 内运行，缓存命中时：0 网络请求）          │
└─────────────────────────────────────────────────────────┘
```

---

## 三、消息协议设计（EMBED_PROTOCOL.md）

### 3.1 宿主 → iframe

```javascript
// 加载图片
iframe.contentWindow.postMessage({
  type: 'load-image',
  payload: 'data:image/png;base64,...'
}, '*');

// 设置可用工具
iframe.contentWindow.postMessage({
  type: 'set-tools',
  payload: ['select', 'mosaic', 'crop']
}, '*');

// 设置配置项
iframe.contentWindow.postMessage({
  type: 'set-options',
  payload: { theme: 'dark', locale: 'zh-CN' }
}, '*');

// 关闭编辑器
iframe.contentWindow.postMessage({
  type: 'close'
}, '*');
```

### 3.2 iframe → 宿主

```javascript
// 编辑器就绪
window.parent.postMessage({
  type: 'editor:ready'
}, '*');

// 导出完成
window.parent.postMessage({
  type: 'editor:exported',
  payload: {
    format: 'png',
    data: 'data:image/png;base64,...',
    size: 102400
  }
}, '*');

// 用户取消
window.parent.postMessage({
  type: 'editor:cancelled'
}, '*');

// 错误
window.parent.postMessage({
  type: 'editor:error',
  payload: {
    code: 'LOAD_FAILED',
    message: '图片加载失败'
  }
}, '*');
```

---

## 四、版本接口规范（version.json）

```json
{
  "version": "2.5.1",
  "builtAt": "2026-09-23T10:00:00Z",
  "assets": {
    "main.js": {
      "url": "https://cdn.example.com/v2.5.1/main.js",
      "hash": "abc123def456",
      "size": 250000
    },
    "style.css": {
      "url": "https://cdn.example.com/v2.5.1/style.css",
      "hash": "def456ghi789",
      "size": 63000
    },
    "fabric.js": {
      "url": "https://cdn.example.com/v2.5.1/fabric.js",
      "hash": "ghi789jkl012",
      "size": 310000
    }
  }
}
```

### CDN 缓存头约定

| 资源类型 | Cache-Control | 说明 |
|---------|--------------|------|
| `/api/version` | `no-cache` | 总是检查最新版本 |
| `/v{version}/main.js` | `public, max-age=31536000, immutable` | 永久缓存（版本号变了才重新下载） |
| `/v{version}/style.css` | `public, max-age=31536000, immutable` | 永久缓存 |
| `/v{version}/fabric.js` | `public, max-age=31536000, immutable` | 永久缓存 |

---

## 五、SDK Loader 设计

### 5.1 核心 API

```javascript
// 创建编辑器实例
const editor = new ImageToolbox({
  mount: '#container',           // 挂载点
  image: 'https://...',          // 初始图片（可选）
  tools: ['select', 'mosaic'],   // 可用工具（可选）
  theme: 'dark',                 // 主题（可选）
  locale: 'zh-CN',               // 语言（可选）
  onReady: () => {},             // 就绪回调（可选）
  onExported: (data) => {},      // 导出回调（可选）
  onCancelled: () => {},         // 取消回调（可选）
  onError: (error) => {}         // 错误回调（可选）
});

// 销毁编辑器
editor.destroy();

// 获取编辑器版本
console.log(editor.version);
```

### 5.2 实现要点

1. **版本检查**：GET `/api/version`，对比本地缓存版本
2. **缓存命中**：直接使用缓存资源，0 网络请求
3. **缓存未命中**：下载新资源，更新 Service Worker 缓存
4. **iframe 创建**：创建 iframe，设置 src 为编辑器页面
5. **postMessage 通信**：双向消息桥，支持事件监听
6. **多实例支持**：每个 `new ImageToolbox()` 创建独立实例
7. **错误降级**：加载失败显示重试按钮

---

## 六、Service Worker 缓存策略

```javascript
self.addEventListener('fetch', async (event) => {
  const url = new URL(event.request.url);
  
  // 版本接口：总是网络优先
  if (url.pathname === '/api/version') {
    return fetch(event.request);
  }
  
  // 资源文件：缓存优先
  const cached = await caches.match(event.request);
  if (cached) return cached;
  
  // 未命中：下载并缓存
  const response = await fetch(event.request);
  const cache = await caches.open('img-toolbox-v2');
  cache.put(event.request, response.clone());
  return response;
});

// 缓存清理：保留最近 3 个版本
self.addEventListener('activate', async (event) => {
  const caches = await caches.keys();
  await Promise.all(caches.slice(-3).map(c => caches.delete(c)));
});
```

---

## 七、实施路线（v2.0）

### 阶段 0 · 协议冻结（1 天）

**任务卡：** `t-mukyi278-upyrfc`

| 交付物 | 说明 |
|--------|------|
| EMBED_PROTOCOL.md | iframe 双向消息协议规范 |
| version.json 规范 | 版本接口契约 |

**验收标准：** 协议文档完整，消息类型、载荷格式、错误码、时序图齐全。

---

### 阶段 1 · 核心实现（3 天）

**任务卡：** `t-mukyis1r-2f1f6x`

| 交付物 | 说明 |
|--------|------|
| SDK Loader（img-toolbox-sdk.js） | < 10KB，纯原生 JS |
| Service Worker（img-toolbox-sw.js） | 缓存策略实现 |
| 部署配置 | build.ps1 输出版本化路径 |

**验收标准：** 端到端测试通过，缓存命中时 0 网络请求。

---

### 阶段 2 · 嵌入模式（1 天）

**任务卡：** `t-mukyje2c-wt92cf`

| 交付物 | 说明 |
|--------|------|
| 嵌入模式改造 | `?embed=1` 支持，不影响现有功能 |
| EMBED_DEVELOPER.md | 完整开发者文档 |
| examples/ | 3 个可运行示例 |

**验收标准：** 示例可直接运行，文档完整可用。

---

## 八、与 v1.0 方案的对比

| 维度 | v1.0（npm SDK 包） | v2.0（iframe + 缓存） |
|-----|-------------------|---------------------|
| **集成方式** | `npm i @moruteaven/core` | `<script src="...">` |
| **宿主下载体积** | 160-250 KB gzip | **0 KB** |
| **缓存命中时** | 依赖宿主缓存 | **0 网络请求** |
| **版本更新** | 需宿主升级依赖 | **自动（版本接口检查）** |
| **技术栈隔离** | 需共存（可能冲突） | **完全隔离（iframe）** |
| **跨技术栈** | 需适配各框架 | **任意 HTML 页面** |
| **集成成本** | 1-3 天 | **10 分钟** |
| **维护成本** | 中（构建流水线） | **中（版本接口 + 缓存）** |
| **深度定制** | ✅ 支持 | ❌ 仅协议扩展点 |
| **外部公开** | ✅ 支持 | ✅ 支持（低门槛） |

---

## 九、关键技术决策

| 决策点 | 方案 | 理由 |
|-------|------|------|
| **编辑器隔离** | iframe | 完全隔离，天然支持 Canvas |
| **缓存机制** | Service Worker | 跨浏览器标准，支持离线 |
| **版本检查** | HTTP 接口 | 简单可靠，支持灰度 |
| **通信方式** | postMessage | 跨域标准，安全可控 |
| **SDK 引入** | `<script src>` | 兼容所有宿主环境 |
| **缓存版本数** | 保留最近 3 个 | 平衡空间和回滚能力 |

---

## 十、风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| **Service Worker 兼容性** | 🟡 中 | 降级到无缓存模式，仅 iframe |
| **postMessage 安全** | 🟡 中 | 严格校验 targetOrigin，不使用 '*' |
| **版本接口单点故障** | 🟢 低 | 降级到直接 iframe src，跳过版本检查 |
| **缓存污染** | 🟢 低 | 资源 URL 带版本号，hash 校验 |
| **iframe 跨域限制** | 🟡 中 | 使用同源部署，或配置 CORS |

---

## 十一、后续演进（可选）

| 演进方向 | 触发条件 |
|---------|---------|
| **灰度发布** | 需要逐步放量新版本 |
| **多版本并行** | 不同宿主需要不同版本 |
| **插件市场** | 外部开发者贡献扩展 |
| **深度定制 SDK** | 重度使用方需要嵌入宿主代码 |
| **离线优先** | 需要完全离线使用 |

---

## 十二、任务卡清单

| 卡号 | 标题 | 紧急度 | 依赖 | 预估 |
|------|------|--------|------|------|
| t-mukyi278-upyrfc | 定义 EMBED_PROTOCOL.md 与 version.json 规范 | 🔴 urgent | 无 | 1 天 |
| t-mukyis1r-2f1f6x | 实现 SDK Loader 核心与 Service Worker 缓存层 | 🔴 urgent | 卡 1 | 3 天 |
| t-mukyje2c-wt92cf | 嵌入模式改造与开发者文档示例 | 🔴 urgent | 卡 1, 2 | 1 天 |

**总计：5 天**

---

## 十三、验收标准

### 阶段 0 完成
- [ ] EMBED_PROTOCOL.md 定义完整消息协议
- [ ] version.json 规范定义完整契约
- [ ] 协议文档经过 review

### 阶段 1 完成
- [ ] SDK Loader < 10KB
- [ ] Service Worker 缓存策略实现
- [ ] 缓存命中时 0 网络请求
- [ ] 支持多实例并存
- [ ] 端到端测试通过

### 阶段 2 完成
- [ ] `?embed=1` 模式不影响现有功能
- [ ] EMBED_DEVELOPER.md 完整可用
- [ ] 3 个示例可直接运行
- [ ] 文档包含所有 API 和最佳实践

---

## 十四、一句话总结

**采用 iframe + 版本化缓存 SDK 模式，实现"一行 script 嵌入、秒开、自动更新"。总工期 5 天，交付三个任务卡，让任何 HTML 页面都能快速集成图片工具箱编辑器。**
