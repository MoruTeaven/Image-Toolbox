# 平台适配设计：用户、存储与宿主 API

> 目标：`core/` 只依赖统一接口，不直接判断 uTools、ZTools、Tauri。不同客户端在 `clients/*` 中实现自己的平台适配器，构建时输出到 `dist/<platform>/`。

## 结论

可以根据不同设备/客户端调用不同接口。

做法不是在 `core/` 里写：

```js
if (isUTools) {}
if (isTauri) {}
```

而是让每个客户端注入自己的 `HostAdapter`：

```js
// clients/utools/src/index.js
const host = new UtoolsHostAdapter();

// clients/tauri/src/index.js
const host = new TauriHostAdapter();

const app = new App({ host });
```

`core/` 调用统一能力：

```js
await host.storage.set('editor.theme', 'dark');
const user = await host.user.getCurrentUser();
await host.clipboard.writeImage(dataURL);
```

底层实际调用什么 API，由不同客户端决定。

## 分层

```text
core/
  编辑引擎、工具、历史、图层、统一接口
  不直接访问 utools / ztools / tauri / window.hostTools

clients/utools/
  uTools 插件入口、页面、样式、preload、UtoolsHostAdapter

clients/ztools/
  ZTools 入口、页面、样式、ZtoolsHostAdapter

clients/tauri/
  Tauri 入口、页面、样式、TauriHostAdapter

dist/
  uTools/
  zTools/
  tauri/
```

## HostAdapter v2 形态

建议把平台能力按领域分组，避免一个类里塞几十个方法。

```ts
interface HostAdapter {
  platform: HostPlatform;
  user: UserAdapter;
  storage: StorageAdapter;
  file: FileAdapter;
  clipboard: ClipboardAdapter;
  window: WindowAdapter;
  system: SystemAdapter;
  lifecycle: LifecycleAdapter;
}
```

### Platform

```ts
interface HostPlatform {
  id: 'utools' | 'ztools' | 'tauri' | 'web';
  name: string;
  version?: string;
  runtime?: 'electron' | 'webview' | 'browser';
}
```

用途：展示宿主信息、日志、能力判断。

### UserAdapter

```ts
interface UserAdapter {
  getCurrentUser(): Promise<HostUser | null>;
  onUserChanged?(callback: (user: HostUser | null) => void): () => void;
}

interface HostUser {
  id: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  raw?: unknown;
}
```

不同平台映射：

```text
uTools: utools.getUserInfo() / getUser()
ZTools: ztools 用户接口，若兼容 utools 则复用
Tauri: invoke('get_current_user') 或本地配置
Web: null 或业务登录态
```

原则：

- `core/` 只认 `HostUser`
- 平台原始字段放到 `raw`
- 不保证所有端都有用户；无用户时返回 `null`

### StorageAdapter

```ts
interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  clearByPrefix?(prefix: string): Promise<void>;
}
```

推荐再提供 JSON 包装层：

```js
async function getJSON(host, key, fallbackValue) {
  const raw = await host.storage.get(key);
  if (!raw) return fallbackValue;
  try { return JSON.parse(raw); } catch { return fallbackValue; }
}

async function setJSON(host, key, value) {
  await host.storage.set(key, JSON.stringify(value));
}
```

不同平台映射：

```text
uTools: utools.db / localStorage / preload 暴露的文件存储
ZTools: ztools.db / localStorage / 兼容 utools API
Tauri: invoke('storage_get') / @tauri-apps/plugin-store / 文件存储
Web: localStorage / IndexedDB
```

推荐 key 命名：

```text
img-toolbox:user:recent-fonts
img-toolbox:editor:theme
img-toolbox:editor:layout
img-toolbox:export:last-format
```

存储范围建议：

```text
local: 设备本地偏好，例如主题、布局、最近字体
user: 用户维度偏好，例如订阅信息、云同步设置
session: 临时编辑状态，不跨重启
cache: 可丢弃缓存，例如字体扫描结果
```

当前阶段优先实现 `local` 即可。

### FileAdapter

```ts
interface FileAdapter {
  pickImage(): Promise<string | File | Blob | null>;
  readImageFile(path: string): Promise<string | null>;
  saveImage(data: Blob | string, suggestedName?: string): Promise<boolean>;
}
```

不同平台映射：

```text
uTools: showOpenDialog / showSaveDialog / preload fs.readFileSync / fs.writeFileSync
ZTools: 对应文件对话框 API，或兼容 uTools API
Tauri: dialog.open / dialog.save / fs plugin / invoke
Web: input[type=file] / FileReader / a[download]
```

### ClipboardAdapter

```ts
interface ClipboardAdapter {
  readImage?(): Promise<string | null>;
  writeImage(data: Blob | string): Promise<boolean>;
  writeText?(text: string): Promise<boolean>;
  readText?(): Promise<string | null>;
}
```

不同平台映射：

```text
uTools: Electron clipboard / preload nativeImage
ZTools: 宿主剪贴板 API 或 Electron clipboard
Tauri: clipboard plugin / invoke
Web: navigator.clipboard，能力不足时降级
```

### WindowAdapter

```ts
interface WindowAdapter {
  setHeight?(height: number): void;
  setWidth?(width: number): void;
  setTitle?(title: string): void;
  close?(): void;
}
```

不同平台映射：

```text
uTools: setExpendHeight / setExpendWidth
ZTools: 对应窗口 API
Tauri: appWindow.setSize / setTitle / close
Web: noop
```

### SystemAdapter

```ts
interface SystemAdapter {
  openExternal(url: string): Promise<boolean>;
  getSystemFonts?(): Promise<string[]>;
  showNotification?(message: string, type?: 'success' | 'error' | 'info'): void;
}
```

不同平台映射：

```text
uTools: shellOpenExternal / preload 字体扫描 / showNotification
ZTools: 对应系统 API
Tauri: shell.open / invoke('get_system_fonts')
Web: window.open / Font Access API fallback / toast only
```

### LifecycleAdapter

```ts
interface LifecycleAdapter {
  onEnter?(callback: (event: HostEnterEvent) => void): () => void;
  onExit?(callback: () => void): () => void;
}

interface HostEnterEvent {
  code?: string;
  type?: 'file' | 'files' | 'img' | 'text' | string;
  payload?: unknown;
  from?: string;
}
```

不同平台映射：

```text
uTools: utools.onPluginEnter / onPluginOut
ZTools: ztools 生命周期 API
Tauri: window events / deep link / command payload
Web: URL params / postMessage / drag-drop
```

## 推荐目录

```text
core/src/
  interfaces/
    HostAdapter.js
  services/
    StorageService.js
    UserService.js

clients/utools/src/
  adapters/host/
    UtoolsHostAdapter.js
    UtoolsStorageAdapter.js
    UtoolsUserAdapter.js

clients/ztools/src/
  adapters/host/
    ZtoolsHostAdapter.js

clients/tauri/src/
  adapters/host/
    TauriHostAdapter.js
```

如果代码量不大，第一阶段可以先只保留一个文件：

```text
clients/utools/src/adapters/host/UtoolsHostAdapter.js
```

等方法变多后再拆成 `UserAdapter`、`StorageAdapter`、`FileAdapter`。

## core 中的使用方式

核心对象不创建平台适配器，只接收注入：

```js
const context = new EditorContext({
  host,
  eventBus,
  canvasManager,
  historyManager,
});
```

模块中通过 context 或构造参数使用：

```js
class ExportModule {
  constructor(canvasManager, historyManager, options = {}, host) {
    this.host = host;
  }

  async exportToFile() {
    const dataURL = this.exportToDataURL('png');
    return this.host.file.saveImage(dataURL, 'edited.png');
  }
}
```

UI 中也不直接访问平台全局对象：

```js
const user = await host.user.getCurrentUser();
const hostName = host.platform.name;
```

## 降级策略

每个能力都需要有明确降级：

```text
用户不可用: 返回 null，UI 显示未登录/本地模式
存储不可用: fallback 到 localStorage；仍不可用则内存存储
文件保存不可用: fallback 到浏览器下载
剪贴板图片不可用: 提示用户使用保存文件
系统字体不可用: 使用内置字体列表
窗口控制不可用: noop
生命周期不可用: noop
```

## 当前项目迁移步骤

### 第 1 步：统一接口文档

完成本文档，明确能力边界。

### 第 2 步：扩展 `core/src/interfaces/HostAdapter.js`

把现在扁平的接口升级为能力分组，或保持兼容并逐步新增：

```js
host.storage.get(key)
host.user.getCurrentUser()
host.file.saveImage(data, name)
```

### 第 3 步：改造 uTools adapter

把目前 `clients/utools/src/adapters/host/UtoolsHostAdapter.js` 中的零散方法整理成分组能力。

### 第 4 步：替换 UI 直接调用

当前 UI 中存在便捷函数导出：

```js
getHostName()
getHostUser()
openHostExternal()
```

后续应改为从 `App` 注入 `host`，或由一个 `HostContext` 提供。

### 第 5 步：构建输出分端

保持：

```text
dist/uTools/
dist/zTools/
dist/tauri/
```

不同构建脚本只负责复制对应 client，并修正 import 路径。

## 不建议做的事

- 不要在 `core/` 中出现 `utools`、`ztools`、`__TAURI__`
- 不要在模块内部直接读写 `localStorage`，统一走 `host.storage` 或 `StorageService`
- 不要把平台原始用户对象直接传遍核心，统一转成 `HostUser`
- 不要让每个模块自己判断平台，平台差异集中在 adapter

## 最小落地版本

第一版只需要实现这些：

```ts
host.platform
host.user.getCurrentUser()
host.storage.get/set/remove()
host.file.pickImage/readImageFile/saveImage()
host.clipboard.writeImage()
host.window.setHeight()
host.system.openExternal()
host.lifecycle.onEnter()
```

这已经能覆盖当前项目的用户、存储、导入、导出、剪贴板、窗口高度、插件进入事件。
