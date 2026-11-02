# 用户协议确认记录（Agreement Tracking）功能策划

> 文档状态：**策划稿 v2** ｜ 日期：2026-11-02
> 关联：《统一账号服务协议》2026.11.02 版（[UNIFIED_ACCOUNT_AGREEMENT.md](UNIFIED_ACCOUNT_AGREEMENT.md)）、《图片工具箱用户服务协议》2026.11.02 版（[USER_AGREEMENT.md](USER_AGREEMENT.md)）
> 关联卡：图箱后端 `t-mvyyuw93-phadnn` ｜ 客户端 `t-mvyz3n0z-49q0rr` ｜ Teaven Identity（待建）
> 一句话：两份协议、两个记录方——图箱协议由图箱后端记录，统一账号协议由 Identity 记录；用户一次授权，客户端并发两个确认请求，各自携带对应版本号。

---

## 一、协议体系与记录方分工

| 协议 | agreement_type | 文本形态 | 真相源（版本+哈希） | 确认记录存储 |
| --- | --- | --- | --- | --- |
| 《统一账号服务协议》 | `unified_account_agreement` | **在线协议**：从 Identity 在线获取，同意后缓存本地 | Teaven Identity | **Teaven Identity**（identity.moruteaven.com） |
| 《图片工具箱用户服务协议》 | `image_toolbox_agreement` | **内置协议**：随产品构建期打包，离线可读 | 图箱后端 | **图箱后端**（api.image-toolbox.moruteaven.com） |

设计理由：

1. **各记各的**：统一协议约束账号体系（将来其它产品接入 Identity 也用它），确认记录归 Identity，产品侧不重复持有；图箱协议约束产品服务，归图箱后端。两份协议独立生效、独立追版本（协议 1.2 条已声明互不替代）。
2. **统一协议在线化**：跨产品的协议不应与某个产品的发版节奏绑定，由 Identity 在线下发（版本号 + 文本/哈希），用户同意后客户端缓存一份到本地（展示与降级用，**缓存不作为举证依据**）。
3. **图箱协议内置化**：与产品同源发布（同仓库、同 git tag），构建期内联保证 uTools/ZTools 离线可读，哈希构建期预计算。

## 二、目标与非目标

### 目标

1. **合规举证**：任一服务端可查「谁、何时、对哪个版本、通过哪个端」确认了对应协议；
2. **双协议一次性授权**：注册/登录图箱时，一个弹窗内完成两份协议的勾选与确认，客户端并发两个上报请求；
3. **更新闭环**：任一协议发布新版本后，客户端比对版本差异，仅重新确认未同意/过期的那份；
4. **轻量可演进**：数据模型预留 `agreement_type`，为将来《隐私政策》等复用。

### 非目标

- 不做协议管理后台（版本登记第一阶段靠迁移脚本/SQL）；
- 不做电子签名、不做逐条条款同意；
- 不把协议全文入库（服务端只存版本号 + SHA-256 哈希；**统一协议文本由 Identity 在线下发，可存文本；图箱协议以 git 仓库为原文依据，服务端只存哈希**）。

## 三、数据模型

### 3.1 图箱后端（PostgreSQL）

```sql
CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT        NOT NULL,              -- Identity 用户 ID（JWT sub）
  agreement_type    TEXT        NOT NULL,              -- 本服务固定 'image_toolbox_agreement'
  agreement_version TEXT        NOT NULL,              -- '2026.11.02'（日期制）
  content_hash      CHAR(64)    NOT NULL,              -- 协议原文 SHA-256（hex 小写）
  first_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),-- 首次确认（举证锚点，永不更新）
  last_accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  accept_count      INTEGER     NOT NULL DEFAULT 1,
  platform          TEXT        NOT NULL,              -- 'utools' | 'ztools' | 'web'
  client_version    TEXT,
  ip                INET,                              -- 可空；披露于隐私政策
  user_agent        TEXT,
  CONSTRAINT uq_agreement_acceptance UNIQUE (user_id, agreement_type, agreement_version)
);
CREATE INDEX IF NOT EXISTS idx_agreement_acceptances_user
  ON agreement_acceptances (user_id, agreement_type, last_accepted_at DESC);

CREATE TABLE IF NOT EXISTS agreement_versions (   -- 版本登记（图箱协议真相源）
  agreement_type    TEXT        NOT NULL,              -- 'image_toolbox_agreement'
  agreement_version TEXT        NOT NULL,
  content_hash      CHAR(64)    NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  active            BOOLEAN     NOT NULL DEFAULT true,
  CONSTRAINT uq_agreement_version UNIQUE (agreement_type, agreement_version)
);
```

写入语义（幂等 upsert，冲突时 `first_accepted_at` 不在 UPDATE 列表即保持原值）：

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
```

### 3.2 Teaven Identity 侧（由 Identity 仓库实施，另卡跟踪）

建议采用与 3.1 相同的表结构（`agreement_type` 固定 `unified_account_agreement`），差异点：

- Identity 已有审计基建（`getClientIp` 可信代理解析、audit 表），accept 记录的 IP/UA 取值应复用同一套逻辑，保证与登录审计口径一致；
- 统一协议文本由 Identity 保管：版本登记除 `content_hash` 外需可关联**协议全文**（在线下发用）。形态由 Identity 仓库定（版本表加 `content` 列，或约定从配置/仓库读取），本策划不锁定；
- 数据生命周期：账号注销时随账号数据一并删除/匿名化（Identity 现有注销流程扩展点）。

## 四、版本真相源与哈希口径

1. **图箱协议**：真相源是图箱后端 `agreement_versions` 表；客户端内置文本与构建期哈希（SHA-256，对仓库 `USER_AGREEMENT.md` 检出原文计算，**注意 CRLF 行尾陷阱：必须对检出原文算并复算验证**）。服务端下发 `contentHash`，客户端上报不一致 → 409 自愈。
2. **统一协议**：真相源是 Identity；文本在线获取（latest 接口直接返回协议全文或文本 URL + 版本号 + 哈希）。客户端校验「拉取文本的 SHA-256 === 接口声明哈希」后展示；**用户同意后缓存到本地**（缓存键含版本号，如 `unified_agreement_text_2026.11.02`），缓存用于二次展示与离线判定，举证以 Identity 服务端记录为准。
3. 两份协议各自独立追版本，互不阻塞：统一协议出 v2 而图箱协议未变时，只需重新确认统一协议那份。

## 五、API 设计

### 5.1 图箱后端（响应风格 `{ code: 'OK', data }`，Bearer 鉴权）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agreements/latest?type=image_toolbox_agreement` | `{ agreementType, agreementVersion, contentHash, publishedAt, viewUrl }` |
| GET | `/api/me/agreements?type=image_toolbox_agreement` | `{ agreementType, acceptedVersion, firstAcceptedAt, lastAcceptedAt, acceptCount }`；无记录时 `acceptedVersion: null` |
| POST | `/api/me/agreements/acceptances` | Body：`{ agreementType, agreementVersion, contentHash, platform, clientVersion }`；服务端从 token 取 user_id、从请求取 IP/UA；hash 校验失败 → 409 `AGREEMENT_VERSION_MISMATCH` |

错误码：`OK`(200) / `UNAUTHORIZED`(401) / `AGREEMENT_VERSION_MISMATCH`(409) / `RATE_LIMITED`(429)。

### 5.2 Teaven Identity 侧（由 Identity 仓库定最终路径，风格沿用 Identity `{ code, data }` + `X-Auth-Token`/Bearer）

| 方法 | 路径（建议） | 说明 |
| --- | --- | --- |
| GET | `/agreements/latest?type=unified_account_agreement` | 返回当前生效版本 + 协议全文（或文本 URL）+ 哈希 |
| GET | `/agreements/me?type=unified_account_agreement` | 当前用户对该协议的确认状态 |
| POST | `/agreements/acceptances` | Body：`{ agreementType, agreementVersion, contentHash, platform, clientVersion }`；user_id 从 token 解出；IP/UA 复用审计口径 |

> 客户端调用 Identity 走 `fetch`（沿用 `X-Auth-Token`/Bearer + 401 刷新模式）；若 SDK（0.3.4）后续版本内置 agreement 方法，可平滑切换，客户端封装层不变。

## 六、客户端设计（图片工具箱客户端）

### 6.1 模块落点

- **`core/src/identity/IdentityClient.js`** 新增方法（图箱后端桥接，401 刷新模式同 `uploadAvatar`）：
  - `fetchLatestAgreement(type)` / `getMyAgreement(type)` / `acceptAgreement({ type, version, contentHash })`
- **统一协议在线获取与缓存**：新增 `core/src/identity/UnifiedAgreementClient.js`——调 Identity latest 接口拉取文本与哈希，**校验哈希后展示，同意后写本地缓存**（`unified_agreement_text_{version}`）；离线时读缓存。
- **图箱协议内联**：`USER_AGREEMENT.md` 构建期打包进 bundle（对齐 `core/src/ai/assetSource.js` 内联思路；loader 或构建生成模块，实施时评估），并注入预计算哈希。
- **判定**：`core/src/identity/AgreementGate.js`（纯逻辑）——输入两份协议各自的 `{ latest, mine, local(内置文本或缓存) }`，输出每份 `ok | need-accept(never|outdated) | offline-fallback`；**两份都 ok 才放行**。
- **UI**：`EditorShell` 模态框——标题「用户协议授权」；两个可折叠区块（统一账号协议[在线文本] / 图片工具箱协议[内置文本]），**各带独立勾选框**；两个都勾选后「同意并继续」可用；按钮文案注明「将同时向统一账号服务与图片工具箱服务确认协议」。提供「不同意」→ 退出登录。
- **本地缓存**：`agreement_accepted_{type}`（已同意版本，降级判定用）+ `unified_agreement_text_{version}`（统一协议文本缓存）。

### 6.2 判定与上报流程

```text
启动/登录成功
  → 并行拉取：图箱 latest+mine ｜ 统一协议 latest（文本+哈希+mine）
  → Gate 对两份协议分别判定
  → 任一份 need-accept → 授权弹窗（仅展示需要确认的份；另一份显示「已同意」状态）
  → 用户分别勾选两份 → 点击「同意并继续」
  → 并发两个 POST（各带对应 type+version+hash）：
      图箱后端 acceptances  ｜ Identity acceptances
  → 两份都成功 → 写本地缓存 → 放行
  → 任一 409 → 仅重拉该份 latest/文本 → 更新展示 → 重新勾选该份
  → 网络失败 → 弹窗内可重试；提供「暂不，仅使用本地功能」降级入口
  → 拒绝同意 → 退出登录
```

**降级细则**：

- 图箱协议：内置文本 + 本地缓存版本可离线判定；联网后幂等补偿上报（安全）；
- 统一协议：有缓存文本 → 按缓存版本判定与展示；无缓存且网络不可用 → 该份无法完成确认，走「暂不」降级（仅本地功能可用），恢复联网后弹窗补确认；
- 「暂不」状态对在线服务（官方 AI 编辑、积分）一律拦截，本地编辑不受影响（核心编辑免费离线，协议 3.3/3.4 条）。

### 6.3 字段来源

| 字段 | 来源 |
| --- | --- |
| `platform` | `HostAdapter.platform.id` |
| `clientVersion` | `HostAdapter.platform.appVersion` |
| 图箱协议 `contentHash` | 构建期预计算注入 |
| 统一协议 `contentHash` | Identity latest 接口下发（客户端可复算校验） |
| `ip` / `user_agent` | 两个服务端各自从请求取，客户端不传 |

## 七、边界情况

| 场景 | 处理 |
| --- | --- |
| 老用户（两协议生效前已注册） | 两份 `mine` 均为空 → 下次登录/启动弹一次弹窗，两份一并确认 |
| 只缺一份（如统一协议出了新版） | 弹窗只展示需要确认的份，另一份显示已同意状态；确认后只发对应那一个请求 |
| 同一天多次修订 | 版本号加序号（如 `2026.11.02-r2`），各服务独立登记 |
| 统一协议在线拉取失败 | 有缓存 → 用缓存版本判定/展示；无缓存 → 「暂不」降级，仅本地功能 |
| 用户注销统一账号 | Identity 删除统一协议确认记录；图箱后端确认记录随图箱内账号数据按统一账号注销联动处理（图箱注销流程与 Identity 对齐，实施时对齐清理链路） |
| 客户端时钟漂移 | 一律以服务端时间为准，客户端不传时间 |

## 八、安全与合规

1. **归属不可伪造**：两个服务端的 `user_id` 都只从 token 解出，请求体 userId 一律忽略；
2. **IP/UA 属个人信息**：两个服务分别处理，需在《隐私政策》统一披露（处理目的：服务合规与争议举证；保留期限：建议与账号生命周期一致，注销即删）；不确认则第一版先置空；
3. **哈希可复算**：图箱协议每版本打 git tag 并登记哈希；统一协议由 Identity 保管原文与哈希对应关系；
4. **防刷**：两个 accept 接口均加轻量限流；GET 类接口 `Cache-Control: private`；
5. **请求时序无耦合**：两个上报互不依赖，任一失败单独重试，不存在部分成功回滚问题（协议确认是幂等追加，不是事务）。

## 九、验收标准

**图箱后端**（卡 `t-mvyyuw93-phadnn`）：

1. 迁移幂等；2. 重复 POST：count 递增、first 不变、last 更新；3. hash 不符 → 409；4. 未登录 401、伪造 userId 无效；5. latest 返回 active 版本。

**Teaven Identity**（另卡）：

6. 三个建议接口可用（路径可调），响应风格与 Identity 现有一致；
7. 统一协议文本与哈希一致性：latest 下发文本复算 SHA-256 === 声明哈希；
8. IP/UA 取值与登录审计口径一致。

**客户端**（卡 `t-mvyz3n0z-49q0rr`）：

9. 未同意用户登录后弹窗，两份分别勾选；确认后**两个服务端各出现一条记录**（真机 uTools + Web 各验一次，platform 字段正确）；
10. 仅一份过期 → 弹窗只展示该份，确认后仅发出对应请求；
11. 统一协议缓存：同意后断网重启，弹窗可离线展示缓存文本；409 场景自愈；
12. 离线降级不出现弹窗死锁，本地编辑可用；恢复联网补偿上报成功；
13. 全部构建门禁通过（含 verify-doc-refs 与安全加固）。

## 十、实施拆分

| 任务 | 项目 | 卡 |
| --- | --- | --- |
| 图箱后端：两张表 + 3 接口 + 图箱协议版本登记（2026.11.02 + 哈希） | 图片工具箱后端 | `t-mvyyuw93-phadnn` |
| Teaven Identity：统一协议版本存储 + 3 接口 + IP/UA 审计口径对齐 | Teaven Identity | 实施前创建（本策划 §3.2/§5.2 为规范） |
| 客户端：双协议 Gate + 授权弹窗（双勾选双上报）+ 统一协议在线获取与缓存 + 图箱协议内联与哈希 | 图片工具箱客户端 | `t-mvyz3n0z-49q0rr` |
| 《隐私政策》文本与披露（两服务的确认记录、IP、Token 等） | 图片工具箱 | 弹窗上线前完成 |

## 十一、开放问题

1. 统一协议文本在 Identity 侧的存储形态（版本表 content 列 / 配置 / 仓库文件）——Identity 实施卡内决策；
2. 统一协议文本目前托管在图箱仓库（`UNIFIED_ACCOUNT_AGREEMENT.md`），正式归属 Teaven Identity 仓库后需迁移并同步哈希——迁移时机由 Identity 实施定；
3. `viewUrl` 在线阅读地址形态；4. 每日赠送积分数额；5. 弹窗视觉方案与「变更摘要」区块。
