import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { decryptSecret } from "@/lib/crypto";
import { classifyModel, serializeTags } from "@/lib/services/filter";
import { syncModels, probeModelAvailability, type SyncDb } from "@/lib/services/model-sync";
import { runHealthCheckForModel } from "@/lib/services/health-check";
import type { KeyCandidateWithSecret } from "@/lib/services/key-rotation";

/**
 * 安全读取整数环境变量。
 *
 * ⚠️ 不要退回 `Number(process.env.X ?? 默认值)` 的写法：
 * compose 用 `environment: K: "${K:-}"` 注入未配置的可选变量时，容器里拿到的是**空字符串**，
 * 而 `??` 只对 `null`/`undefined` 回退，空串会落到 `Number("") === 0`。后果：
 * - `HEALTH_JOB_BUDGET_MS = 0` → `Date.now() - budgetStartMs >= 0` 恒真 → **健检每条任务被跳过**，checkedCount 恒为 0；
 * - `JOB_INTERVAL_MS = 0` → 批间节流归零，连续请求把上游 Worker 配额打满（放大 ResourceExhausted）；
 * - `CONSECUTIVE_TIMEOUT_THRESHOLD = 0` → 任意一次超时立即把模型下线。
 * 因此：空串 / 非法值 / 低于下限 → 一律回退到默认值。
 */
export function readIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * 单个任务内的并发上限（同步探测 / 健康检查各自使用）。
 * **默认按"可用 Key 个数"动态决定**（见 `resolveConcurrency(keys)`）：
 * 有几把 Key 就同时打几个请求，让 Key 轮询真正并行分摊。
 * 也可用 JOB_CONCURRENCY 环境变量强制指定（如设为 1 退回完全串行）。
 * 未设置/空串 → null（走"按 Key 个数"的动态默认）。
 */
export const JOB_CONCURRENCY: number | null = (() => {
  const raw = process.env.JOB_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

/**
 * 相邻两"批"之间的固定间隔（毫秒）。
 * 一批 = 并发上限（默认 Key 个数）个请求；批与批之间等待该间隔，
 * 避免连续请求把上游 Worker 配额打满。可用 JOB_INTERVAL_MS 覆盖（允许显式设为 0 表示不节流）。
 * 同步探测与健康检查使用同一间隔（"可用性检测同理"）。
 */
export const JOB_INTERVAL_MS = readIntEnv("JOB_INTERVAL_MS", 2_000, 0);

/**
 * 健康检查连续超时次数阈值：连续 N 次「可用性窗口内无任何响应」后，
 * 把模型标记为不可用（lastProbeOk=false）。
 * 该标记**可被全量可用性检查恢复**——同步探测一旦成功即清零并恢复。
 */
export const CONSECUTIVE_TIMEOUT_THRESHOLD = readIntEnv("CONSECUTIVE_TIMEOUT_THRESHOLD", 3, 1);

/**
 * 解析一次任务实际使用的并发度：
 * 优先用 JOB_CONCURRENCY 环境变量；否则取**可用 Key 个数**（至少 1）。
 */
export function resolveConcurrency(keyCount: number): number {
  const c = JOB_CONCURRENCY ?? keyCount;
  return Math.max(1, Math.floor(c) || 1);
}

/**
 * 把数组按 batchSize 切成若干批，逐批执行 `run(item)`（批内并发、批间串行），
 * 每批之间等待 `intervalMs`。这是"并发数 = Key 个数，并发完等 2 秒再下一批"的实现。
 */
export async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  intervalMs: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  const size = Math.max(1, batchSize);
  for (let start = 0; start < items.length; start += size) {
    if (start > 0) await sleep(intervalMs);
    const batch = items.slice(start, start + size);
    const settled = await Promise.all(
      batch.map((item, i) => run(item, start + i)),
    );
    out.push(...settled);
  }
  return out;
}

/**
 * 单轮健康检查的整体时长上限。
 * 目的：当上游大面积拥塞时，个别模型（如 openai/gpt-oss-20b 长时间无首包）
 * 会把整轮拖到数分钟，进而占满任务锁、让下一轮健检被跳过。
 * 超过该上限后**不再发起新的检测**，已经开始的检测允许跑完并落库。
 * 默认 3 分钟，可用 HEALTH_JOB_BUDGET_MS 覆盖（见 `readIntEnv` 的空串陷阱说明）。
 */
export const HEALTH_JOB_BUDGET_MS = readIntEnv("HEALTH_JOB_BUDGET_MS", 3 * 60 * 1000, 1_000);

/** 单进程内串行锁：避免同步与健检互相重叠 */
let running = false;
let runningSinceMs = 0;

/** 简单延时；jobs 内多处需要"每个模型之间等待固定间隔" */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 锁占用超时兜底：挂起的任务不应让调度永久停摆 */
const JOB_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export function isJobRunning(): boolean { return running; }
export async function withJobLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (running) {
    if (Date.now() - runningSinceMs <= JOB_LOCK_TIMEOUT_MS) {
      console.info("[scheduler] skip, another job is running");
      return null;
    }
    console.warn(`[scheduler] job lock held > ${JOB_LOCK_TIMEOUT_MS / 60000}min, force release`);
  }
  running = true;
  runningSinceMs = Date.now();
  try { return await fn(); } finally { running = false; runningSinceMs = 0; }
}

/** 任务开始：先落一条 running=true，前端可实时看到"执行中" */
export async function startRun(kind: "sync" | "health"): Promise<string | null> {
  try {
    const now = new Date();
    const row = await prisma.syncRun.create({
      data: { kind, running: true, startedAt: now, finishedAt: now },
      select: { id: true },
    });
    return row.id;
  } catch { return null; }
}

/** 任务结束：回填结果并置 running=false */
export async function finishRun(
  id: string | null,
  data: {
    startedAt: Date;
    ok?: boolean;
    addedCount?: number;
    updatedCount?: number;
    removedCount?: number;
    probeOk?: number;
    probeDown?: number;
    checkedCount?: number;
    errorMessage?: string | null;
  },
): Promise<void> {
  if (!id) return;
  try {
    await prisma.syncRun.update({
      where: { id },
      data: {
        running: false,
        ok: data.ok ?? true,
        startedAt: data.startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - data.startedAt.getTime(),
        addedCount: data.addedCount ?? 0,
        updatedCount: data.updatedCount ?? 0,
        removedCount: data.removedCount ?? 0,
        probeOk: data.probeOk ?? 0,
        probeDown: data.probeDown ?? 0,
        checkedCount: data.checkedCount ?? 0,
        errorMessage: data.errorMessage ?? null,
      },
    });
  } catch { /* 记录失败不阻断主流程 */ }
}

type RecordSyncRun = (data: {
  ok: boolean; addedCount?: number; updatedCount?: number; removedCount?: number;
  probeOk?: number; probeDown?: number; errorMessage?: string | null;
}) => Promise<void>;

async function runSyncJobInner(recordSyncRun: RecordSyncRun) {
  const settings = await getSettings();
  const filterKeywords = settings.filterKeywords;
  const blacklist = settings.blacklistModelIds;
  const keyRows = await prisma.apiKey.findMany({
    // 只按优先级/最久未用挑选；**不按 cooledUntil 过滤**（本项目不冻结 Key）
    where: { enabled: true },
    orderBy: [{ priority: "desc" }, { lastUsedAt: "asc" }],
  });
  const keyRow = keyRows[0];
  if (!keyRow) {
    await recordSyncRun({ ok: false, errorMessage: "no available api key" });
    throw new Error("no available api key");
  }
  // 并发度 = 可用 Key 个数（可用 JOB_CONCURRENCY 覆盖）
  const syncConcurrency = resolveConcurrency(keyRows.length);
  let apiKey: string;
  try { apiKey = decryptSecret(keyRow.key); } catch {
    await recordSyncRun({ ok: false, errorMessage: "failed to decrypt api key" });
    throw new Error("failed to decrypt api key");
  }
  const existing = await prisma.model.findMany({ select: { modelId: true } });
  const db: SyncDb = {
    existingIds: existing,
    create: (d) => prisma.model.create({ data: { ...d, lastSeenAt: new Date() } }).then(() => {}),
    touch: (modelId, remote) => {
      const c = classifyModel(modelId, filterKeywords, blacklist);
      return prisma.model.update({
        where: { modelId },
        data: {
          name: remote.name ?? undefined,
          description: remote.description ?? null,
          contextLength: remote.contextLength ?? null,
          supportsVision: remote.supportsVision ?? undefined,
          supportsTools: remote.supportsTools ?? undefined,
          supportsJson: remote.supportsJson ?? undefined,
          lastSeenAt: new Date(), isActive: true, removedAt: null,
          isSpecialized: c.specialized,
          specializedTags: serializeTags(c.tags),
        },
      }).then(() => {});
    },
    remove: (modelId) => prisma.model.update({ where: { modelId }, data: { isActive: false, removedAt: new Date() } }).then(() => {}),
  };
  let summary: { created: number; updated: number; removed: number };
  try {
    summary = await syncModels({
      baseUrl: keyRow.baseUrl, apiKey, db,
      filterKeywords: settings.filterKeywords, blacklist: settings.blacklistModelIds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 保护性中止（空清单 / 大规模下线）的消息已完整说明原因，
    // 不要再套上 "fetch model list failed"（会被误读成网络问题）
    await recordSyncRun({
      ok: false,
      errorMessage: msg.startsWith("aborted:") ? msg : `fetch model list failed: ${msg}`,
    });
    throw e;
  }
  await prisma.apiKey.update({ where: { id: keyRow.id }, data: { lastUsedAt: new Date() } });
  const toProbe = await prisma.model.findMany({
    where: { isActive: true, isSpecialized: false },
    select: { modelId: true },
  });
  let probeOk = 0;
  let probeDown = 0;
  // 按"可用 Key 个数"分批并发探测（批内并发、批间串行），
  // 批间等待 JOB_INTERVAL_MS（默认 2s），避免连续请求打满上游 Worker 配额触发 ResourceExhausted。
  const probeResults = await runInBatches(toProbe, syncConcurrency, JOB_INTERVAL_MS, async (m) => {
    let ok = false;
    let code: number | null = null;
    let ms: number | null = null;
    let error: string | null = null;
    try {
      const r = await probeModelAvailability(keyRow.baseUrl, apiKey, m.modelId);
      ok = r.ok;
      code = r.code;
      ms = r.ms;
      error = r.error;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // 全量可用性检查成功 → 清零连续超时计数并**恢复可用**（lastProbeOk=true）；
    // 这也是"健检连续超时被标记为不可用"之后的唯一恢复路径。
    await prisma.model.update({
      where: { modelId: m.modelId },
      data: {
        lastProbeAt: new Date(), lastProbeOk: ok, lastProbeCode: code,
        lastProbeMs: ms, lastProbeError: ok ? null : error,
        ...(ok ? { consecutiveTimeouts: 0, downReason: null } : {}),
      },
    });
    return ok;
  });
  for (const ok of probeResults) {
    if (ok) probeOk++;
    else probeDown++;
  }
  await recordSyncRun({
    ok: true,
    addedCount: summary.created,
    updatedCount: summary.updated,
    removedCount: summary.removed,
    probeOk,
    probeDown,
  });
  return { ...summary, probed: { ok: probeOk, down: probeDown } };
}

/**
 * 收尾守卫：保证 `SyncRun` **一定**被置为结束。
 *
 * 没有它时，主体里任何一处未捕获异常（DB 抖动、`prisma.model.update` 失败、
 * `getSettings()` 抛错）都会让 `startRun` 建的那条记录**永久停在 running=true**，
 * 后台「最近同步」就一直显示"执行中"，变成僵尸记录。
 * 任务锁本身没问题（`withJobLock` 有 finally 兜底），受影响的只是运行记录与展示。
 */
export async function runSyncJob() {
  const startedAt = new Date();
  const runId = await startRun("sync");
  let recorded = false;
  const recordSyncRun: RecordSyncRun = async (data) => {
    recorded = true;
    await finishRun(runId, { startedAt, ...data });
  };
  try {
    return await runSyncJobInner(recordSyncRun);
  } catch (e) {
    if (!recorded) {
      await recordSyncRun({ ok: false, errorMessage: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
}

type FinishHealthRun = (data: {
  ok?: boolean; checkedCount?: number; errorMessage?: string | null;
}) => Promise<void>;

async function runHealthJobInner(finishHealthRun: FinishHealthRun) {
  const settings = await getSettings();
  const [models, cases, keyRows] = await Promise.all([
    // 只检测"当前判定为可用"的模型（lastProbeOk=true）。
    // 注意：健检超时达阈值被标记不可用后，模型会自然退出本名单——
    // 这是**有意设计**：恢复只能经由「全量可用性检查」(runSyncJob 的同步探测)，
    // 那条路径探测成功会把 lastProbeOk 置回 true 并清零连续超时计数。
    // 也不再要求"今天探测过"，否则同步未跑的日子里健检会静默跳过。
    prisma.model.findMany({ where: { isActive: true, isSpecialized: false, lastProbeOk: true } }),
    prisma.testCase.findMany({ where: { enabled: true } }),
    prisma.apiKey.findMany({ where: { enabled: true } }),
  ]);
  if (models.length === 0 || cases.length === 0 || keyRows.length === 0) {
    const msg = models.length === 0
      ? "无可检测模型（需先执行同步并探测成功）"
      : cases.length === 0
        ? "无启用的测试用例"
        : "无启用的 API Key";
    await finishHealthRun({ ok: false, errorMessage: msg });
    return { checked: 0, reason: msg };
  }
  const keys: Array<KeyCandidateWithSecret & { baseUrl: string }> = [];
  for (const k of keyRows) {
    try {
      keys.push({ id: k.id, priority: k.priority, lastUsedAt: k.lastUsedAt, cooledUntil: k.cooledUntil, enabled: k.enabled, secret: decryptSecret(k.key), baseUrl: k.baseUrl });
    } catch { /* 解密失败的 Key 跳过 */ }
  }
  if (keys.length === 0) {
    await finishHealthRun({ ok: false, errorMessage: "API Key 解密失败" });
    return { checked: 0, reason: "API Key 解密失败" };
  }
  // 仅作为「选中 Key 未携带 baseUrl」时的回退值。真正发请求用的是**选中 Key 自己的** baseUrl
  // （见 runHealthCheckForModel），否则多 Key 配不同上游地址时会变成
  // 「A 的地址 + B 的 secret」→ 必然鉴权失败。
  const baseUrl = keys[0].baseUrl;
  let checked = 0;
  let skipped = 0;
  let failed = 0;
  let markedDown = 0;
  const errors: string[] = [];
  const budgetStartMs = Date.now();
  // 并发度 = 可用 Key 个数（可用 JOB_CONCURRENCY 覆盖）；
  // 一批内并发处理「模型 × 用例」，批间等待 JOB_INTERVAL_MS（默认 2s）。
  const healthConcurrency = resolveConcurrency(keys.length);
  const tasks = models.flatMap((m) => cases.map((c) => ({ m, c })));
  /**
   * 本轮每个模型的聚合结果，用于**按轮**统计连续超时。
   *
   * 不能在每个 task 里各自 `increment: 1` —— 启用了 N 个测试用例时，一轮全超时
   * 会让计数 +N，阈值被放大 N 倍（2 个用例 → 1.5 轮就下线），而设计语义是
   * 「连续 3 次**健康检查**（按轮）超时」。
   */
  const perModel = new Map<string, { timedOut: number; total: number; anySuccess: boolean }>();

  await runInBatches(tasks, healthConcurrency, JOB_INTERVAL_MS, async ({ m, c }) => {
    // 软截止：整轮超预算后不再发起新检测（已开始的允许跑完），
    // 防止单个慢模型把整轮拖到数分钟、占满任务锁导致下一轮被跳过。
    if (Date.now() - budgetStartMs >= HEALTH_JOB_BUDGET_MS) { skipped++; return; }
    let messages: Array<{ role: string; content: string }>;
    try {
      const parsed: unknown = JSON.parse(c.messages);
      if (!Array.isArray(parsed)) throw new Error("messages 不是数组");
      messages = parsed as Array<{ role: string; content: string }>;
    } catch (e) {
      // 用例数据损坏时必须**计数并记录原因**：旧实现两个 return 都不计数，
      // 整轮对所有模型的该用例静默跳过，任务仍报 ok=true，线上极难排查。
      failed++;
      if (errors.length < 3) {
        errors.push(`用例 ${c.name}(${c.id}) 的 messages 非法：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    // 单条检测异常不中断整轮（等价于原 allSettled 的隔离语义）
    try {
      const attempt = await runHealthCheckForModel({
        baseUrl, model: m.modelId, messages,
        maxTokens: c.maxTokens, temperature: c.temperature,
        reasoningEnabled: settings.defaultReasoning, keys,
        onKeyUsed: (id) => prisma.apiKey.update({
          // 只更新使用时间，**不写 cooledUntil**（本项目不冻结 Key）
          where: { id },
          data: { lastUsedAt: new Date() },
        }).then(() => {}),
      });
      await prisma.healthCheck.create({
        data: {
          modelId: m.id, apiKeyId: attempt.apiKeyId ?? keys[0].id, testCaseId: c.id,
          ttftMs: attempt.ttftMs, latencyMs: attempt.latencyMs,
          tokensPerSec: attempt.tokensPerSec, outputTokens: attempt.outputTokens,
          success: attempt.success, errorMessage: attempt.errorMessage ?? null,
        },
      });
      checked++;
      // 只记录本轮结果；计数统一在批次结束后按模型聚合（见下方 perModel 循环）
      const acc = perModel.get(m.id) ?? { timedOut: 0, total: 0, anySuccess: false };
      acc.total += 1;
      if (attempt.timedOut) acc.timedOut += 1;
      if (attempt.success) acc.anySuccess = true;
      perModel.set(m.id, acc);
    } catch (e) {
      failed++;
      if (errors.length < 3) errors.push(e instanceof Error ? e.message : String(e));
    }
  });

  // 按模型聚合后统一更新连续超时计数：
  // 本轮**全部用例都超时**才计一次，只要有任一用例成功即清零。
  // 注：用 Array.from(...) 而非直接 for...of —— 本项目 tsconfig 未设 target，
  // 默认 ES5 下 Map 迭代会报 TS2802。
  for (const [modelId, acc] of Array.from(perModel.entries())) {
    const allTimedOut = acc.total > 0 && acc.timedOut === acc.total;
    if (allTimedOut) {
      const after = await prisma.model.update({
        where: { id: modelId },
        data: { consecutiveTimeouts: { increment: 1 } },
        select: { consecutiveTimeouts: true },
      });
      if (after.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_THRESHOLD) {
        await prisma.model.update({
          where: { id: modelId },
          data: {
            lastProbeOk: false,
            // 用独立字段记录，避免污染同步探测的 lastProbeError 语义
            downReason: `连续 ${after.consecutiveTimeouts} 次健康检查超时，已标记不可用`,
          },
        });
        markedDown++;
      }
    } else if (acc.anySuccess) {
      // 有正常响应 → 连续超时计数归零
      await prisma.model.update({
        where: { id: modelId },
        data: { consecutiveTimeouts: 0 },
      });
    }
  }

  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed} 条检测异常：${errors.join(" | ")}`);
  if (markedDown > 0) notes.push(`${markedDown} 个模型因连续超时达 ${CONSECUTIVE_TIMEOUT_THRESHOLD} 次被标记不可用`);
  if (skipped > 0) notes.push(`${skipped} 条因超过单轮预算（${Math.round(HEALTH_JOB_BUDGET_MS / 1000)}s）未执行`);
  await finishHealthRun({
    ok: true,
    checkedCount: checked,
    errorMessage: notes.length > 0 ? notes.join("；") : null,
  });
  return { checked, failed, skipped, markedDown };
}

/** 同 `runSyncJob`：保证 SyncRun 不会卡在 running=true */
export async function runHealthJob() {
  const startedAt = new Date();
  const runId = await startRun("health");
  let recorded = false;
  const finishHealthRun: FinishHealthRun = async (data) => {
    recorded = true;
    await finishRun(runId, { startedAt, ...data });
  };
  try {
    return await runHealthJobInner(finishHealthRun);
  } catch (e) {
    if (!recorded) {
      await finishHealthRun({ ok: false, errorMessage: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
}
