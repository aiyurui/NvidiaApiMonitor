# NvidiaApiMonitor 项目文档

> **本文讲「内部是怎么实现的」**——架构、调度、数据模型、判定口径、API 清单、开发约定。
>
> 三份文档的分工：
>
> | 文档 | 面向 | 内容 |
> | ---- | ---- | ---- |
> | [`README.md`](README.md) | 使用者 | 快速上手、本地初始化、部署步骤、默认账号 |
> | **`PROJECT.md`**（本文） | 开发者 | 架构、任务调度、数据模型、判定口径、API、开发指南 |
> | [`deploy/DOCKER.md`](deploy/DOCKER.md) | 运维 | 容器部署、群晖 NAS 细节、排错对照表 |

---

## 1. 项目是什么

定时拉取 NVIDIA 公开模型列表，逐个做**可用性探测**与**健康检测**，在公开看板上展示模型状态、延迟、吞吐与成功率；后台可管理 API Key、测试用例、评分与调度参数。

一条链路概括：

```
NVIDIA /v1/models  ──同步──▶  Model 表  ──探测──▶  可用性结论(lastProbeOk)
                                   │
                                   └──健检(模型×用例)──▶  HealthCheck(延迟/吞吐/成功率)
                                                              │
                                                              ▼
                                                    公开看板 /   ←── 只读 API
```

**两条独立的检测链路，职责不同，别混淆：**

| | 同步探测（sync） | 健康检测（health） |
| --- | --- | --- |
| 入口 | `runSyncJob` → `probeModelAvailability` | `runHealthJob` → `runHealthCheckForModel` |
| 目的 | 判定**能不能用**（可用性真相源） | 测**快不快**（延迟 / TPS / 成功率） |
| 写法 | `max_tokens=1` 轻量请求，收到首字节即断开 | 完整流式请求，跑完收集 usage |
| 落库 | `Model.lastProbeOk / At / Code / Ms / Error` | `HealthCheck` 表 |
| 影响状态 | **是**（`lastProbeOk` 就是前台的状态来源） | **否**（唯一例外见 §7.5） |

---

## 2. 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 14.2.35（App Router，`src/` 目录，Server Components + Route Handlers） |
| 语言 | TypeScript 5 |
| UI | React 18 + TailwindCSS 3 + recharts 3（趋势/分布图） |
| 数据库 | SQLite + Prisma 6 |
| 鉴权 | next-auth 4（Credentials + JWT 策略）+ bcryptjs |
| 调度 | 进程内定时器 `setInterval`（非外部调度器；`node-cron` 仍在 `dependencies` 中但代码已不再使用） |
| 测试 | Vitest 4 |
| 脚本 | tsx（跑 seed） |

---

## 3. 目录结构

```
.
├── prisma/
│   ├── schema.prisma              # 8 张表定义（唯一数据模型真相源）
│   ├── seed.ts                    # 幂等初始化：管理员 + 设置单例 + 默认用例 + 76 条人工评分
│   └── dev.db                     # 本地开发库（gitignore）
│
├── src/
│   ├── instrumentation.ts         # 进程启动钩子 → startScheduler()（调度唯一入口）
│   ├── middleware.ts              # 保护 /admin 与 /api/admin：未登录 → 页面 302 / API 401
│   │
│   ├── app/
│   │   ├── layout.tsx             # 根布局（中文界面标题）
│   │   ├── page.tsx               # 公开看板：统计卡片 + 模型表格（30s 轮询）
│   │   ├── login/page.tsx         # 登录页（走 src/lib/auth-client.ts，不依赖 NEXTAUTH_URL）
│   │   ├── admin/                 # 后台：总览 / 模型 / Key / 用例 / 评分 / 设置 / 账号
│   │   └── api/                   # Route Handlers（详见 §8）
│   │
│   ├── components/
│   │   ├── dashboard/             # StatsCards / ModelTable / ModelDetail
│   │   └── admin/                 # ApiKeyForm / TestCaseForm / SettingsForm / PageHeader
│   │
│   ├── lib/
│   │   ├── prisma.ts              # PrismaClient 单例（含构建期占位 DATABASE_URL 兜底）
│   │   ├── auth.ts                # next-auth 配置（Credentials + 生产密钥守卫）
│   │   ├── auth-client.ts         # ★ 客户端鉴权：全部相对路径，消除 NEXTAUTH_URL 依赖
│   │   ├── admin-guard.ts         # requireAdmin()：后台 API 的服务端兜底校验
│   │   ├── login-throttle.ts      # 登录失败限流（进程内内存）
│   │   ├── crypto.ts              # AES-256-GCM 加解密（API Key 落库前加密）
│   │   ├── settings.ts            # Settings 行 → ParsedSettings，缺行自动补默认单例
│   │   ├── jobs.ts                # ★ 两个后台任务 + 并发/批处理/任务锁
│   │   ├── scheduler.ts           # 定时器注册、启动补跑、热重载
│   │   │
│   │   └── services/
│   │       ├── model-sync.ts      # 拉列表、reconcile 差异、轻量探测
│   │       ├── health-check.ts    # SSE 流式读取、TTFT/TPS 计算、Key 轮询与过载重试
│   │       ├── key-rotation.ts    # 按优先级分池 + 进程内游标轮询
│   │       └── filter.ts          # 模型分类（specialized 标签 / 黑名单）
│   │
│   └── types/index.ts             # 共享类型
│
├── deploy/                        # 部署物料（install.sh / entrypoint / PM2 / nginx / 文档）
├── Dockerfile · docker-compose.yml
├── PROJECT.md（本文）· README.md · deploy/DOCKER.md
└── vitest.config.ts               # 必须显式 exclude dist/**（见 §12）
```

---

## 4. 运行时架构

### 4.1 启动链路

```
Next.js 进程启动
   │
   └─ src/instrumentation.ts  register()        # 仅 NEXT_RUNTIME === "nodejs"
        │
        └─ startScheduler()                     # src/lib/scheduler.ts
             ├─ getSettings()                   # 读间隔配置
             ├─ buildIntervalMs()               # 换算为精确毫秒间隔
             │     syncIntervalMs   = syncIntervalHours × 3600_000
             │     healthIntervalMs = healthIntervalMin  × 60_000
             ├─ makeTimer(...) × 2               # setInterval，各自 withJobLock(runXxxJob)
             └─ runStartupCatchUp()             # ★ 异步补跑，不 await，不阻塞网站就绪
```

**启动补跑**（`runStartupCatchUp`）的判定顺序很重要：

- 同步「从未跑过」或「已超过 `syncIntervalHours`」→ **先补同步**（同步是健检的前提，它负责刷新可探测名单）
- 同步补完后若健检也过期，顺带补一次健检
- 同步不 stale 但健检 stale → 只补健检

### 4.2 调度句柄挂在 `globalThis`

`jobs` 数组存在 `globalThis.__schedulerJobs` 上，而不是模块变量。原因是 dev 模式 HMR 会重新求值模块，模块级变量会丢，导致旧定时器泄漏 + 新建一份，间隔被成倍触发。

### 4.2.1 为什么不用 cron 表达式

`node-cron` 的 `*/N` 语义是「N **能整除**的那些分钟」，**不是「每 N 分钟」** —— cron 每小时独立重置，所以：

| 设置值 | `*/N` 的实际节奏 | 期望 |
| --- | --- | --- |
| 30 分钟 | :00 / :30（间隔 30/30） | ✅ 恰好整除 60 |
| 45 分钟 | :00 / :45（间隔 45/15 **摆动**） | ❌ |
| 90 分钟 | 旧实现退化为整点 → 实际每 60 分钟 | ❌ |
| 同步 5 小时 | 0/5/10/15/20 点（间隔 5,5,5,5,**4**） | ❌ |

因此改用 `setInterval` 直接表达「每 N 毫秒」，让设置值**精确生效**。代价是触发时刻不再对齐整点/整分——对可用性监控无影响。

### 4.3 任务锁

`withJobLock(fn)` 是**进程内布尔锁**：

- 已有任务在跑 → 本次直接 skip 并返回 `null`（日志 `[scheduler] skip, another job is running`）
- 加 30 分钟超时兜底：锁被占超过 30 分钟则强制释放（防止挂起的任务让调度永久停摆）

锁是进程内的，所以**多副本会各跑各的**——这是「只能起 1 个实例」硬约束的根因。

### 4.4 任务运行记录

每个任务用 `SyncRun` 两阶段落库：

1. 开始时 `startRun(kind)` → 写一条 `running=true`
2. 结束时 `finishRun(id, {...})` → 回填统计并把 `running` 置 `false`

好处是前端能实时看到「执行中」。

⚠️ 但「崩溃时 `running` 一直为 true」只会留下**永不结束的僵尸记录**——后台「最近同步」就一直显示"执行中"。
`runSyncJob` / `runHealthJob` 因此各带一层**收尾守卫**（外层 try/catch + `recorded` 标志）：
主体任何一处未捕获异常（DB 抖动、`getSettings()` 抛错、探测循环里 `prisma.model.update` 失败）
都会被兜住并写成 `ok=false`；已经记录过的分支不会被覆盖。任务锁另有 `withJobLock` 的 finally 兜底。

---

## 5. 两个后台任务详解

### 5.1 `runSyncJob`（模型同步 + 全量探测）

```
① startRun("sync")
② getSettings() → filterKeywords / blacklistModelIds
③ 取一条 Key：where enabled=true, orderBy [priority desc, lastUsedAt asc]
    └ 取不到 → 记 errorMessage="no available api key" 并抛错
④ 并发度 syncConcurrency = resolveConcurrency(keyRows.length)
⑤ syncModels()
     GET  {baseUrl}/models            → RemoteModel[]
     reconcileModels(existing, remote) → { toCreate, toUpdate, toRemove }
     assertSafeReconcile(...)          ★ 会把看板清空时直接中止本轮（见下方告警）
     create → 新模型入库（classifyModel 打 specialized 标签）
     touch  → 已存在的更新元数据 + lastSeenAt + isActive=true, removedAt=null
     remove → 远端已消失：isActive=false, removedAt=now（★ 软删除，不物理删）
⑥ 全量探测：where isActive=true AND isSpecialized=false
     runInBatches(toProbe, syncConcurrency, JOB_INTERVAL_MS, probeModelAvailability)
     每个结果写入 Model.lastProbe*
     探测成功 → consecutiveTimeouts=0, downReason=null（★ 唯一恢复路径）
⑦ finishRun：added / updated / removed / probeOk / probeDown
```

> ⚠️ **空清单保护（防看板被清空）**：上游限流 / 维护 / Key 权限变更时会返回
> **HTTP 200 + 空数组**，或返回一份与本地**完全不重叠**的清单。这两种情况
> **走不到** `fetchRemoteModels` 的失败分支（它是 200 + 合法 JSON），
> 却会让 `toRemove` 等于本地全部模型 —— 看板瞬间被清空。
> `assertSafeReconcile()` 因此在「本次将移除本地全部模型」时抛错中止本轮，
> 消息以 `aborted:` 开头，`runSyncJob` 会**原样记录**（不再套 `fetch model list failed`，
> 否则会被误读成网络问题）。
> 只拦**全量**：部分下线是可逆的（模型重回上游清单时 `touch` 会置回 `isActive=true`），
> 设比例阈值反而会在上游合法的大批量下线时一直误拦。

> ⚠️ **同步阶段的探测只用第 ③ 步那一条 Key**（`keyRow`），不做轮询。Key 轮询只发生在健检（§5.2）。因此「多 Key 分摊压力」在同步探测这一步是不生效的，只是并发度按 Key 数放大。

### 5.2 `runHealthJob`（全量健康检测）

```
① startRun("health")
② 并行取三份名单：
     models = Model   where isActive=true AND isSpecialized=false AND lastProbeOk=true
     cases  = TestCase where enabled=true
     keys   = ApiKey   where enabled=true（逐个 decryptSecret，解不开的跳过）
   任一为空 → finishRun(ok=false, 原因) 并直接返回
③ tasks = models × cases  （笛卡尔积，每项 = 一个模型跑一个用例）
④ runInBatches(tasks, resolveConcurrency(keys.length), JOB_INTERVAL_MS, ...)
     ├ 预算检查：已超 HEALTH_JOB_BUDGET_MS(3min) → skipped++ 且不再发起新检测
     ├ runHealthCheckForModel(...)   → 完整流式请求
     ├ 写 HealthCheck 行（ttftMs / latencyMs / tokensPerSec / outputTokens / success）
     └ 只把结果记进 perModel（不在这里直接 +1，见 §7.5）
   └ 批次结束后按**模型**聚合，再统一更新连续超时计数
⑤ finishRun(checkedCount, errorMessage=汇总备注)
```

**健检名单依赖 `lastProbeOk=true`**，这是有意设计：模型一旦因连续超时被标记不可用，就会自然退出健检名单，避免持续浪费时间探测一个已知黑洞。恢复只能走同步探测。

### 5.3 并发模型

```ts
resolveConcurrency(keyCount) = JOB_CONCURRENCY ?? keyCount   // 至少 1

runInBatches(items, batchSize, intervalMs, run) {
  for (每批) {
    if (不是第一批) await sleep(intervalMs)
    await Promise.all(批内并发)
  }
}
```

- **并发度 = 可用 Key 个数**（`JOB_CONCURRENCY` 可强制覆盖，设 1 即退回完全串行）
- **批间固定等待 `JOB_INTERVAL_MS`（默认 2000ms）**，目的是别把上游 Worker 配额打满触发 `ResourceExhausted`
- ⚠️ **批耗时 = 批内最慢成员**。两个 60s 黑洞模型落在不同批时会各拖垮一批（实测整轮 133s）。想提速只能降低单次超时预算或摘掉黑洞模型，加并发反而更慢。

### 5.4 环境变量覆盖

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `JOB_CONCURRENCY` | 可用 Key 数 | 覆盖批内并发度 |
| `JOB_INTERVAL_MS` | `2000` | 批间等待 |
| `CONSECUTIVE_TIMEOUT_THRESHOLD` | `3` | 连续超时下线阈值 |
| `HEALTH_JOB_BUDGET_MS` | `180000` | 单轮健检软预算 |

---

## 6. 数据模型

`prisma/schema.prisma` 是唯一真相源，共 8 张表。

### `User` — 管理员账号

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | String cuid | 主键 |
| `email` | String @unique | 登录名 |
| `password` | String | bcrypt hash |
| `role` | String | 默认 `ADMIN` |

### `ApiKey` — NVIDIA API Key（密文存储）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` / `key` | String | `key` 为 AES-256-GCM 密文，唯一约束 |
| `baseUrl` | String | 默认 `https://integrate.api.nvidia.com/v1` |
| `enabled` | Boolean | **唯一的可用性判据** |
| `priority` | Int | 分层依据：高优先级层优先，层内全忙才降级到下一层（见 §7.7） |
| `cooledUntil` | DateTime? | ⚠️ **兼容字段，已不参与任何判定**（本项目不冻结 Key） |
| `lastUsedAt` | DateTime? | 使用时间记录（不用于轮询排序，见 §7.7） |

### `Model` — 模型（含探测结论）

| 字段组 | 字段 | 说明 |
| --- | --- | --- |
| 元数据 | `modelId` @unique / `name` / `description` / `contextLength` | 来自远端列表，`modelId` 含 `/` |
| 能力位 | `supportsVision` / `supportsTools` / `supportsJson` | 前台筛选用 |
| 分类 | `isSpecialized` / `specializedTags`（JSON 字符串） | 关键词命中即 specialized；specialized 模型**不参与探测与健检** |
| 生命周期 | `isActive` / `discoveredAt` / `lastSeenAt` / `removedAt` | 远端消失时软删除 |
| **可用性** | `lastProbeAt` / `lastProbeOk` / `lastProbeCode` / `lastProbeMs` / `lastProbeError` | ★ 同步探测结论，前台状态真相源 |
| 下线机制 | `consecutiveTimeouts` / `downReason` | 连续超时计数与下线原因（独立字段，不复用 `lastProbeError`） |

### `SyncRun` — 任务运行记录

| 字段 | 说明 |
| --- | --- |
| `kind` | `sync` \| `health` |
| `running` | 进行中标记。任务有收尾守卫兜底（见 §5），只有**进程被强杀**才可能残留 true |
| `startedAt` / `finishedAt` / `durationMs` | 时间 |
| `addedCount` / `updatedCount` / `removedCount` | 同步专用 |
| `probeOk` / `probeDown` | 同步探测结果计数 |
| `checkedCount` | 健检专用：本次完成的检测条数 |
| `errorMessage` | 失败原因 / 汇总备注 |

### `HealthCheck` — 单次「模型 × 用例」检测

| 字段 | 说明 |
| --- | --- |
| `modelId` / `apiKeyId` | 外键，`onDelete: Cascade`（删模型 / 删 Key 会连带删除其检测记录） |
| `testCaseId` | ⚠️ **普通可选字段（`String?`），没有外键** —— 删除测试用例**不会**连带删除历史检测记录 |
| `ttftMs` | 首包耗时 |
| `latencyMs` | 总耗时 |
| `tokensPerSec` / `outputTokens` | 吞吐与输出 token 数 |
| `success` | 30s 内是否有任何响应 |
| `errorMessage` | 失败原因 |

### `ManualScore` — 人工评分

| 字段 | 说明 |
| --- | --- |
| `modelId` @unique | **注意：与 `Model` 表无 Prisma relation**，靠 modelId 字符串内存 join（因为 modelId 含 `/`，不好做外键） |
| `score` | 整数 0–100 |
| `note` | 备注 |

### `TestCase` — 检测用例

| 字段 | 说明 |
| --- | --- |
| `messages` | JSON 字符串数组，直接作为 `messages` 发给上游 |
| `maxTokens` / `temperature` | 请求参数 |
| `enabled` | 只有启用的用例参与健检 |

### `Settings` — 全局设置单例

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `id` | `"singleton"` | 固定主键，永远只有一行 |
| `syncIntervalHours` | `6` | 同步间隔 |
| `healthIntervalMin` | `30` | 健检间隔。固定间隔，自进程启动时刻起算，设多少就是多少（不再对齐整点） |
| `defaultReasoning` | `false` | 请求体是否带 `reasoning: { enabled: true }` |
| `filterKeywords` | safety/moderation/guard/… 7 个 | specialized 判定关键词 |
| `blacklistModelIds` | `[]` | 黑名单（后台勾选 specialized 时同步写入） |
| `scoringWeights` | 九维权重 JSON | ⚠️ **仅存储与校验，当前未参与任何计算**（见 §12） |
| `entryPasswordHash` | `null` | 全局入口密码（bcrypt 哈希）。**null = 功能关闭**；设置后：首页重定向 `/entry`、公开 API 返回 401，验证通过种 30 天签名 Cookie。哈希**绝不外传**（`parseSettings` 只暴露 `entryPasswordEnabled` 布尔开关） |

`getSettings()` 用 `upsert` 而非 `findUniqueOrThrow`，缺行时自动补默认单例——否则 settings 表为空会让调度器启动即崩。

---

## 7. 关键判定口径（改代码前务必先读）

### 7.1 可用状态只有三态，且以「同步探测 + 滚动时效窗口」为准

```ts
// 时效窗口 validMs = max(24h, syncIntervalHours + 2h)，滚动判定、与自然日无关
const fresh = isProbeFresh(lastProbeAt, now, validMs); // now - lastProbeAt <= validMs

status = lastProbeOk === true  && fresh ? "ok"       // 可用
       : lastProbeOk === false && fresh ? "down"     // 不可用
       : "untested";                                        // 未测
```

**结论有时效性（滚动窗口）**：探测结论在「最后一次探测 + validMs」后过期，过期显示「未测/已过期」，不得当成当前状态展示。前后台（`/api/models`、`/api/models/stats`、后台模型页）必须用同一判定。

> ⚠️ 不要改回「按自然日判定」（旧 `isProbedToday`）：自然日基准在 0 点整条跳变，昨天探测的模型会在**过 0 点瞬间集体过期**——表现为"刚过 0 点可用模型被清空，直到下次同步"（默认 6h 间隔下最长空窗 6 小时）。滚动窗口下正常调度的探测永远有效（探测最多只有同步间隔那么旧），调度坏了才按各模型自己的探测时间**错峰**过期。

### 7.2 单次健检失败**不得**翻转可用状态

健检只用来展示延迟 / TPS / 近 24h 成功率。唯一例外是 §7.5 的连续超时下线。

### 7.3 可用性 = 「有没有数据回来」，不是 HTTP 状态码

上游存在「接受连接但永不响应」的黑洞模型（如 `openai/gpt-oss-20b`），HTTP 200 但零字节。因此同步探测与健检都是**流式 + 首字节判定**。

四个探测/判定的超时常量口径统一为 **30 秒**，另有一个「拉清单」超时：

| 常量 | 位置 | 值 |
| --- | --- | --- |
| `AVAILABILITY_TIMEOUT_MS` | `health-check.ts` | 30 s |
| `TOTAL_TIMEOUT_MS` | `health-check.ts` | 30 s |
| `PROBE_TIMEOUT_MS` | `model-sync.ts` | 30 s |
| `PROBE_FIRST_BYTE_MS` | `model-sync.ts` | 30 s |
| `MODEL_LIST_TIMEOUT_MS` | `model-sync.ts` | 30 s（`fetchRemoteModels` 拉 `/models`；不加超时会让同步任务无限阻塞，`withJobLock` 的 30 分钟兜底只释放内存锁、不终止请求） |

**不要再调回 60s**：会让黑洞模型拖垮整批（实测整轮 133s → 30s 后降到 74s）。

### 7.4 TTFT / TPS / 可用率

```ts
TPS = outputTokens / max((latencyMs - ttftMs) / 1000, 0.001)
```

- **TPS 取 `usage.completion_tokens`**；部分模型不回传 usage，此时用 `estimateTokens(text)` 粗估（CJK ≈ 1 token/字，其余 ≈ 4 字符/token），保证「有输出」不显示 0 TPS
- **列表中的 TTFT / TPS 都是近 24h 成功检测的均值**，且均值计算**排除 `tokensPerSec = 0` 的历史脏数据**
- **可用率 = 近 24h `success` 条数 / 总条数**（列表、详情、统计卡片同一口径）

### 7.5 连续超时下线（唯一能靠健检改状态的机制）

- **按轮计数，不是按「模型 × 用例」**：一轮健检里该模型的用例**全部**超时才 `+= 1`，
  只要有任一用例成功就清零。
  （旧实现在每个 task 里各自 `increment`，启用 N 个用例时一轮就 +N，阈值被放大 N 倍 ——
  2 个用例 1.5 轮就下线，与「连续 3 轮」的设计语义不符。`markedDown` 同样改为按模型计一次，
  此前按 task 计会虚高。）
- 即：以「轮」为单位，`timedOut` → `consecutiveTimeouts += 1`；有任一 `success` → 清零
- 计数达 `CONSECUTIVE_TIMEOUT_THRESHOLD`（默认 3）→ `lastProbeOk = false` + 写 `downReason`
- 模型随即退出健检名单，**恢复只能靠下一次全量可用性检查**（同步探测成功 → 清零 + `lastProbeOk = true` + `downReason = null`）
- `downReason` 是独立字段：**不要拿 `lastProbeError` 记健检原因**，前台「超时」徽章依赖它的前缀语义

### 7.6 上游过载计为不可用，但可退避重试

NVIDIA 在 Worker 配额满载时会返回 **HTTP 200 + SSE 内 `error`**，形如 `ResourceExhausted: Worker local total request limit reached (N/M)`，响应体极小（实测恒定 155 字节 / 1 chunk / 2 事件，无 delta 无 usage）。

- 判定函数：`isOverloadError(msg)` → 命中 `ResourceExhausted` / `Service temporarily overloaded` / `total request limit reached`
- 处理：**退避 3s 重试，最多 2 次**（`OVERLOAD_RETRY_DELAYS_MS = [3000, 3000]`），重试时轮询到下一个 Key
- 最终仍失败 → 计为不可用（`success=false`）
- **超时不重试**：换 Key 重试仍是同样的超时，只会让耗时翻倍
- 4xx 快速失败码（400/404/410/422）直接判失败，不重试

### 7.7 Key 轮询靠进程内游标，且永不冻结

- `isKeyAvailable(key)` **只看 `enabled`**，不看 `cooledUntil`
- **本项目任何情况下都不冻结 / 冷却 Key**：Key 不是失败源（瓶颈在模型/Worker），冻结会造成级联掏空（曾导致每轮固定 12 次 `no available api key`）
- 轮询实现：`selectNextKey` 把可用 Key 按 `priority` **降序分层**，逐层优先取「当前未被并发占用」的 Key，层内用**进程内游标 `rotationCursor`** 严格轮转
- **层满溢出**：最高优先级层全部处于使用中（`inflight > 0`）时降级到下一优先级层。若只在高优先级层内轮询，由于本项目不冻结 Key（池永不耗尽），「并发度 = Key 个数」会退化成 N 个请求全打同一把 Key —— 这正是 `markKeyBusy` / `markKeyIdle` 这对占用计数存在的原因。
- 所有 Key 都在使用中（并发度 > Key 总数）→ 复用最高优先级层，保证永远能选出 Key
- ⚠️ **不能改成按 `lastUsedAt` 排序**：`keys` 是内存快照，`onKeyUsed` 只写库不回写数组，排序键恒定 → 每次都选同一个 Key（实测 4 把 Key 只用了 1 把）。改回去会重新引入该 bug。

### 7.8 SSE 解析的三个坑

| 坑 | 处理 |
| --- | --- |
| 推理模型正文全落在 `delta.reasoning_content` | 必须与 `delta.content` **合并**，否则 text 为空 → TPS = 0 |
| `usage` 在最后一个事件且**可能不以 `\n\n` 结尾** | 循环结束后必须 **flush 残留 buf**，否则 usage 被丢弃 → outputTokens = 0 |
| HTTP 200 但 payload 内是 `error` | 必须识别并判失败，否则当成成功 → outputTokens = 0 |

---

## 8. API 一览

### 8.1 公开只读（无需登录）

> **全局入口密码（`Settings.entryPasswordHash` 非空时生效）**：本组三个 GET 接口会先过 `requireEntryAccess()`（`src/lib/entry-guard.ts`），未解锁一律 401 `{error:"entry password required"}`。守卫在 Node 运行时（页面/路由处理器）做而**不在 middleware**——Edge 中间件读不到数据库，无法判断「入口密码是否已配置」。
> **解锁条件（满足其一）**：① `nv-entry-key` 签名 Cookie（HMAC-SHA256，密钥复用 `NEXTAUTH_SECRET`，**载荷绑定密码哈希前 12 字符** → 改密码即令旧 Cookie 全部失效），30 天有效；② **管理员已登录的 NextAuth 会话**（后台总览页会调 `/api/models/stats`，会话放行后不致 401；入口密码挡的是无账号访客，不拦管理员）。
> **覆盖面**：首页 `/`、公开 API、`/login`（服务端守卫包装，堵住"经 /admin → /login 绕过入口密码"的路径）；`/admin` 由中间件要求会话、而会话 ⇒ 已解锁，无需单独拦截。**永不拦截**：`/entry`、`/api/entry/verify`、`/api/auth/*`（登录流程必需）、`/api/health`。验证接口按 IP 限流：10 分钟内失败 5 次锁定。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models` | 模型列表。query：`status=ok\|down\|untested`、`capability=vision\|tools\|json`、`sort=score\|availability\|ttft\|tps\|updated`、`order=asc\|desc` |
| GET | `/api/models/stats` | 统计卡片数据。**显式 `force-dynamic`**（否则生产构建会把它静态化成构建期快照） |
| GET | `/api/models/<modelId…>/history` | 检测历史趋势。query：`range=7d`（336 条）否则 48 条。modelId 含 `/`，用尾段 catch-all + 派发 |
| POST | `/api/entry/verify` | 入口密码验证。body `{password}`；成功 200 + Set-Cookie `nv-entry-key`（httpOnly，30 天），失败 401，限流触发 429 |
| GET | `/api/health` | 容器健康检查（**无门禁**）。ping DB（SELECT 1），正常 200 / DB 挂 503。Dockerfile/compose/install.sh 的健康探测都打这里——不能用 `/api/models/stats` 代替，入口密码启用后它对未解锁访问返回 401 会误判 unhealthy |

### 8.2 需要登录（`/api/admin/*`，未登录返回 401）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/*` | next-auth（csrf / callback / session / signout） |
| GET · PUT | `/api/admin/settings` | 全局设置。**PUT 后自动 `restartScheduler()` 热重载**。PUT 额外接受 `entryPassword`（非空则 bcrypt 落库，空串视为未提供）与 `entryPasswordClear: true`（置 null 关闭入口保护），二者互斥 |
| GET | `/api/admin/jobs` | 轻量任务状态（最近两次运行 + 间隔 + 今日计数 + `schedulerActive`），供后台轮询 |
| POST | `/api/admin/scheduler` | 手动激活调度器（instrumentation 未自动启动时的兜底） |
| POST | `/api/admin/models/sync` | 手动触发同步 |
| GET | `/api/admin/models` | 全部模型（含 specialized）+ 最近运行记录 |
| PUT | `/api/admin/models/[id]` | 切换 `isSpecialized`（会同步增删 `blacklistModelIds`） |
| POST | `/api/admin/models/[id]/health-check` | 单模型手动健检 |
| POST | `/api/admin/models/health-check-all` | 触发全量健检（任务冲突时 409） |
| GET · POST | `/api/admin/api-keys` | 列表（key 掩码为前 4 位 + `****`）/ 新建（落库前加密） |
| PUT · DELETE | `/api/admin/api-keys/[id]` | 更新 / 删除 |
| GET · POST | `/api/admin/test-cases` | 用例列表 / 新建 |
| PUT · DELETE | `/api/admin/test-cases/[id]` | 更新 / 删除 |
| GET | `/api/admin/scores` | 评分列表（关联模型名与上下线状态） |
| GET | `/api/admin/scores/pending` | 待评分模型 |
| PUT · DELETE | `/api/admin/scores/[...modelId]` | 写 / 删评分（score 必须是 0–100 整数）。modelId 含 `/`，用 catch-all join 还原 |
| PUT | `/api/admin/account` | 改邮箱 / 密码（需验证当前密码） |
| GET · POST | `/api/admin/data/today` | 预览今日数据量 / 清理今日 `HealthCheck` + `SyncRun`（可选 `?resetProbe=1` 一并清空 `lastProbe*`） |

> 后台 API 有**双重保护**：`middleware.ts` 拦 `/api/admin/:path*`，各 Route Handler 内再调 `requireAdmin()` 兜底。

---

## 9. 前端页面

| 路由 | 文件 | 说明 |
| --- | --- | --- |
| `/` | `app/page.tsx` | **服务端守卫包装**：入口密码未解锁时 `redirect("/entry")`，否则渲染 `DashboardClient`（原 784 行客户端看板已整体移至 `components/dashboard/DashboardClient.tsx`）。公开看板：`StatsCards` + `ModelTable` + `ModelDetail`，**30 秒轮询** `/api/models` 与 `/api/models/stats` |
| `/entry` | `app/entry/page.tsx` | 入口密码验证页（仅在 `entryPasswordHash` 已配置时有意义）。已解锁的访客再次访问会自动跳回目标页 |
| `/login` | `app/login/page.tsx` | 登录（走 `auth-client.ts` 的相对路径流程）。**不受入口密码拦截**（有意设计，见 §8.1） |
| `/admin` | `admin/page.tsx` | 总览：调度状态、最近同步/健检、今日轮数、手动触发按钮 |
| `/admin/models` | `admin/models/page.tsx` | 模型管理（最大的页面，784 行）：筛选、批量触发、specialized 切换 |
| `/admin/api-keys` | `admin/api-keys/page.tsx` | Key 管理 |
| `/admin/test-cases` | `admin/test-cases/page.tsx` | 用例管理 |
| `/admin/scores` | `admin/scores/page.tsx` | 人工评分 |
| `/admin/settings` | `admin/settings/page.tsx` | 全局设置（保存后热重载调度） |
| `/admin/account` | `admin/account/page.tsx` | 改邮箱 / 改密码 |

**界面上的「次」= 任务轮数**（今日健检轮数 / 今日同步轮数），不是累计探测动作数。两者都取自 `SyncRun` 计数（`healthChecksToday` 才是累计探测动作数）。

---

## 10. 环境变量

### 运行时必需（生产）

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | SQLite 路径。生产**用绝对路径** `file:/data/prod.db`，避开相对路径解析基准不一致 |
| `NEXTAUTH_SECRET` | ≥32 字符。生产缺失会在运行时抛错（**构建期豁免**，见 §11.3） |
| `ENCRYPTION_KEY` | 64 位 hex（32 字节），API Key 的 AES-256-GCM 密钥。**换机器必须沿用旧值**，否则库里 Key 全部解不开 |

### 可选

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXTAUTH_URL` | 不设 | **不需要配**。`AUTH_TRUST_HOST=true` 时按请求 Host 推导；只有要强制固定域名才设 |
| `TZ` | 容器内设 `Asia/Shanghai` | 「今日」相关逻辑走服务端本地时区 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` | — | 首次 seed 用。Docker 下不填则自动生成随机密码并持久化 |
| `SEED_FORCE` | `0` | 设 `1` 强制重写管理员密码 |
| `DB_PUSH_ON_START` | `1` | 启动时自动 `prisma db push` |
| `JOB_CONCURRENCY` / `JOB_INTERVAL_MS` / `CONSECUTIVE_TIMEOUT_THRESHOLD` / `HEALTH_JOB_BUDGET_MS` | 见 §5.4 | 调度与节流。**留空必须回退到默认值，不能当作 0**（见下） |

### 10.x 环境变量的空串陷阱（务必遵守）

compose 用 `environment: K: "${K:-}"` 注入未配置的可选变量时，容器里拿到的是**空字符串**而不是"未设置"。而 `??` 只对 `null`/`undefined` 回退，所以：

```ts
Number(process.env.HEALTH_JOB_BUDGET_MS ?? 3 * 60 * 1000)  // 空串 → Number("") === 0 ❌
```

后果（全部实测可复现）：

| 变量被读成 0 | 症状 |
| --- | --- |
| `HEALTH_JOB_BUDGET_MS` | `Date.now() - budgetStartMs >= 0` 恒真 → **健检每条任务都被跳过**，`checkedCount` 恒为 0，连带连续超时统计与下线机制全部失效 |
| `JOB_INTERVAL_MS` | 批间节流归零 → 连续请求把上游 Worker 配额打满（放大 `ResourceExhausted`） |
| `CONSECUTIVE_TIMEOUT_THRESHOLD` | 任意一次超时即把模型下线 |

**统一用 `jobs.ts` 的 `readIntEnv(name, fallback, min)`**：空串 / 全空白 / 非法值 / 低于下限一律回退默认值。`JOB_CONCURRENCY` 用显式 truthiness 判断（空串 → `null`，走"按 Key 个数"的动态默认）。

---

## 11. 开发指南

### 11.1 本地启动

仓库里**不含 `.env`**（只有 `.env.example` 模板），首次运行必须自己生成一份：

```bash
npm install
npx prisma generate

# 缺 DATABASE_URL → 任何查询都报 "Environment variable not found: DATABASE_URL"
# 缺 ADMIN_PASSWORD_HASH → db:seed 抛 "ADMIN_PASSWORD_HASH is required for seeding"（均已实测）
cp .env.example .env
# 编辑 .env 填三项（生成命令依赖已装好的 node_modules）：
#   ADMIN_PASSWORD_HASH  node -e "console.log(require('bcryptjs').hashSync('你的密码',10))"
#   ENCRYPTION_KEY       openssl rand -hex 32        # 必须 64 位 hex，换了它库里已有 API Key 全部解不开
#   NEXTAUTH_SECRET      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run db:push
npm run db:seed          # 管理员 + 设置单例 + 默认用例 + 76 条评分
npm run dev
```

`.env` 已被 `.gitignore` 忽略。

### 11.2 测试

```bash
npm test        # vitest run：10 个文件 / 95 个用例
npx tsc --noEmit
```

`vitest.config.ts` **必须显式 exclude `dist/**`** —— `dist/` 里的源码解包副本会让测试数量翻倍（8 files/70 tests → 17/143），「影子副本」会掩盖真实失败。

### 11.3 构建期约束（踩过的坑，别改回去）

| 约束 | 原因 |
| --- | --- |
| **模块级绝不抛错** | `next build` 会在 Collecting page data 与类型检查阶段求值路由/layout 模块。模块级 `throw` 会被 Next 吞成一行 `Next.js build worker exited with code: 1 and signal: null`，真实原因丢失 |
| `auth.ts` 的生产密钥守卫**必须豁免构建期** | 以 `NEXT_PHASE === "phase-production-build"` 为条件；运行期照旧早失败。容器构建上下文没有 `.env`，不豁免则构建必失败 |
| `prisma.ts` 构建期补占位 `DATABASE_URL` | 缺 `DATABASE_URL` 时用 `file:/tmp/next-build-placeholder.db` |
| 路由不要有「无参且不读 request」的 GET | Next 14 会在构建时静态预渲染它，线上永远返回构建那一刻的快照（`/api/models/stats` 因此显式 `force-dynamic`） |
| 任何 `@` 开头的目录 = 并行路由插槽 | 群晖 DSM 生成 `@eaDir` 会让类型检查多出必填属性而构建失败。三层防护见 `deploy/DOCKER.md` |

自检命令（同一命令改前失败、改后通过）：

```bash
NEXTAUTH_SECRET=tooshort NODE_ENV=production npx next build
```

用进程环境变量覆盖即可，**不要动 `.env`**——Next 的 env 加载不覆盖已存在的环境变量，所以这样才能精确模拟「容器里没有 .env」。

### 11.4 常见改动落点

| 想改什么 | 改哪里 |
| --- | --- |
| 可用性判定规则 / 超时时长 | `src/lib/services/health-check.ts`、`model-sync.ts` 的五个常量（见 §7.3） |
| 同步与健检的流程 | `src/lib/jobs.ts` |
| 调度间隔换算 | `src/lib/scheduler.ts` 的 `buildIntervalMs` |
| Key 选择策略 | `src/lib/services/key-rotation.ts` |
| 模型分类（specialized） | `src/lib/services/filter.ts` |
| 默认设置值 | `prisma/schema.prisma` 的 `@default` + `src/lib/settings.ts` 的 `DEFAULT_*` |
| 前台状态口径 | `src/app/api/models/route.ts` 与 `stats/route.ts`（**两处必须一致**） |

### 11.5 改完必须重启

**调度与探测逻辑只在进程启动时加载。** 改了 `jobs.ts` / `scheduler.ts` / `health-check.ts` 后，dev server 必须重启才生效。排查「改了没生效」时，先对账「源文件 mtime」vs「异常记录写入时间」。

---

## 12. 已知限制与待办

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | **`scoringWeights` 未参与计算** | 九维权重目前只在后台存储与校验，没有任何代码用它算分。`ManualScore.score` 是人工直接填的 0–100 整数。~~`README.md` 里「九维打分 + 加权总分」的旧描述~~ 已修正为「尚未参与算分」；若日后要真正启用九维评分，需补实现而非只改文案 |
| 2 | 登录限流是**进程内内存** | `login-throttle.ts` 的 Map 在重启后清空，多副本时各算各的。属于可接受降级 |
| 3 | **只能单副本** | 调度是进程内 `setInterval`，任务锁、Key 轮询游标（含 `inflight` 占用计数）都是进程内状态。多副本 = 重复探测 + SQLite 写冲突 |
| 4 | SQLite 单写入者 | `data` 目录必须是本机卷，放 NFS/SMB 会因文件锁异常损坏 |
| 5 | 调度依赖进程存活 | 关掉进程就不再检测。判断调度是否活着，看首页「最近健检」时间或后台「最近一次全量健检」卡片 |
| 6 | 人工评分与 Model 无外键 | `ManualScore.modelId` 是裸字符串（因为 modelId 含 `/`），模型删除后评分会变成孤儿行 |
| 7 | 同步探测只轮询单 Key | 见 §5.1 的警告。若单 Key 触发限流，同步阶段会整批失败 |

---

## 13. 相关文档

| 文档 | 内容 |
| --- | --- |
| [`README.md`](README.md) | 快速上手、部署（Docker / PM2）、默认账号、定时任务速览 |
| [`deploy/DOCKER.md`](deploy/DOCKER.md) | 容器部署细节、群晖 Container Manager、反向代理 HTTPS、备份、排错对照表 |
| [`deploy/env.production.example`](deploy/env.production.example) | 生产环境变量模板（PM2 方式用；Docker 方式不需要） |
| `prisma/schema.prisma` | 数据模型真相源 |

---

_最后更新：2026-10-09_
