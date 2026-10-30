# 图片工具箱 · version.json 与版本化资源规范

> 文档状态：**已冻结（v1）** ｜ `schemaVersion`：`1` ｜ 冻结日期：2026-10-29
> 适用场景：Web 端版本化发布、CDN 强缓存、iframe 嵌入的版本选择
> 相关文档：[EMBED_PROTOCOL.md](EMBED_PROTOCOL.md)（嵌入通信协议）、[SDK_PLAN.md](SDK_PLAN.md)（整体方案）

---

## 0. 定位与当前状态

本文档定义图片工具箱 Web 版的**版本接口契约**：

- `version.json` 的 JSON 结构与校验规则；
- 版本化资源路径格式 `/v{version}/{filename}`；
- CDN 缓存头约定（版本接口 `no-cache`，资源 `immutable`）；
- 缓存版本可用性判定与降级顺序；
- 灰度发布的扩展点（第一版不实现，只冻结形状）。

### 0.1 冻结时的实现状态

仓库当前（2026-10-29）**没有** version.json，构建产物是平铺的：

```text
dist/web/
├── index.html   # 由 prepare-build.mjs 改写，引用 ./index.css 与 ./app.js
├── app.js       # esbuild bundle（含 fabric），ESM
├── index.css    # 压缩后的共享样式
└── logo.png
```

阶段 1（SDK Loader / Service Worker 卡）负责把构建产物按本文档输出为版本化目录并生成 `version.json`。本文档是验收依据，不是对现存构建的描述。

### 0.2 设计目标

| 目标 | 手段 |
|------|------|
| 缓存命中时资源 0 网络请求 | 资源 URL 带版本号 + `immutable` 强缓存；版本检查仍是一次 `no-cache` 条件请求（通常 304） |
| 版本切换安全 | 一个版本一个目录，已发布目录永不改写 |
| 可回滚 | `version.json` 重新指向旧版本即可，旧目录保留 |
| 多宿主共享缓存 | 同源 CDN + 同源 Service Worker 缓存 |
| 故障可降级 | 记住上次可用版本；版本接口故障不白屏 |
| 可灰度 | 服务端选版本（推荐）；`channels` / `rollout` 字段预留 |

### 0.3 非目标

- 不做增量更新、bundle 分片、按需加载的完整方案（第一版整包发布）。
- 不做客户端版本比较/自动回退（`version.json` 是唯一权威；回滚由发布方决定）。
- 不做签名/授权（公开静态资源，不含用户数据）。

---

## 1. 部署布局

**当前站点根就是 `dist/web/`**（`deploy-cf-pages.ps1` 直接 `wrangler pages deploy dist/web`），所以生产 URL 以 `/` 为根：

```text
https://image-toolbox.moruteaven.com/version.json
https://image-toolbox.moruteaven.com/v3.0.0/app.js
```

但 `scripts/build.mjs` 每次构建都会 `rmSync(dist/web)` 清空输出，`dist/web/` **不能**用来长期保留历史版本。因此阶段 1 必须引入**发布暂存区**（建议 `dist/release/`）：

> `{base}` 指部署根；当前 Cloudflare Pages 部署的站点根是 `/`。若将来部署在子路径，把下文的 `/v...`、`/version.json` 统一加该前缀。

```text
dist/web/                 # 构建输出（每次 build 清空，平铺文件）
└── index.html / app.js / index.css / logo.png

dist/release/             # 发布根（{base} = /），由打包步骤生成
├── index.html            # 当前版本副本（站点首页，no-cache）
├── app.js                # 当前版本副本（no-cache）
├── index.css             # 当前版本副本（no-cache）
├── logo.png
├── version.json          # 版本清单（no-cache，唯一可变入口）
├── v3.0.0/               # 不可变版本目录（iframe 用）
│   ├── index.html
│   ├── app.js
│   ├── index.css
│   └── logo.png
└── v2.9.3/               # 回滚保留的旧版本（从上次发布/对象存储合并）
    └── ...
```

规则：

1. **版本目录只写一次**：`/v{version}/` 下的文件发布后**禁止覆盖、禁止删除后重建**。任何修改都必须发新版本号。
2. `version.json` 是唯一的“当前版本指针”，通过原子替换更新（见 §5）。
3. 至少保留最近 **3 个**版本目录，用于回滚与已打开页面的资源命中；旧版本必须从持久位置（上次发布包/对象存储）合并进 `dist/release/`，不能指望 `dist/web/` 残留。
4. 资源可以另外放 CDN 域名；此时 `version.json` 必须可跨域读取，资源 URL 用绝对 URL（见 §3.2）。
5. 版本化目录与 `dist/web/` 一一对应：`index.html` 内的 `./app.js`、`./index.css` 是**相对引用**，直接拷进 `v{version}/` 即可工作，**不需要**改写构建产物。`logo.png` 同理。
6. 站点根 `/` 必须继续可用：`dist/release/` 根部保留一份当前版本的 `index.html` + `app.js` + `index.css` 副本（或等价的稳定入口页），它们用 `no-cache`；版本目录内的同名文件用 `immutable`。
7. Service Worker 脚本（如 `sw.js`）和 SDK Loader 脚本属于**引导资源**，不放进版本目录、不列入 `assets`；它们用 `no-cache` 单独更新（见 §4.2）。
8. `scripts/verify-web-root-load.mjs` 当前硬编码 `dist/web/index.html` 为入口；阶段 1 需要把站点根/入口参数化，或对 `dist/release/` 再跑一次同样的首屏请求复算。

---

## 2. 版本号规则

- 使用 SemVer：`主版本.次版本.修订号[-预发布标识]`，例如 `3.0.0`、`3.1.0-beta.1`、`3.0.0-dev.2`。
- **禁止** build metadata（`+` 后缀）：`+` 在 URL 路径中需要转义，且不参与版本唯一性语义。需要区分构建时用预发布标识。
- 版本字符串必须能安全放进 URL 路径：只允许 `[0-9A-Za-z.-]`。
- **版本号发布后永不复用**：即使某个版本目录被清理，也不能用同一个版本号发布不同内容。
- 项目约定（本地开发指南 AGENTS.md §7.4，该文件仅存在于本地工作区、不随 git 分发）：`-dev` 为未发布开发版；公开 CDN 只发布正式版或显式指定的预发布版；`plugin.json` / `package.json` / `APP_VERSION` 必须在发版时同步，但 `version.json.version` 只取构建时的 `APP_VERSION`。
- 客户端**不得**用 SemVer 比较“谁更新”来决定加载哪个版本；一律以服务端返回的 `version.json` 为准（这样回滚才安全）。

---

## 3. version.json 结构

### 3.1 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `schemaVersion` | integer | 是 | 清单结构版本，当前固定 `1` |
| `version` | string | 是 | 应用版本，必须与 `/v{version}/` 路径段一致 |
| `builtAt` | string | 是 | 构建时间，RFC 3339 UTC，形如 `2026-10-29T13:40:00Z`；仅用于排查，不参与任何缓存决策 |
| `assets` | object | 是 | 资源表，键为相对文件名，值见 §3.2；**必须**包含 `index.html`、`app.js`、`index.css` |
| `channels` | object | 否 | 预留：命名通道到清单 URL 的映射（§7） |
| `rollout` | object | 否 | 预留：灰度放量配置（§7） |

规则：

- 顶层**允许**出现未知字段（向前兼容），客户端必须忽略。
- 不允许出现 `assets` 之外的资源清单（例如 `modules`），第一版保持单层。
- 文件必须是 UTF-8、无 BOM；压缩后建议 < 4 KiB（越小，版本检查越快）。
- 不含任何密钥、签名、用户数据。
- 部署方可以额外暴露 `/api/version` 作为 `version.json` 的**别名**（同 body、同缓存头、同 CORS），用于兼容既有 SDK 文档；两处内容必须由同一份构建产物生成，禁止手工维护两份。

### 3.2 `assets` 条目

每个键是相对于 `/v{version}/` 的文件路径（可含子目录，为将来拆分 chunk 预留；v1 实际只有三个单层文件），值为：

| 字段 | 类型 | 必需 | 规则 |
|------|------|------|------|
| `url` | string | 是 | 资源地址：以 `/` 开头的根绝对路径，或以 `https://` 开头的绝对 URL；**不得**带查询串或 `#` 片段 |
| `hash` | string | 是 | `sha256-<64 位小写十六进制>`，对**文件原始字节**计算 |
| `size` | integer | 是 | 文件字节数（未压缩大小），必须与服务器实际字节数一致 |

`url` 的路径规则（与 §2 的路径格式一致）：

- 解析后必须落在 `{base}/v{version}/` 下，且 URL 相对该目录的部分等于 `assets` 的键。
- **根绝对路径（以 `/` 开头）以 `version.json` 自身 URL 的 origin 为解析基准**（SDK Loader 就是从这个 URL 取到清单的）——iframe 入口 URL 也按此拼装（EMBED_PROTOCOL.md §2.1）。
- 站点根部署时写 `/v3.0.0/app.js`；**子路径部署时必须带上子路径前缀**，如清单在 `https://cdn.example.com/img-toolbox/version.json`，则资源写 `/img-toolbox/v3.0.0/app.js`（裸写 `/v3.0.0/app.js` 会解析到站点根下、不满足本条）。
- 跨 CDN 域名时使用绝对 URL：`https://cdn.example.com/v3.0.0/app.js`（只接受 `https://`；本地调试用根绝对路径）。
- 键不得以 `/` 开头，不得包含 `.`、`..` 作为路径段；发布脚本必须拒绝（JSON Schema 只能挡住大部分）。
- 不使用带版本参数的查询串（`app.js?v=3.0.0`）：query 不是缓存身份的一部分，且会被部分中间层丢弃，无法保证 `immutable` 语义（见 §4）。
- asset 条目内的**未知字段，客户端必须忽略**（附录 A 的 `additionalProperties: false` 只约束 v1 发布产物的校验，不构成客户端拒绝未知字段的理由）。

**必需资源集**（v1 固定）：

```text
index.html   ← iframe 入口，宿主用它拼嵌入 URL
app.js       ← 页面 bundle（含 fabric）
index.css    ← 样式
```

允许额外资源（例如 `logo.png`、未来拆出的 chunk），但客户端不得要求 `assets` 里出现它不认识的键；额外的键只用于完整性校验与预缓存。

### 3.3 完整示例

```json
{
  "schemaVersion": 1,
  "version": "3.0.0",
  "builtAt": "2026-10-29T13:40:00Z",
  "assets": {
    "index.html": {
      "url": "/v3.0.0/index.html",
      "hash": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size": 5120
    },
    "app.js": {
      "url": "/v3.0.0/app.js",
      "hash": "sha256-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      "size": 1155072
    },
    "index.css": {
      "url": "/v3.0.0/index.css",
      "hash": "sha256-89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      "size": 40960
    }
  }
}
```

> 示例中的 hash 与 size 是演示值；真实值必须由发布脚本按文件计算，不得手写。

### 3.4 校验规则

发布方（构建/部署脚本）必须：

1. `version` 与构建产物的 `APP_VERSION` 一致，且与目标目录名一致；
2. `assets` 恰好覆盖 `{base}/v{version}/` 下参与**首屏加载**的全部文件（至少三个必需项）；非首屏文件（如 `logo.png`，`index.html` 未引用它）允许留在版本目录里但不列入 `assets`；
3. 逐文件计算 SHA-256 与 `size`，写入清单；
4. 校验清单能被 JSON Schema（附录 A）接受；
5. 校验 `index.html` 中的相对引用（`./app.js`、`./index.css`）在版本目录内都能解析到。

客户端（SDK Loader / SW）必须：

1. 拒绝 `version` 不是合法 SemVer、或与 URL 路径不一致的清单；
2. 拒绝缺少必需资源的清单；
3. 拒绝 `hash`/`size` 格式非法的条目；
4. `schemaVersion` 大于自身支持值时，**不更新缓存**，回退到上次可用版本（§6.3）。

---

## 4. 版本化 URL 与 CDN 缓存头

### 4.1 资源 URL 格式

```text
{base}/v{version}/{filename}
```

示例：

```text
https://cdn.example.com/v3.0.0/index.html
https://cdn.example.com/v3.0.0/app.js
https://cdn.example.com/v3.0.0/index.css
```

- `{version}` 原样使用 `version.json.version`，不加 `v` 以外的变形。
- 路径**区分大小写**；文件名与 `assets` 的键严格一致。
- 资源 URL **禁止**带查询串；嵌入参数只加在 iframe 入口 URL 上（`?embed=1&hostOrigin=...`），且缓存查找必须忽略这些参数（§6.4）。
- iframe 入口固定为 `assets["index.html"].url`，不另外约定 `/embed.html` 之类路径。

### 4.2 缓存头

| 路径 | `Cache-Control` | 其它响应头 | 说明 |
|------|-----------------|------------|------|
| `{base}/version.json` | `no-cache` | `Content-Type: application/json; charset=utf-8`、`ETag`（平台按内容生成）、`Access-Control-Allow-Origin: *`、`X-Content-Type-Options: nosniff` | 允许缓存但每次必须回源校验；ETag 命中返回 304 |
| 动态灰度接口（若使用） | `no-store` 或 `private, no-cache` | `Vary: User-Agent, Cookie` | 每个请求可能不同，禁止 CDN 共享缓存（§7） |
| `{base}/v{version}/**` | `public, max-age=31536000, immutable` | 正确的 `Content-Type`、`Access-Control-Allow-Origin: *`、`X-Content-Type-Options: nosniff` | 版本目录不可变，永久缓存 |
| `{base}/index.html`、`{base}/app.js`、`{base}/index.css`（站点根当前版本副本） | `no-cache` | 同 HTML / JS / CSS | **必须发布**（§1 规则 6：保持站点根 `/` 直接访问可用）；是否兼作 §6.3 ③ 的版本接口故障降级目标由实现决定 |
| `{base}/sw.js`（若有） | `no-cache` | `Service-Worker-Allowed: {base 路径}` | 引导脚本，必须能更新 |

MIME 必须正确（`nosniff` 下错误 MIME 会直接阻断）：

| 扩展名 | `Content-Type` |
|--------|----------------|
| `.html` | `text/html; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8`（ESM 也接受 `application/javascript`） |
| `.css` | `text/css; charset=utf-8` |
| `.json` | `application/json; charset=utf-8` |
| `.png` | `image/png` |
| `.svg` | `image/svg+xml` |

说明：

1. `version.json` 用 `no-cache`（而不是 `no-store`）：允许 CDN/浏览器存副本，但每次使用前必须回源确认（平台生成的 ETag 命中则 304）。真正需要“绝不缓存”的动态灰度接口才用 `no-store`。
2. 版本化资源一旦发布就不允许变化，因此可以放心 `immutable` + 一年 `max-age`。**不要**给 `version.json` 加 `immutable`。
3. 静态资源允许跨域 GET（`Access-Control-Allow-Origin: *`）：SDK Loader 在宿主 origin 上读取 `version.json`，编辑器在 iframe 内读取资源；公开静态内容加 `*` 没有额外泄露面。
4. 错误响应（404/5xx）**不得**带长缓存：至少 `Cache-Control: no-store`，避免 CDN 把一个 404 记一年。
5. 版本目录不需要预热/刷新 CDN；`version.json` 的缓存层级必须能被部署方刷新（Cloudflare Pages 的部署本身是原子的，`no-cache` 的 `version.json` 会在下次请求生效）。

### 4.3 为什么版本放路径而不是 query

百度地图、高德地图 JS SDK 常用 `?v=版本` 的稳定入口。本方案把版本放进**路径**，原因：

1. query 版本无法保证 CDN 把不同版本分成不同缓存对象（部分中间层/代理忽略 query）；
2. 版本化目录可以永久 `immutable`，query 方案通常仍要回源校验；
3. 目录形式天然支持“旧版本目录保留、原子切换指针、秒级回滚”，且同一页面上的旧 iframe 可继续使用旧版本；
4. 排查问题时 URL 自解释（`/v3.0.0/app.js`）。

---

## 5. 发布流程（原子发布 / 回滚）

### 5.1 发布步骤

```text
1. pnpm build                         # 产出 dist/web（index.html / app.js / index.css / logo.png）
2. 打包到 dist/release/               # 不要把版本目录写进 dist/web（每次构建会被清空）
   ├─ 拷贝 dist/web 当前产物 → dist/release/v{APP_VERSION}/
   └─ 同时把当前产物保留在 dist/release 根部（站点首页，no-cache）
3. 合并历史版本                       # 从上次发布包/对象存储取回 v{旧版本}/，保留最近 3 个
4. 计算 hash / size，生成 dist/release/version.json
5. 部署 dist/release（先资源、后清单；Pages 整站部署天然原子）
6. 校验线上资源 hash 与 version.json 一致
7. 若对象存储分开发布：先传 v{version}/，再原子替换 version.json
```

要求：

- **先资源、后清单**：任何时刻 `version.json` 指向的版本目录都必须是完整可用的。
- 用 Cloudflare Pages / 对象存储的部署原子性保证 `version.json` 与资源同一批次；若分开发布，必须遵守“先资源后清单”。
- **禁止**修改已发布版本目录中的任何文件；发现坏资源只能发新版本（补丁版本号）并重新指向。部署脚本发现线上已存在同名版本目录时必须**失败退出**，不能覆盖。
- **Cloudflare Pages 是整站替换**：新部署的 `dist/release` 必须包含要保留的历史 `v{version}/` 目录，否则旧目录会随部署消失、回滚失效；若做不到，改用对象存储按目录独立上传。
- 站点根 `/` 的 `index.html` / `app.js` / `index.css` 是**可变副本**，用 `no-cache`；版本目录内的同名文件用 `immutable`。
- `version.json` 更新后无需刷新版本化资源缓存；旧版本目录保留至少一个发布周期。

### 5.2 回滚

回滚 = 把 `version.json` 指回上一个可用版本（目录仍然存在）：

```text
回滚 3.0.1 → 3.0.0：
1. 确认 /v3.0.0/ 目录完整、hash 与旧清单一致
2. 原子替换 version.json 为 3.0.0 的清单
3. 不需要清理 CDN 缓存（资源是 immutable 的，指针在清单里）
```

已打开的 iframe 继续使用旧 URL，不受影响；新打开的实例使用回滚后的版本。

### 5.3 版本保留

- 至少保留 **3 个**历史版本目录：当前版本 + 最近两个，覆盖一次连续回滚。
- 旧版本必须从持久位置（上次发布包 / 对象存储）合并进 `dist/release/`；`dist/web/` 每次构建都会被清空，不能作为历史版本来源。
- 清理旧版本前确认：没有正在使用的 iframe（服务端无法精确感知，因此按“至少保留 3 个”保守处理）。
- 删除目录后**不得**复用同名版本号。

---

## 6. 缓存可用性判定与降级

### 6.1 两种缓存归属（都遵守同一份清单）

| 形态 | 资源/SW 所在 | 谁判定缓存可用 |
|------|--------------|----------------|
| A. 共享 CDN（推荐） | CDN origin；SW 由编辑器页面（iframe 内）注册 | iframe 内的 SW / 缓存层 |
| B. 宿主同源自托管 | 与宿主同源；SDK Loader 可注册 SW | SDK Loader |

原因：Service Worker 只能注册在**脚本与页面同源**的范围内。宿主页面跨域引入的 `sdk.js` **不能**替 CDN origin 注册 SW，因此：

- 形态 A 下，SDK Loader 只负责读取 `version.json`、拼 iframe URL；资源缓存与完整性校验由 iframe 内的 SW 负责；
- 形态 B 下，Loader 自己可以读取 Cache API 做完整校验。

两种形态的 `version.json` 契约、路径、缓存头完全相同。

注意：第一次访问某个版本时 SW 尚未控制页面（或缓存为空），这一轮必然走网络；缓存收益从第二次访问该版本开始。这是预期行为，不是缓存失效。

### 6.2 缓存版本“可用”的判定

一个缓存版本可用，当且仅当同时满足：

| # | 条件 | 判定方 |
|---|------|--------|
| 1 | 清单 `schemaVersion` ≤ 客户端支持的最大值 | Loader / SW |
| 2 | 必需资源 `index.html`、`app.js`、`index.css` 全部在缓存中 | 缓存层 |
| 3 | 缓存条目的 `version` 等于清单 `version` | 缓存层 |
| 4 | 每个缓存资源的 SHA-256 与清单一致（缓存写入时校验；HTTP 缓存无法读取时以 immutable 路径作为等价保证） | 缓存层 |
| 5 | iframe 加载后 `editor:ready.payload.protocol` 被 SDK 支持 | SDK Loader |
| 6 | iframe 在 10 秒内触发 `ready`（否则视为资源损坏/网络失败） | SDK Loader |

只要任一条件不满足，就**不得**把该版本标记为可复用；按 §6.3 降级。

若“清单版本号未变、但资源 hash 与缓存记录不一致”，说明违反了“版本目录不可变”契约（缓存损坏或发布方覆盖了旧目录）：必须清除该版本缓存、按未命中重新拉取一次；仍然不一致则报错并提示发布方回滚/重发新版本。**绝不**在同一版本号下混用两批资源。

> 允许在条件 4 上区分缓存类型：浏览器 HTTP 缓存（`immutable`）不暴露内容给 JS，无法重算 hash，此时信任“版本化路径 + CDN 不变性”；SW / Cache API 缓存必须在写入时校验 hash，读取时按已校验记录信任。

### 6.3 降级顺序

```text
① 请求 version.json（no-cache，3 秒超时）
   ├─ 成功 → 校验 §3.4；使用清单 version（即使与本地缓存相同，也以清单为准）
   └─ 失败 / 清单非法
        ↓
② 使用 localStorage 中的 lastKnown（上次成功加载的 `{ version, entryUrl, savedAt }`）
   ├─ 有 → 用 lastKnown.entryUrl 创建 iframe（entryUrl 为清单里的入口地址、不含 embed 参数，加载时再拼；不要现拼路径，避免路径规则变化后失效）
   └─ 无
        ↓
③ 可选：稳定兜底入口 {base}/index.html（no-cache）
   ├─ 有 → 直接 iframe 加载（跳过版本检查）
   └─ 无
        ↓
④ 报错给宿主（onError），提供重试按钮；不加载空白 iframe
```

补充：

- `lastKnown` 只存版本号、入口 URL 与时间（不存资源内容），建议保留 **7 天**；超过则视为过期，避免指向已被清理的目录。指向的目录已 404 时按 ③ / ④ 继续降级。
- 版本接口失败时**重试一次**（退避 500ms）后再降级；不要无限重试。
- iframe 加载失败（404/超时）时，不要反复自动重建；交给宿主 UI 提示。
- 灰度目标版本不可用时，回退到 stable 版本（§7.2 第 5 条）。

### 6.4 缓存键与嵌入参数

- 资源 URL 无查询串，缓存键就是完整路径。
- iframe 入口 URL 带 `?embed=1&hostOrigin=...&theme=...`，这些参数只影响页面运行参数，不影响资源内容。
- SW 对 `index.html` 的缓存查找必须 **忽略查询串**（`cache.match(request, { ignoreSearch: true })`），否则每个宿主的 `hostOrigin` 都会产生一份 HTML 缓存副本。
- 版本化目录之间不许混用资源：一个 iframe 只能从单一版本目录加载 `app.js`/`index.css`；发现混用视为缓存损坏，清除该版本缓存后重试一次。

---

## 7. 灰度发布扩展点（v1 不实现）

第一版**不需要**任何客户端灰度逻辑。这里冻结两种扩展方式，保证未来不破坏协议。

### 7.1 方式 A：服务端选版本（推荐）

`version.json` 由边缘函数/动态接口返回，按 Cookie、UA 或查询参数选择版本，返回的仍是 §3 的同一结构：

```text
GET /version.json
  → 200 {"schemaVersion":1,"version":"3.1.0","builtAt":"...","assets":{...}}
```

要求：

- 响应头：`Cache-Control: no-store`（或 `private, no-cache`）+ `Vary: User-Agent, Cookie`；禁止 CDN 共享缓存。
- 分桶在服务端完成，客户端看到的永远是“一个明确版本”，无需知道灰度规则。
- 同一个客户端应保持粘性（用 Cookie 记录 cohort），避免每次刷新在版本间抖动。
- 回滚只需改服务端规则，客户端零改动。

### 7.2 方式 B：清单内预留字段（客户端求值）

未来版本可以在清单里追加（v1 客户端必须忽略）：

```json
{
  "schemaVersion": 1,
  "version": "3.0.0",
  "builtAt": "2026-10-29T13:40:00Z",
  "assets": { "...": "..." },
  "channels": {
    "stable": "/version.json",
    "beta": "/beta/version.json"
  },
  "rollout": {
    "manifestUrl": "/v3.1.0-beta.1/version.json",
    "percent": 10,
    "uaInclude": ["MicroMessenger"],
    "uaExclude": ["HeadlessChrome"],
    "salt": "2026-10-29"
  }
}
```

字段语义（冻结形状，求值逻辑未来实现）：

> 下面的示例只展示扩展字段，`assets` 用省略写法；真实清单的 `assets` 仍必须满足 §3.2。
> 注意：`rollout.manifestUrl` 指向「版本目录自带清单」是一种**未来布局**（若启用该方式，版本目录将额外包含自己的 `version.json`）；v1 的版本目录里**不产生**清单文件，`version.json` 仍是唯一指针（§1）。

| 字段 | 说明 |
|------|------|
| `channels` | 通道名 → 该通道清单 URL；支持多通道并行（stable / beta） |
| `rollout.manifestUrl` | 灰度目标版本的清单地址（相对 `{base}` 或绝对 URL），必须是独立的完整清单（含自己的 assets） |
| `rollout.percent` | 放量百分比 0–100（整数） |
| `rollout.uaInclude` / `uaExclude` | UA 子串匹配（大小写不敏感）；`uaExclude` 优先于 `uaInclude` |
| `rollout.salt` | 分桶盐值；同一 salt 下分桶稳定 |

求值规则（未来版本）：

1. 先做 UA 过滤；命中 `uaExclude` → 用 stable。
2. 其余请求按 `sha256(clientId + salt) % 100 < percent` 分桶；`clientId` 为首次生成的随机 UUID（localStorage，不含用户身份）。
3. 命中 → 拉取 `rollout.manifestUrl`，按该清单的 version/assets 加载；未命中 → 用顶层版本。
4. 每个客户端记录已分配版本，保持粘性；不得每次加载重新掷骰子。
5. 灰度版本的缓存键必须包含版本号（天然满足），禁止与 stable 混用资源。
6. 灰度与回滚只通过服务端/清单控制，不依赖用户清理缓存。

### 7.3 约束

- `channels` / `rollout` 是**公开**信息，不得包含密钥或用户标识。
- UA 可伪造，灰度只能用于产品放量，不能作为安全边界。
- v1 客户端读到 `rollout` 必须**忽略并照常使用顶层 `version`**，不得报错。
- 灰度版本若不满足 §6.2 的兼容性（协议不匹配、资源缺失），回退 stable。

---

## 8. 与现有构建/部署的衔接（阶段 1 待办）

| # | 待办 | 落点建议 |
|---|------|----------|
| 1 | 保持 `dist/web/` 为构建输出；新增打包步骤生成 `dist/release/v{APP_VERSION}/` 与根部当前版本副本 | 新增脚本（在 `pnpm build` 之后运行）；**不要**把版本目录写进 `dist/web`（`build.mjs` 每次 `rmSync`） |
| 2 | 生成 `dist/release/version.json`（hash/size），合并保留的历史版本 | 新增脚本，纳入构建门禁；清单应可被附录 A Schema 校验 |
| 3 | 部署根从 `dist/web` 改为 `dist/release`；部署顺序资源 → 清单 | `deploy-cf-pages.ps1` |
| 4 | 首屏请求复算：当前脚本硬编码 `dist/web/index.html`，需参数化站点根/入口，或对 `dist/release` 另跑一次 | `scripts/verify-web-root-load.mjs` |
| 5 | `_headers` 配置：根部副本 `no-cache`，`/v{version}/**` `immutable` | `dist/release/_headers`（Cloudflare Pages） |
| 6 | 版本接口读取与降级 | 阶段 1 的 SDK Loader |
| 7 | SW 缓存与 hash 校验 | 阶段 1 的 Service Worker（若采用形态 A，注册点在 iframe 内） |

> `scripts/build.mjs` 的文档引用门禁（`verify-doc-refs.mjs`）会校验脚本存在性与文档提及；新增脚本时按 AGENTS.md §6.1（本地开发指南，不随 git 分发）同步更新文档。

---

## 9. 附录 A：JSON Schema（v1）

> 用于发布校验与测试。`format: date-time` 需要校验器开启 format 断言（如 ajv-formats）。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://image-toolbox.moruteaven.com/schemas/version.schema.json",
  "title": "Image Toolbox version manifest",
  "type": "object",
  "required": ["schemaVersion", "version", "builtAt", "assets"],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "version": {
      "type": "string",
      "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$"
    },
    "builtAt": {
      "type": "string",
      "format": "date-time"
    },
    "assets": {
      "type": "object",
      "required": ["index.html", "app.js", "index.css"],
      "propertyNames": {
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._/-]*$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/asset"
      }
    },
    "channels": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "rollout": {
      "$ref": "#/$defs/rollout"
    }
  },
  "additionalProperties": true,
  "$defs": {
    "asset": {
      "type": "object",
      "required": ["url", "hash", "size"],
      "properties": {
        "url": {
          "type": "string",
          "pattern": "^(https://|/)"
        },
        "hash": {
          "type": "string",
          "pattern": "^sha256-[a-f0-9]{64}$"
        },
        "size": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": false
    },
    "rollout": {
      "type": "object",
      "required": ["manifestUrl", "percent"],
      "properties": {
        "manifestUrl": {
          "type": "string"
        },
        "percent": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "uaInclude": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "uaExclude": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "salt": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

Schema 之外仍需人工/脚本校验的规则（JSON Schema 表达成本高）：

- `version` 与版本目录名一致；
- `url` 解析后落在 `{base}/v{version}/{key}`，且不含 `?`、`#`；
- `size` 与文件实际字节数一致；
- `hash` 与文件实际摘要一致；
- `index.html` 的相对引用在版本目录内可解析。

> 注意：`propertyNames` 的正则允许 `.`，因此 `..` 仍能通过 Schema。发布脚本必须额外拒绝包含 `..` 路径段、以 `/` 开头或以 `.` 开头的资源键。

---

## 10. 附录 B：发布校验清单

发布前逐项确认：

```text
[ ] pnpm build 通过，dist/web 产物齐全
[ ] dist/release/v{version}/ 内三个必需文件存在（根部另有当前版本副本）
[ ] version.json 通过附录 A Schema 校验
[ ] 每个 asset 的 sha256 与 size 与文件一致
[ ] 线上 /v{version}/app.js 响应 Cache-Control: public, max-age=31536000, immutable
[ ] 线上 /version.json 响应 Cache-Control: no-cache；ETag/304 可复现（由平台生成，不要求固定值）
[ ] 线上资源 Content-Type 正确（应用 nosniff）
[ ] iframe 入口带 embed=1&hostOrigin=... 可正常 ready
[ ] 回滚演练：把 version.json 指向上一版本，页面能加载旧版本
[ ] 旧版本目录仍保留（至少 3 个）
```

快速检查（curl）：

```bash
curl -sI "https://cdn.example.com/version.json" | grep -i cache-control
curl -sI "https://cdn.example.com/v3.0.0/app.js" | grep -i -E 'cache-control|content-type'
curl -s "https://cdn.example.com/version.json" | sha256sum   # 与发布记录比对
```

---

## 11. Review 记录

| 日期 | 方式 | 结论 | 处理 |
|------|------|------|------|
| 2026-10-30 | 独立评审：对照 `scripts/build.mjs` 的 Web 产物、`deploy-cf-pages.ps1` 的部署方式、[EMBED_PROTOCOL.md](EMBED_PROTOCOL.md)，并按 DoD 五项检查 | 通过。JSON 结构 / JSON Schema / 缓存头 / 版本路径 / 可用性判定 / 灰度扩展齐全 | 已回填本文档 |
| 2026-10-30 | 主会话复核：走查发布/回滚全流程，核对 §5.1 / §8 / 附录 B 与 §1 的一致性 | 复核发现发布根目录跨章节不一致，已统一为 `dist/release/` | 已回填本文档 |

评审中确认并修正的点：

- 修正“缓存命中 0 网络请求”的口径：资源 0 请求，但 `version.json` 每次仍有 1 次 `no-cache` 条件请求（通常 304）。
- 补充 Cloudflare Pages 整站替换会删除未包含在部署包里的旧版本目录，回滚能力依赖部署包保留历史版本（或改用对象存储）。
- 补充部署脚本必须拒绝覆盖已存在的同名版本目录，强化“版本目录不可变”契约。
- 明确 Service Worker 的注册边界：跨域 `sdk.js` 不能替 CDN origin 注册 SW；缓存归属按 §6.1 的两种形态处理。
- 补充首次访问某版本必然走网络、缓存收益从第二次开始，避免把正常首访误判为缓存失效。
- 修正 `sw.js` 的 `Service-Worker-Allowed` 示例写死 `/` 的问题，改为 `{base 路径}`。
- 给灰度示例加注“assets 省略”，避免被误当成可直接发布的合法清单。
- 复核修正：统一发布根为 `dist/release/`——§5.1 发布步骤、§8 衔接表与附录 B 检查清单原残留 `dist/web` 口径，照旧实现会让下一次构建 `rmSync(dist/web)` 清掉 `version.json` 与版本目录；已全部统一，并显式补「从持久位置合并历史 `v*/` 目录」步骤。
- 复核修正：§4.2 站点根副本口径与 §1 规则 6 对齐（副本必发布，保持站点根 `/` 直接访问可用；是否兼作 §6.3 ③ 的降级目标由实现决定），`ETag` 措辞改为不承诺具体值。
