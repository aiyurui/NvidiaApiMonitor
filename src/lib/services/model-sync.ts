import type { RemoteModel } from "@/types";
import { classifyModel, serializeTags } from "@/lib/services/filter";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReconcileResult {
  toCreate: RemoteModel[];
  toUpdate: RemoteModel[];
  toRemove: string[];
}

export function reconcileModels(
  existing: Array<{ modelId: string }>,
  remote: RemoteModel[],
): ReconcileResult {
  const remoteIds = new Set(remote.map((r) => r.id));
  const existingIds = new Set(existing.map((e) => e.modelId));
  return {
    toCreate: remote.filter((r) => !existingIds.has(r.id)),
    toUpdate: remote.filter((r) => existingIds.has(r.id)),
    toRemove: existing.map((e) => e.modelId).filter((id) => !remoteIds.has(id)),
  };
}

/**
 * 拉取远端模型清单的超时。
 * 不加超时的话，上游挂住（连接建立但不返回）会让同步任务**无限阻塞**：
 * `withJobLock` 的 30 分钟兜底只释放内存锁、并不会终止这个请求，
 * 于是同步任务既不结束也无法被重启。
 */
export const MODEL_LIST_TIMEOUT_MS = 30_000;

export async function fetchRemoteModels(baseUrl: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<RemoteModel[]> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`list models timeout after ${MODEL_LIST_TIMEOUT_MS}ms`);
    }
    throw e;
  }
  if (!res.ok) throw new Error(`list models failed: ${res.status}`);
  const body = (await res.json()) as { data?: RemoteModel[] };
  if (!Array.isArray(body.data)) throw new Error("list models failed: invalid response");
  return body.data;
}

export interface SyncDb {
  existingIds: Array<{ modelId: string }>;
  create: (data: {
    modelId: string; name: string; description: string | null;
    contextLength: number | null; supportsVision: boolean;
    supportsTools: boolean; supportsJson: boolean;
    isSpecialized: boolean; specializedTags: string;
  }) => Promise<void>;
  touch: (modelId: string, remote: RemoteModel) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
}

/**
 * 同步前的破坏性校验：**宁可中止这一轮，也不要把看板清空。**
 *
 * 两类上游异常的特征完全一致 —— 本次会把本地**全部**模型标记下线：
 *   1. 返回 HTTP 200 + **空清单**（限流 / 维护 / Key 权限变更时的典型表现）
 *   2. 返回一份与本地**完全不重叠**的清单（模型 ID 规则改了 / 可见范围变了）
 *
 * 这两类都**走不到** `fetchRemoteModels` 的失败分支（它是 200 + 合法 JSON），必须显式拦住。
 *
 * 为什么只拦「全量」而不设比例阈值：部分下线是**可逆**的 ——
 * 模型重回上游清单时 `touch` 会把它置回 `isActive=true`；比例阈值反而会在上游
 * 合法的大批量下线时误拦，且会一直拦下去。
 */
export function assertSafeReconcile(
  existingCount: number,
  remote: RemoteModel[],
  toRemove: string[],
): void {
  if (existingCount === 0) return; // 本地还没数据，不存在"误删"问题
  if (toRemove.length >= existingCount) {
    throw new Error(
      `aborted: this sync would remove ALL ${existingCount} local models ` +
      `(remote returned ${remote.length} models, ${toRemove.length} of them absent locally) — refusing to wipe the board`,
    );
  }
}

export async function syncModels(args: {
  baseUrl: string; apiKey: string; fetchFn?: FetchFn; db: SyncDb;
  filterKeywords: string[]; blacklist: string[];
}): Promise<{ created: number; updated: number; removed: number }> {
  const remote = await fetchRemoteModels(args.baseUrl, args.apiKey, args.fetchFn);
  const result = reconcileModels(args.db.existingIds, remote);
  assertSafeReconcile(args.db.existingIds.length, remote, result.toRemove);

  for (const m of result.toCreate) {
    const c = classifyModel(m.id, args.filterKeywords, args.blacklist);
    await args.db.create({
      modelId: m.id,
      name: m.name ?? m.id,
      description: m.description ?? null,
      contextLength: m.contextLength ?? null,
      supportsVision: m.supportsVision ?? false,
      supportsTools: m.supportsTools ?? false,
      supportsJson: m.supportsJson ?? false,
      isSpecialized: c.specialized,
      specializedTags: serializeTags(c.tags),
    });
  }
  for (const m of result.toUpdate) await args.db.touch(m.id, m);
  for (const id of result.toRemove) await args.db.remove(id);

  return { created: result.toCreate.length, updated: result.toUpdate.length, removed: result.toRemove.length };
}
/** 探测超时时间（同步阶段的单次模型探测）；与首字节窗口对齐为 30s */
export const PROBE_TIMEOUT_MS = 30_000;

/** 流式探测的可用性窗口：该时间内未收到任何数据即判不可用 */
export const PROBE_FIRST_BYTE_MS = 30_000;

export interface ProbeResult {
  ok: boolean;
  /** HTTP 状态码；请求未发出/未收到响应时为 null */
  code: number | null;
  /** 探测耗时 */
  ms: number;
  /** 失败原因：成功为 null，否则为 http xxx / timeout / network 描述 */
  error: string | null;
}

/**
 * 同步阶段的轻量可用性探测。
 *
 * 采用**流式 + 首字节判定**而非非流式：
 * - 非流式下 `max_tokens=1` 也要等上游跑完整个请求才回包，实测部分模型（如
 *   `openai/gpt-oss-20b`）会挂到 30s+ 甚至永不响应，而流式请求通常在 1s 内
 *   就能收到首个 chunk，既快又更贴近真实可用性。
 * - 只要在 `PROBE_FIRST_BYTE_MS` 内收到任意数据即判可用（"但凡有答复都算可用"），
 *   收到首个 chunk 后立即取消连接，不等待完整响应，避免慢模型占用探测轮次。
 */
export async function probeModelAvailability(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  fetchFn: FetchFn = fetch,
  nowMs: () => number = Date.now,
  firstByteTimeoutMs = PROBE_FIRST_BYTE_MS,
): Promise<ProbeResult> {
  const start = nowMs();
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, code: res.status, ms: nowMs() - start, error: `http ${res.status}` };
    }
    // HTTP 200 只代表网关接受，真正可用还要看有没有数据回来
    if (!res.body) {
      return { ok: false, code: res.status, ms: nowMs() - start, error: "empty response body" };
    }
    const reader = res.body.getReader();
    // 注意：race 里那个 setTimeout 必须在读取先返回时清掉，否则每探测一个模型
    // 都会残留一个最多 30s 的定时器（数百模型时会明显堆积）。
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    const firstByte = await Promise.race([
      reader.read().then((v) => ({ kind: "chunk" as const, v })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        firstByteTimer = setTimeout(() => resolve({ kind: "timeout" }), firstByteTimeoutMs);
      }),
    ]);
    if (firstByteTimer) clearTimeout(firstByteTimer);
    const ms = nowMs() - start;
    // 读到数据即认为有响应；流正常结束且一个字节都没给 = 上游"接受连接但不干活"
    const gotData = firstByte.kind === "chunk" && (firstByte.v.value?.length ?? 0) > 0;
    const closedNoData = firstByte.kind === "chunk" && firstByte.v.done;
    await reader.cancel().catch(() => {});
    if (gotData) {
      // 首个 chunk 到达即足够，主动断开，不再等待完整响应
      return { ok: true, code: res.status, ms, error: null };
    }
    if (closedNoData) {
      return { ok: false, code: res.status, ms, error: "empty stream" };
    }
    return {
      ok: false, code: res.status, ms,
      error: `timeout: no response within ${firstByteTimeoutMs}ms`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "";
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false, code: null, ms: nowMs() - start,
      error: isTimeout ? `timeout: no response within ${PROBE_TIMEOUT_MS}ms` : `network: ${msg}`,
    };
  } finally {
    clearTimeout(hardTimer);
  }
}
/** 探测结论的默认时效窗口（滚动，与自然日无关） */
export const PROBE_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * 探测结论是否仍在时效窗口内（滚动窗口，取代旧的「按自然日 isProbedToday」）。
 *
 * 为什么不用"今天"判定：自然日基准在 0 点整条跳变，昨天探测的全部模型会在
 * 过 0 点的瞬间集体过期（实测表现为"刚过 0 点可用模型清空，直到下次同步"，
 * 默认间隔下最长空窗 6 小时）。滚动窗口让结论在「最后一次探测 + validMs」时
 * 才过期：正常调度下探测最多只有同步间隔那么旧，永远有效；调度坏了才逐渐过期，
 * 且各模型按自己的探测时间错峰过期。
 */
export function isProbeFresh(
  lastProbeAt: Date | null,
  now = new Date(),
  validMs: number = PROBE_VALIDITY_MS,
): boolean {
  if (!lastProbeAt) return false;
  return now.getTime() - new Date(lastProbeAt).getTime() <= validMs;
}

/**
 * 由同步间隔推导时效窗口：max(24h, 同步间隔 + 2h)。
 * 默认 6h 间隔 → 24h 窗口；把间隔调大到 22h 以上时窗口随之放宽，
 * 保证「按配置正常调度」的探测永远不会被判过期。
 */
export function probeValidityMs(syncIntervalHours: number): number {
  const h = Number.isFinite(syncIntervalHours) && syncIntervalHours > 0 ? syncIntervalHours : 6;
  return Math.max(24, h + 2) * 3_600_000;
}
