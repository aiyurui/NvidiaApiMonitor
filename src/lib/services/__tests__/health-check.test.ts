import { describe, expect, it, vi } from "vitest";
import {
  AVAILABILITY_TIMEOUT_MS, buildChatRequest, computeTps,
  estimateTokens, readChatStream, runHealthCheckForModel,
} from "../health-check";

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** 永不写入也永不关闭的响应体，用来模拟模型挂起 */
function hangingResponse(): Response {
  const stream = new ReadableStream({ start() { /* hang */ } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

describe("buildChatRequest", () => {
  it("默认关闭推理时不带 reasoning 参数", () => {
    const body = buildChatRequest({
      model: "m/1",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50, temperature: 0.7, reasoningEnabled: false,
    });
    expect(body).toEqual({
      model: "m/1", messages: [{ role: "user", content: "hi" }],
      max_tokens: 50, temperature: 0.7, stream: true,
      stream_options: { include_usage: true },
    });
  });
});

describe("computeTps", () => {
  it("按首包后耗时计算", () => {
    expect(computeTps(20, 3000, 1000)).toBe(10);
  });

  it("零耗时不除零", () => {
    expect(computeTps(5, 100, 100)).toBeGreaterThan(0);
  });
});

describe("readChatStream", () => {
  it("解析增量文本与 usage", async () => {
    let t = 0;
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" world"}}],"usage":{"completion_tokens":8}}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const r = await readChatStream(res, () => (t += 100));
    expect(r.text).toBe("Hello world");
    expect(r.completionTokens).toBe(8);
    // 假时钟按调用计数：start(100) → 循环守卫(200) → 首包登记(300) → 首块内容(400)，故 ttft=300
    expect(r.ttftMs).toBe(300);
    expect(r.isSse).toBe(true);
    expect(r.available).toBe(true);
  });

  it("推理模型：正文落在 reasoning_content 时也计入文本（避免 outputTokens=0/TPS=0）", async () => {
    let t = 0;
    const res = sseResponse([
      `data: {"choices":[{"delta":{"reasoning_content":"We need"}}]}\n\n`,
      `data: {"choices":[{"delta":{"reasoning_content":" to respond."}}]}\n\n`,
      `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"completion_tokens":45}}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const r = await readChatStream(res, () => (t += 100));
    expect(r.text).toBe("We need to respond.");
    expect(r.completionTokens).toBe(45);
    expect(r.available).toBe(true);
    expect(r.streamError).toBeNull();
  });

  it("末尾 usage 事件未以空行结尾时仍不丢失（关键回归：曾导致 outputTokens=0/TPS=0）", async () => {
    let t = 0;
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`,
      // 最后一个事件没有 \n\n 结尾 —— 流式响应常见，旧实现会把它留在缓冲区丢弃
      `data: {"choices":[],"usage":{"completion_tokens":10}}\n`,
    ]);
    const r = await readChatStream(res, () => (t += 100));
    expect(r.text).toBe("Hi");
    expect(r.completionTokens).toBe(10);
  });

  it("整段响应单 chunk 且末尾无空行时仍不丢失", async () => {
    let t = 0;
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":10}}\n`,
    ]);
    const r = await readChatStream(res, () => (t += 100));
    expect(r.text).toBe("Hi");
    expect(r.completionTokens).toBe(10);
  });

  it("HTTP 200 但 SSE 负载为 error（ResourceExhausted）→ 记入 streamError", async () => {
    let t = 0;
    const res = sseResponse([
      `data: {"error":{"message":"ResourceExhausted: Worker local total request limit reached (16/16)","type":"internal_server_error","code":500}}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const r = await readChatStream(res, () => (t += 100));
    expect(r.text).toBe("");
    expect(r.completionTokens).toBe(0);
    expect(r.streamError).toContain("ResourceExhausted");
  });
});

describe("estimateTokens", () => {
  it("空文本估 0，非空至少 1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hi")).toBe(1);
  });

  it("中文按字计、英文约四字符一 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world")).toBe(3);
  });
});

describe("可用性判定（超时）", () => {
  it("可用性窗口内未收到任何数据 → 不可用且标记超时", async () => {
    let calls = 0;
    const now = () => { calls += 1; return calls * 50; };
    const r = await readChatStream(hangingResponse(), now, 100, 100_000);
    expect(r.available).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.isSse).toBe(false);
  });

  it("已收到首个数据后，即便总耗时超过可用性窗口仍判定可用", async () => {
    let calls = 0;
    const now = () => { calls += 1; return calls <= 3 ? calls * 100 : 1000 + calls * 5000; };
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" there"}}],"usage":{"completion_tokens":9}}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const r = await readChatStream(res, now, 30_000, 60_000);
    expect(r.available).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.completionTokens).toBe(9);
    expect(r.elapsedMs).toBeGreaterThan(30_000);
  });

  it("缺少 usage 时用文本估算 token，避免 TPS 为 0", async () => {
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hello world this is a long enough sentence"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const r = await readChatStream(res);
    expect(r.completionTokens).toBeGreaterThan(0);
    expect(computeTps(r.completionTokens, r.elapsedMs, r.ttftMs)).toBeGreaterThan(0);
  });
});

describe("readChatStream hardening", () => {
  it("兼容 CRLF 行尾", async () => {
    const res = sseResponse([
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n`,
      `data: [DONE]\r\n\r\n`,
    ]);
    const r = await readChatStream(res);
    expect(r.text).toBe("Hi");
    expect(r.isSse).toBe(true);
  });

  it("尾部无分隔符的残留事件仍解析", async () => {
    const res = sseResponse([`data: {"choices":[{"delta":{"content":"Yo"}}]}`]);
    const r = await readChatStream(res);
    expect(r.text).toBe("Yo");
  });

  it("空 body 抛错", async () => {
    await expect(readChatStream(new Response(null, { status: 200 }))).rejects.toThrow("empty response body");
  });
});

describe("runHealthCheckForModel", () => {
  const keys = () => [{ id: "k1", priority: 0, lastUsedAt: null, cooledUntil: null, enabled: true, secret: "s" }];

  it("用选中 Key 自己的 baseUrl（多上游时不能混用别人的地址）", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]);
    });
    const ks = [{ ...keys()[0], baseUrl: "https://a.test/v1" }];
    const r = await runHealthCheckForModel({
      baseUrl: "https://fallback.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn, sleepFn: async () => {},
    });
    expect(r.success).toBe(true);
    // 回归：旧实现固定用 args.baseUrl，会变成「A 的地址 + B 的 secret」
    expect(urls).toEqual(["https://a.test/v1/chat/completions"]);
  });

  it("选中 Key 未带 baseUrl 时回退到调用方给的 baseUrl", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, `data: [DONE]\n\n`]);
    });
    await runHealthCheckForModel({
      baseUrl: "https://fallback.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: keys(), fetchFn, sleepFn: async () => {},
    });
    expect(urls).toEqual(["https://fallback.test/v1/chat/completions"]);
  });

  it("404 快速失败且不重试", async () => {
    const fetchFn = vi.fn(async () => new Response("no such model", { status: 404 }));
    const ks = keys();
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn, sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("404");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("410 模型下线同样快速失败", async () => {
    const fetchFn = vi.fn(async () => new Response("gone", { status: 410 }));
    const ks = keys();
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn, sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("410");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("200 非 SSE 错误体判失败", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 200 }));
    const ks = keys();
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn, sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("non-SSE");
  });

  it("上游过载 → 3 秒退避重试，第 2 次成功则判可用", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) {
        return sseResponse([
          `data: {"error":{"message":"ResourceExhausted: Worker local total request limit reached (16/16)"}}\n\n`,
          `data: [DONE]\n\n`,
        ]);
      }
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"completion_tokens":7}}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    });
    const sleeps: number[] = [];
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: keys(), fetchFn,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });
    expect(r.success).toBe(true);
    expect(r.outputTokens).toBe(7);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // 过载后等 3 秒（上游通常几秒内自愈）
    expect(sleeps).toEqual([3000]);
  });

  it("过载重试时轮询到下一个 Key（不连用同一个）", async () => {
    const ks = [
      { id: "k1", priority: 0, lastUsedAt: null, cooledUntil: null, enabled: true, secret: "s1" },
      { id: "k2", priority: 0, lastUsedAt: null, cooledUntil: null, enabled: true, secret: "s2" },
      { id: "k3", priority: 0, lastUsedAt: null, cooledUntil: null, enabled: true, secret: "s3" },
    ];
    const usedSecrets: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      usedSecrets.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return sseResponse([
        `data: {"error":{"message":"Service temporarily overloaded"}}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    });
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn,
      sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(usedSecrets).toEqual(["Bearer s1", "Bearer s2", "Bearer s3"]);
    // 三次尝试用了三个不同的 Key
    expect(new Set(r.usedKeyIds).size).toBe(3);
  });

  it("上游过载持续 → 重试至上限后判失败，错误信息保留原始原因", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"error":{"message":"Service temporarily overloaded"}}\n\n`,
      `data: [DONE]\n\n`,
    ]));
    const sleeps: number[] = [];
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: keys(), fetchFn,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("Service temporarily overloaded");
    // 首次 + 2 次重试
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // 每次退避均为 3s
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("30s 内无任何响应判定为超时不可用", async () => {
    const fetchFn = vi.fn(async () => hangingResponse());
    const ks = keys();
    let t = 0;
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn,
      nowMs: () => (t += 500),
      availabilityTimeoutMs: 1000, totalTimeoutMs: 100_000,
      sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.errorMessage).toContain("timeout: no response within 1000ms");
    expect(r.latencyMs).toBeGreaterThan(0); // 失败也要记录真实耗时，而不是 0
  });

  it("fetch 抛 TimeoutError → 不重试（避免 3×超时）", async () => {
    const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchFn = vi.fn(async () => { throw timeoutErr; });
    const ks = keys();
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: ks, fetchFn, sleepFn: async () => {},
    });
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.errorMessage).toContain("timeout");
    // 只尝试一次：超时换 Key 重试只会让耗时翻倍（曾出现 3×60s=180s）
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("任何失败都不得写 cooledUntil（本项目不冻结 Key）", async () => {
    const scenarios = [
      async () => new Response("no", { status: 404 }),
      async () => sseResponse([`data: {"error":{"message":"ResourceExhausted"}}\n\n`, `data: [DONE]\n\n`]),
      async () => { const e = Object.assign(new Error("boom"), { name: "TimeoutError" }); throw e; },
    ];
    for (const fetchImpl of scenarios) {
      const ks = keys();
      await runHealthCheckForModel({
        baseUrl: "https://x.test/v1", model: "m/1",
        messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
        reasoningEnabled: false, keys: ks, fetchFn: vi.fn(fetchImpl),
        sleepFn: async () => {},
      });
      expect(ks[0].cooledUntil).toBeNull();
    }
  });

  it("有响应但整体超过 30s 仍判定可用", async () => {
    let t = 0;
    const nowMs = () => {
      t += 1;
      // 前 6 次调用毫秒级推进（保证首个块落在窗口内），之后按 10s 推进
      return t <= 6 ? t * 20 : 10_000 * t;
    };
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" there"}}],"usage":{"completion_tokens":9}}\n\n`,
      `data: [DONE]\n\n`,
    ]));
    const r = await runHealthCheckForModel({
      baseUrl: "https://x.test/v1", model: "m/1",
      messages: [{ role: "user", content: "hi" }], maxTokens: 50, temperature: 0.7,
      reasoningEnabled: false, keys: keys(), fetchFn, nowMs,
      availabilityTimeoutMs: AVAILABILITY_TIMEOUT_MS, totalTimeoutMs: 200_000,
    });
    expect(r.success).toBe(true);
    expect(r.availabilityMs).toBeGreaterThanOrEqual(0);
    expect(r.tokensPerSec).toBeGreaterThan(0);
  });
});


describe("并发/间隔/连续超时常量", () => {
  it("默认 3 分钟预算；并发默认跟随 Key 个数；批间隔默认 2s；超时阈值 3", async () => {
    const mod = await import("@/lib/jobs");
    expect(mod.HEALTH_JOB_BUDGET_MS).toBeGreaterThan(0);
    // 未设置 JOB_CONCURRENCY 时为 null（表示"跟随可用 Key 个数"）
    expect(mod.JOB_CONCURRENCY === null || typeof mod.JOB_CONCURRENCY === "number").toBe(true);
    expect(mod.JOB_INTERVAL_MS).toBe(2_000);
    expect(mod.CONSECUTIVE_TIMEOUT_THRESHOLD).toBe(3);
  });

  it("resolveConcurrency：无环境变量时取 Key 个数，至少为 1", async () => {
    const mod = await import("@/lib/jobs");
    if (mod.JOB_CONCURRENCY === null) {
      expect(mod.resolveConcurrency(4)).toBe(4);
      expect(mod.resolveConcurrency(1)).toBe(1);
    }
    // Key 数为 0 时兜底为 1，避免除零/零并发
    expect(mod.resolveConcurrency(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("runInBatches：批内并发、批间等待", () => {
  it("按批大小切分，结果顺序与输入一致（批内并发执行）", async () => {
    const { runInBatches } = await import("@/lib/jobs");
    const items = [1, 2, 3, 4, 5, 6, 7];
    let concurrentPeak = 0;
    let inFlight = 0;
    const result = await runInBatches(items, 3, 0, async (n) => {
      inFlight += 1;
      concurrentPeak = Math.max(concurrentPeak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    // 输入输出顺序一致
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
    // 批内并发：同一批 3 个同时在场（不串行等待）
    expect(concurrentPeak).toBe(3);
  });

  it("batchSize 大于元素数时只有一批（不产生批间等待）", async () => {
    const { runInBatches } = await import("@/lib/jobs");
    const t0 = Date.now();
    const r = await runInBatches([1, 2], 10, 5_000, async (x) => x);
    expect(r).toEqual([1, 2]);
    // 单批：不应等待 5 秒
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("空数组不产生任何 sleep", async () => {
    const { runInBatches } = await import("@/lib/jobs");
    const r = await runInBatches([], 3, 2_000, async (x: number) => x);
    expect(r).toEqual([]);
  });
});
