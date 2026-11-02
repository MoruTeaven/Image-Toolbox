# 用户协议确认记录（Agreement Tracking）功能策划

> 文档状态：**策划稿** ｜ 日期：2026-11-02
> 关联：《统一用户服务协议》2026.11.02 版（[USER_AGREEMENT.md](USER_AGREEMENT.md)）、后端卡 `t-mvyyuw93-phadnn`
> 一句话：在业务后端持久化「谁、何时、对哪个版本、通过哪个端」同意了协议，客户端在登录与协议更新时强制确认闭环。

---

## 一、目标与非目标

### 目标

1. **合规举证**：服务端可查任意用户的协议确认记录（版本、时间、端、协议内容哈希），作为「用户已同意」的证明；
2. **更新闭环**：协议发布新版本后，客户端比对版本差异，强制用户重新确认后才能继续使用在线服务；
3. **轻量可演进**：第一版最小实现，数据模型预留 `agreement_type` 维度，为将来《隐私政策》等其它协议文档复用。

### 非目标

- 不做协议管理后台（版本登记第一阶段靠迁移脚本/SQL 写入）；
- 不做电子签名、不做逐条条款同意；
- 不把协议全文入库（服务端只存版本号 + SHA-256 哈希，原文以 git 仓库为准）。

## 二、架构决策：记录落在图片工具箱业务后端

| 方案 | 结论 |
| --- | --- |
| A. 落 Teaven Identity（identity.moruteaven.com） | 否（第一版）——Identity 是全公司基础服务，当前仅图片工具箱一个产品需要；动它要升级 SDK（0.3.4 → 新版本）并过生产变更 |
| B. 落图片工具箱业务后端（api.image-toolbox.moruteaven.com） | ✅ 采用——迭代快；`IdentityClient` 已有业务后端 fetch 桥接先例（`uploadAvatar` 的 401 刷新重试模式）；协议文本与产品发布节奏一致 |

**演进路径**：若将来统一协议下沉 Identity 多产品共用，`agreement_acceptances` 表结构可直接平迁（`agreement_type`/`agreement_version`/`content_hash` 三元组与产品无关），客户端只需切换 baseUrl。

**账号 ID 归属**：`user_id` 直接采用 Identity 的用户 ID（JWT `sub`）。服务端**必须从 token 解出 user_id，忽略请求体里的任何 userId 字段**——防伪造归属。

## 三、数据模型（业务后端 PostgreSQL）

```sql
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT        NOT NULL,              -- Identity 用户 ID（JWT sub）
  agreement_type    TEXT        NOT NULL,              -- 'unified_user_agreement'
  agreement_version TEXT        NOT NULL,              -- '2026.11.02'（日期制）
  content_hash      CHAR(64)    NOT NULL,              -- 协议原文 SHA-256（hex 小写）
  first_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),-- 首次确认（举证锚点，永不更新）
  last_accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),-- 最近确认（重确认/多端覆盖）
  accept_count      INTEGER     NOT NULL DEFAULT 1,    -- 确认次数（含重确认）
  platform          TEXT        NOT NULL,              -- 'utools' | 'ztools' | 'web'
  client_version    TEXT,                              -- '3.0.0-dev'（可空，防御性）
  ip                INET,                              -- 可空；披露于隐私政策
  user_agent        TEXT,                              -- 可空
  CONSTRAINT uq_agreement_acceptance UNIQUE (user_id, agreement_type, agreement_version)
);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_user
  ON agreement_acceptances (user_id, agreement_type, last_accepted_at DESC);
```

协议版本登记表（服务端「最新版本」的真相源）：

```sql
CREATE TABLE IF NOT EXISTS agreement_versions (
  agreement_type    TEXT        NOT NULL,
  agreement_version TEXT        NOT NULL,
  content_hash      CHAR(64)    NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  active            BOOLEAN     NOT NULL DEFAULT true, -- 同类型仅一行 active=true
  CONSTRAINT uq_agreement_version UNIQUE (agreement_type, agreement_version)
);
-- 发新协议 = INSERT 一行新版本 + UPDATE 旧行 active=false（迁移脚本内事务完成）
```

写入语义（幂等 upsert）：

```sql
INSERT INTO agreement_acceptances (user_id, agreement_type, agreement_version, content_hash, platform, client_version, ip, user_agent)
VALUES (...)
ON CONFLICT (user_id, agreement_type, agreement_version) DO UPDATE SET
  last_accepted_at = now(),
  accept_count     = agreement_acceptances.accept_count + 1,
  content_hash     = EXCLUDED.content_hash,
  platform         = EXCLUDED.platform,
  client_version   = EXCLUDED.client_version,
  ip               = EXCLUDED.ip,
  user_agent       = EXCLUDED.user_agent;
-- first_accepted_at 冲突时保持原值（UPDATE 列表里不写它）
```

## 四、协议版本真相源与哈希口径

1. **真相源是服务端**，不是客户端内置文本：客户端内置协议文本只是离线兜底。这样协议更新不依赖插件发版。
2. **哈希口径**：对协议 Markdown **原文**（仓库 `USER_AGREEMENT.md` 的 UTF-8 字节）计算 SHA-256，hex 小写。发布协议新版本时：
   - 计算哈希 → 写入 `agreement_versions`（与 git tag 建立对应关系，真到争议时按 tag 取原文复算比对）；
   - 客户端上报的 `contentHash` 与登记不一致 → 返回 409（见下），防「版本号没变但内容被换」的争议。
3. 协议生效日期即版本号日期（`2026.11.02 版`），与 `published_at` 互为印证。

## 五、API 设计（业务后端，响应风格 `{ code: 'OK', data }`）

统一鉴权：`Authorization: Bearer <accessToken>`（401 时客户端按 `uploadAvatar` 同款「刷新后重试一次」模式处理）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agreements/latest?type=unified_user_agreement` | 返回当前生效版本：`{ agreementType, agreementVersion, contentHash, publishedAt, viewUrl }`。`viewUrl` 为在线阅读地址（可空），客户端版本落后时引导在线查看 |
| GET | `/api/me/agreements?type=unified_user_agreement` | 当前用户已确认记录：`{ agreementType, acceptedVersion, firstAcceptedAt, lastAcceptedAt, acceptCount }`；无记录时 `acceptedVersion` 为 `null` |
| POST | `/api/me/agreements/acceptances` | 上报确认。Body：`{ agreementType, agreementVersion, contentHash, platform, clientVersion }`。服务端从 token 取 `user_id`、从请求取 IP/UA，校验 `contentHash` 与登记一致后 upsert。成功返回 `{ accepted: true, firstAcceptedAt, lastAcceptedAt, acceptCount }` |

错误码约定：

| code | HTTP | 场景 | 客户端动作 |
| --- | --- | --- | --- |
| `OK` | 200 | 成功 | 继续 |
| `UNAUTHORIZED` | 401 | token 失效 | 刷新重试一次，仍失败转登录 |
| `AGREEMENT_VERSION_MISMATCH` | 409 | 上报 hash 与登记不一致 | 重新 GET latest → 重新渲染 → 让用户对正确版本确认 |
| `RATE_LIMITED` | 429 | 上报过于频繁 | 静默退避，下个启动周期重试 |

## 六、客户端设计（图片工具箱客户端）

### 6.1 模块落点

- **`core/src/identity/IdentityClient.js`** 新增三个方法（全部走业务后端桥接，复用 `uploadAvatar` 的 401 刷新模式）：
  - `fetchLatestAgreement(type)` → GET latest
  - `getMyAgreement(type)` → GET me/agreements
  - `acceptAgreement({ type, version, contentHash })` → POST acceptances
- **协议文本内联**：将 `USER_AGREEMENT.md` 在构建期生成/打包进 bundle（对齐 `core/src/ai/assetSource.js` 的内联资产思路；具体用 esbuild loader 还是构建生成 JS 模块，实施时评估），保证 uTools/ZTools 离线可读。内容哈希以该内联文本计算。
- **确认状态判定**：新模块 `core/src/identity/AgreementGate.js`（纯逻辑，便于测试）：输入 `{ latest, mine, builtin }`，输出 `ok | need-accept(原因: never/outdated) | offline-fallback`。
- **UI 落点**：`EditorShell` 层的模态对话框（登录成功后、进入编辑器前拦截）：协议标题 + 版本号 + 可滚动全文（内联文本；`viewUrl` 提供在线查看入口）+「我已阅读并同意」勾选（未勾选确认按钮禁用）+「不同意则退出登录」。
- **本地缓存**：`localStorage` 记 `agreement_accepted_{type}` = 版本号。**仅作降级判定与减少请求，不作为举证依据**（服务端为准）。

### 6.2 判定流程

```text
启动/登录成功
  → GET latest + GET mine（可并行；失败走离线降级）
  → Gate 判定：
      mine.acceptedVersion === latest.version        → 放行
      mine.acceptedVersion === null                  → 弹窗（首次确认）
      mine.acceptedVersion < latest.version          → 弹窗（协议更新，标注变更提示）
  → 用户勾选并确认
  → POST acceptances { version, hash(内置文本), platform, clientVersion }
      → 200：写本地缓存，放行
      → 409：重拉 latest + 更新展示文本，重新弹窗
      → 网络失败：保留弹窗可重试；提供「暂不，仅使用本地功能」降级入口
  → 用户拒绝同意 → 退出登录（协议 1.3 条：不同意则不使用）
```

**降级细则**：latest/mine 接口都不可用时，用「内置版本 == 本地缓存版本」判断：一致则放行（服务端记录大概率已存在，启动后异步补偿上报一次，幂等安全）；不一致弹窗但允许「暂不」，仅限制需要在线的服务（官方 AI 编辑等），本地编辑功能不受影响——核心编辑免费离线是产品承诺（协议 4.3/4.4），弹窗不能把它挡死。

### 6.3 字段来源

| 字段 | 来源 |
| --- | --- |
| `platform` | `HostAdapter.platform.id`（`utools` / `ztools` / `web`） |
| `clientVersion` | `HostAdapter.platform.appVersion` |
| `contentHash` | 构建期内联协议文本的 SHA-256（构建期算好注入，运行时不做文本处理） |
| `ip` / `user_agent` | 服务端从请求取，客户端不传 |

## 七、边界情况

| 场景 | 处理 |
| --- | --- |
| 老用户（协议生效前已注册） | `mine` 为空 → 下次登录/启动弹一次首次确认，正常覆盖，无需迁移脚本 |
| 多端同一用户 | 一条记录（唯一约束），`first` 记首次端与时间，`last`/`platform`/`accept_count` 跟随最近确认 |
| 协议更新当天多次修订 | 版本号加序号（如 `2026.11.02-r2`），每次都是新行新弹窗 |
| 用户注销 | 确认记录随账号数据一并删除/匿名化（协议 3.5 条），由注销流程统一处理 |
| 客户端时钟漂移 | 不信任客户端时间，全部以服务端 `accepted_at` 为准；客户端不传时间 |
| 离线 | 见 6.2 降级细则：本地功能不被协议弹窗永久挡死 |

## 八、安全与合规

1. **归属不可伪造**：`user_id` 只从 access token 解出，请求体中的 userId 一律忽略；
2. **IP/UA 属个人信息**：在《隐私政策》中披露处理目的（服务合规与争议举证）与保留期限（建议与账号生命周期一致，注销即删）；不确认则第一版可先置空，字段留着；
3. **哈希可复算**：每个协议版本发布时打 git tag（或记录 commit），登记表 `content_hash` 与 tag 内容一一对应，争议时按 tag 复算；
4. **防刷**：accept 接口加轻量限流（复用后端现有中间件）；GET 类接口不缓存用户数据到共享缓存（`Cache-Control: private`）。

## 九、验收标准

**后端**（卡 `t-mvyyuw93-phadnn`）：

1. 迁移脚本可重复执行（幂等建表）；
2. 同 user+type+version 重复 POST：`accept_count` 递增、`first_accepted_at` 不变、`last_accepted_at` 更新；
3. `contentHash` 与登记不一致 → 409 `AGREEMENT_VERSION_MISMATCH`；
4. 未带/携带无效 token → 401；body 伪造 userId 不影响归属；
5. GET latest 返回 active 版本；旧版本置 inactive 后返回新版本。

**客户端**：

6. 未同意用户登录后弹窗，确认后服务端出现记录（真机 uTools + Web 各验一次，platform 字段正确）；
7. mock latest 版本升级 → 触发重确认弹窗；409 场景能自愈（重拉 + 重新渲染）；
8. 离线场景：本地编辑可用，不出现弹窗死锁；恢复联网后补偿上报成功；
9. 全部构建门禁通过（含安全加固与 verify-doc-refs：本策划提及的脚本必须与实际一致）。

## 十、实施拆分

| 任务 | 项目 | 卡 |
| --- | --- | --- |
| 后端：表迁移 + 3 个接口 + 版本登记（2026.11.02 + 哈希） | 图片工具箱后端 | `t-mvyyuw93-phadnn`（已有） |
| 客户端：IdentityClient 三方法 + AgreementGate + 协议弹窗 + 内联文本与哈希 | 图片工具箱客户端 | 实施前创建（依赖后端接口就绪） |
| 《隐私政策》文本与披露（含确认记录、IP、Token 等全部服务端处理） | 图片工具箱 | 待协议弹窗上线前完成 |

## 十一、开放问题

1. `viewUrl` 的在线阅读地址形态（Cloudflare Pages 路径 or 仓库 GitHub 链接）——发布 README License 章节时一并定；
2. 每日赠送积分数额（协议第九章写「以产品内公示为准」，定了同步）；
3. 协议弹窗的视觉方案（复用现有 modal 风格，是否需要「变更摘要」区块）——UI 实施时定。
