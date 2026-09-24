import type { FetchFn } from "@/lib/services/model-sync";
import { markKeyBusy, markKeyIdle, selectNextKey, type KeyCandidateWithSecret } from "@/lib/services/key-rotation";

export interface ChatMessage { role: string; content: string; }

/**
 * 可用性判定窗口：在该时间内模型返回**任意**数据即视为可用；
 * 一旦有响应，后续耗时不再纳入可用性判定（"但凡有答复，无论答复了多长时间，都为可用"）。
 */
export const AVAILABILITY_TIMEOUT_MS = 30_000;
/**
 * 单次健康检测的总体上限（含流读取），防止慢模型长期占用并发位。
 * 与可用性窗口同为 30s：既然 30s 内没有首字节就已判不可用，
 * 再等更久读完整流没有意义（黑洞模型只会白占 60s，拖垮整批）。
 */
export const TOTAL_TIMEOUT_MS = 30_000;

export function buildChatRequest(args: {
  model: string; messages: ChatMessage[]; maxTokens: number;
  temperature: number; reasoningEnabled: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (args.reasoningEnabled) body["reasoning"] = { enabled: true };
  return body;
}

export function computeTps(completionTokens: number, latencyMs: number, ttftMs: number): number {
  const secs = Math.max((latencyMs - ttftMs) / 1000, 0.001);
  return Math.round((completionTokens / secs) * 100) / 100;
}

/**
 * NVIDIA 部分模型不回传 usage（即使请求了 include_usage），
 * 此时 completion_tokens 为 0，直接算 TPS 会得到 0。这里做粗估兜底，
 * 保证"有输出"的模型不会显示 0 TPS。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    // CJK/日文假名按 ~1 token/字，其余按 ~4 字符/token
    tokens += /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 1 : 0.25;
  }
  return Math.max(1, Math.round(tokens));
}

export interface ChatStreamResult {
  /** 首个带内容的 delta 到达耗时；始终没有内容时退化为首个数据包耗时 */
  ttftMs: number;
  /** 首个数据包（任意 SSE data 行）到达耗时，-1 表示从未收到数据 */
  firstResponseMs: number;
  text: string;
  completionTokens: number;
  isSse: boolean;
  /** 是否在可用性窗口内收到过数据（= 可用性判定结果） */
  available: boolean;
  /** 是否因可用性窗口内无任何数据而中断 */
  timedOut: boolean;
  elapsedMs: number;
  /**
   * SSE 负载内携带的服务端错误（HTTP 可能仍是 200）。
   * 例：NVIDIA 在 Worker 满载时返回 `data: {"error":{"message":"ResourceExhausted: ..."}}`，
   * 此时既无 delta.content 也无 usage，若当成成功会导致 outputTokens=0 / TPS=0。
   */
  streamError: string | null;
}

export async function readChatStream(
  res: Response,
  now: () => number = Date.now,
  availabilityTimeoutMs = AVAILABILITY_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
): Promise<ChatStreamResult> {
  if (!res.body) throw new Error("empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const start = now();
  let buf = "";
  let ttftMs = -1;
  let firstResponseMs = -1;
  let text = "";
  let completionTokens = 0;
  let sawData = false;
  let timedOut = false;
  let streamError: string | null = null;

  const processPart = (part: string) => {
    for (const line of part.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      sawData = true;
      if (firstResponseMs < 0) firstResponseMs = now() - start;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
          usage?: { completion_tokens?: number };
          error?: { message?: string } | string;
        };
        // SSE 负载内的服务端错误（HTTP 可能仍为 200）：记下原因，供上层判定为失败
        if (json.error !== undefined) {
          const em = typeof json.error === "string"
            ? json.error
            : json.error?.message ?? JSON.stringify(json.error);
          if (!streamError) streamError = em;
          continue;
        }
        // 推理模型（如 nemotron-reasoning）：正文可能整体落在 reasoning_content，
        // 只读 content 会得到空文本 → outputTokens=0 → TPS=0。
        const delta = json.choices?.[0]?.delta;
        const piece = (delta?.content ?? "") + (delta?.reasoning_content ?? "");
        if (piece) {
          if (ttftMs < 0) ttftMs = now() - start;
          text += piece;
        }
        const ct = json.usage?.completion_tokens;
        if (typeof ct === "number") completionTokens = ct;
      } catch { /* 忽略半包 */ }
    }
  };

  for (;;) {
    const elapsed = now() - start;
    if (elapsed >= totalTimeoutMs) break;
    // 尚未收到任何数据且已超出可用性窗口：判定超时（不可用），提前结束
    if (firstResponseMs < 0 && elapsed >= availabilityTimeoutMs) { timedOut = true; break; }

    const remaining = firstResponseMs < 0
      ? Math.min(availabilityTimeoutMs - elapsed, totalTimeoutMs - elapsed)
      : totalTimeoutMs - elapsed;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const readPromise = reader.read();
    readPromise.then(() => {}, () => {}); // 超时后 abandon 掉的 read 可能 reject，避免 unhandled
    const raced = await Promise.race([
      readPromise.then((v) => ({ kind: "chunk" as const, v }), () => ({ kind: "closed" as const })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(remaining, 1));
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (raced.kind !== "chunk") {
      if (raced.kind === "timeout" && firstResponseMs < 0) timedOut = true;
      break;
    }
    const { done, value } = raced.v;
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) processPart(part);
  }
  if (buf.trim().length > 0) processPart(buf);
  // 提前中断（超时）时释放底层连接，避免挂起的流长期占用 socket
  try { await reader.cancel(); } catch { /* 已关闭则忽略 */ }

  // usage 缺失时用估算值兜底，避免"有输出但 TPS=0"
  if (completionTokens === 0 && text.length > 0) completionTokens = estimateTokens(text);

  const elapsedMs = now() - start;
  return {
    ttftMs: ttftMs >= 0 ? ttftMs : firstResponseMs >= 0 ? firstResponseMs : elapsedMs,
    firstResponseMs,
    text,
    completionTokens,
    isSse: sawData,
    available: firstResponseMs >= 0,
    timedOut,
    elapsedMs,
    streamError,
  };
}

export interface HealthAttempt {
  success: boolean; ttftMs: number; latencyMs: number;
  tokensPerSec: number; outputTokens: number; errorMessage?: string; apiKeyId?: string;
  /** 首次响应耗时，-1 表示超时未响应 */
  availabilityMs: number;
  /** 失败是否为"可用性窗口内无响应"超时 */
  timedOut: boolean;
  /** 本次检测按顺序用过的 Key id（用于验证轮询与重试换 Key） */
  usedKeyIds?: string[];
}

/** 4xx 快速失败码：模型侧问题，不重试 */
const FAST_FAIL_CODES = new Set([400, 404, 410, 422]);

/**
 * 上游过载（`ResourceExhausted` / `Service temporarily overloaded`）通常是
 * **Worker 本地配额瞬时占满**，几秒内即自愈；换 Key 无效（瓶颈在 Worker 而非 Key）。
 * 因此对这类失败做**短退避重试**，重试时轮询到下一个 Key，且**绝不冷却 Key**。
 */
export const OVERLOAD_RETRY_DELAYS_MS = [3_000, 3_000];

/** 判定错误文本是否属于"上游过载"（可重试） */
export function isOverloadError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /ResourceExhausted|Service temporarily overloaded|total request limit reached/i.test(msg);
}

export async function runHealthCheckForModel(args: {
  /**
   * 上游地址**回退值**：只有当选中的 Key 未携带自己的 baseUrl 时才用它。
   * 正常路径用 `key.baseUrl`，避免多 Key 指向不同上游时出现
   * 「A 的地址 + B 的 secret」→ 必然鉴权失败。
   */
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  reasoningEnabled: boolean;
  keys: KeyCandidateWithSecret[];
  fetchFn?: FetchFn;
  nowMs?: () => number;
  availabilityTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** 过载退避等待（测试可注入，避免真实 sleep） */
  sleepFn?: (ms: number) => Promise<void>;
  onKeyUsed?: (id: string, cooled: boolean) => Promise<void> | void;
}): Promise<HealthAttempt> {
  const fetchFn = args.fetchFn ?? fetch;
  const nowMs = args.nowMs ?? Date.now;
  const availabilityTimeoutMs = args.availabilityTimeoutMs ?? AVAILABILITY_TIMEOUT_MS;
  const totalTimeoutMs = args.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const sleep = args.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runStartMs = nowMs();

  // 本项目**不冻结任何 Key**：Key 不是失败源，冻结只会级联掏空 Key 池
  // （曾导致每轮固定 12 次 "no available api key"）。onKeyUsed 仅用于记录使用时间。
  const recordKeyUse = async (id: string) => {
    try { await args.onKeyUsed?.(id, false); } catch { /* 回调失败不污染主流程 */ }
  };

  /** 失败结果构造：latencyMs 记录真实耗时而非 0 */
  const fail = (keyId: string, latencyMs: number, errorMessage: string, timedOut: boolean): HealthAttempt => ({
    success: false, ttftMs: 0, latencyMs: Math.max(latencyMs, 0),
    tokensPerSec: 0, outputTokens: 0, errorMessage,
    apiKeyId: keyId, availabilityMs: -1, timedOut,
  });

  /** 单次尝试的结果：成功结果 / 需重试的过载 / 终态失败 */
  type AttemptOutcome =
    | { kind: "ok"; attempt: HealthAttempt }
    | { kind: "retry"; reason: string }
    | { kind: "fail"; attempt: HealthAttempt };

  const attemptOnce = async (key: KeyCandidateWithSecret, attemptNo: number): Promise<AttemptOutcome> => {
    const startedMs = nowMs();
    let stream: ChatStreamResult | null = null;
    try {
      // 用**选中 Key 自己的** baseUrl（回退到调用方给的 baseUrl，兼容测试）
      const endpoint = `${(key.baseUrl ?? args.baseUrl).replace(/\/$/, "")}/chat/completions`;
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildChatRequest({
          model: args.model, messages: args.messages,
          maxTokens: args.maxTokens, temperature: args.temperature,
          reasoningEnabled: args.reasoningEnabled,
        })),
        signal: AbortSignal.timeout(totalTimeoutMs),
      });
      if (FAST_FAIL_CODES.has(res.status)) {
        const errText = await res.text().catch(() => "");
        await recordKeyUse(key.id);
        return { kind: "fail", attempt: fail(key.id, nowMs() - startedMs, `http ${res.status} ${errText.slice(0, 200)}`.trim(), false) };
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      stream = await readChatStream(res, nowMs, availabilityTimeoutMs, totalTimeoutMs);

      // 模型侧失败：非 SSE 响应 / 可用性窗口内无任何数据（超时）
      if (!stream.isSse || !stream.available) {
        const noResponse = stream.timedOut || (!stream.isSse && stream.elapsedMs >= availabilityTimeoutMs);
        const reason = noResponse
          ? `timeout: no response within ${availabilityTimeoutMs}ms`
          : "non-SSE response";
        await recordKeyUse(key.id);
        return { kind: "fail", attempt: fail(key.id, Math.max(stream.elapsedMs, nowMs() - startedMs), reason, noResponse) };
      }
      // SSE 负载内报错（HTTP 200 + `data: {"error":...}`）
      if (stream.streamError) {
        await recordKeyUse(key.id);
        const msg = stream.streamError.slice(0, 200);
        // 上游过载 → 可重试（退避后重来），不冷却 Key
        if (isOverloadError(msg)) {
          return { kind: "retry", reason: `stream error: ${msg}` };
        }
        return { kind: "fail", attempt: fail(key.id, Math.max(stream.elapsedMs, nowMs() - startedMs), `stream error: ${msg}`, false) };
      }

      const latencyMs = nowMs() - startedMs;
      await recordKeyUse(key.id);
      return {
        kind: "ok",
        attempt: {
          success: true, ttftMs: stream.ttftMs, latencyMs,
          tokensPerSec: computeTps(stream.completionTokens, latencyMs, stream.ttftMs),
          outputTokens: stream.completionTokens, apiKeyId: key.id,
          availabilityMs: stream.firstResponseMs, timedOut: false,
        },
      };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const isTimeout = name === "TimeoutError" || name === "AbortError";
      // 超时：模型慢或上游拥塞，不重试（换 Key 重试仍是同样超时，只会让耗时翻 N 倍）
      if (isTimeout) {
        await recordKeyUse(key.id);
        return { kind: "fail", attempt: fail(key.id, nowMs() - startedMs, `timeout: no response within ${totalTimeoutMs}ms`, true) };
      }
      const msg = e instanceof Error ? e.message : String(e);
      // 网络/网关类异常：允许有限次重试，但**不冷却 Key**
      if (attemptNo < OVERLOAD_RETRY_DELAYS_MS.length + 1) {
        return { kind: "retry", reason: `network: ${msg}` };
      }
      await recordKeyUse(key.id);
      return { kind: "fail", attempt: fail(key.id, nowMs() - startedMs, `network: ${msg}`, stream?.timedOut ?? false) };
    }
  };

  // 总尝试次数 = 首次 + 过载退避重试次数
  const maxAttempts = OVERLOAD_RETRY_DELAYS_MS.length + 1;
  let lastError = "no available api key";
  const usedKeyIds: string[] = [];

  for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo++) {
    // selectNextKey 内部游标每次调用都会推进 → 重试时自动轮到**下一个 Key**，
    // 避免同一个 Key 连续重试（Key 轮询）。
    const key = selectNextKey(args.keys);
    if (!key) break;
    usedKeyIds.push(key.id);
    // 标记为「使用中」：并发运行时（并发度 = Key 个数）其他检测会优先选空闲 Key，
    // 而不是全部选中同一把（高优先级池只有 1 把时的典型症状）。
    markKeyBusy(key.id);
    const outcome = await attemptOnce(key, attemptNo).finally(() => markKeyIdle(key.id));
    if (outcome.kind === "ok" || outcome.kind === "fail") {
      return { ...outcome.attempt, usedKeyIds };
    }
    // 需重试：退避等待后换下一个 Key 再试
    lastError = outcome.reason;
    if (attemptNo < OVERLOAD_RETRY_DELAYS_MS.length) {
      await sleep(OVERLOAD_RETRY_DELAYS_MS[attemptNo]);
    }
  }

  // 全部尝试失败：记录真实总耗时而不是 0
  return {
    success: false, ttftMs: 0, latencyMs: Math.max(nowMs() - runStartMs, 0),
    tokensPerSec: 0, outputTokens: 0, errorMessage: lastError,
    availabilityMs: -1, timedOut: false, usedKeyIds,
  };
}
