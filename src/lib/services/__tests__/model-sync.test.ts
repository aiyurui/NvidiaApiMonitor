import { describe, expect, it, vi } from "vitest";
import {
  reconcileModels, fetchRemoteModels, syncModels, probeModelAvailability,
  isProbedToday, assertSafeReconcile,
} from "../model-sync";

describe("reconcileModels", () => {
  it("区分新增/更新/消失", () => {
    const r = reconcileModels(
      [{ modelId: "keep/a" }, { modelId: "gone/b" }],
      [{ id: "keep/a" }, { id: "new/c" }],
    );
    expect(r.toCreate.map((m) => m.id)).toEqual(["new/c"]);
    expect(r.toUpdate.map((m) => m.id)).toEqual(["keep/a"]);
    expect(r.toRemove).toEqual(["gone/b"]);
  });
});

describe("fetchRemoteModels", () => {
  it("请求带超时信号（上游挂住不能无限阻塞同步任务）", async () => {
    let captured: RequestInit | undefined;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await fetchRemoteModels("https://x.test/v1", "k", fetchFn);
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it("超时给出可读的错误信息（而不是笼统的 network 错误）", async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    await expect(fetchRemoteModels("https://x.test/v1", "k", fetchFn)).rejects.toThrow(/list models timeout/);
  });

  it("请求 /models 并返回 data 数组", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m/1" }] }), { status: 200 }));
    const models = await fetchRemoteModels("https://x.test/v1", "k", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("https://x.test/v1/models", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }));
    expect(models).toEqual([{ id: "m/1" }]);
  });

  it("非 2xx 抛错", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(fetchRemoteModels("https://x.test/v1", "k", fetchFn)).rejects.toThrow("401");
  });

  it("data 缺失或非数组时抛错（防全量误删）", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(fetchRemoteModels("https://x.test/v1", "k", bad)).rejects.toThrow("invalid response");
    const arr = vi.fn(async () => new Response(JSON.stringify({ data: "oops" }), { status: 200 }));
    await expect(fetchRemoteModels("https://x.test/v1", "k", arr)).rejects.toThrow("invalid response");
  });
});

describe("syncModels", () => {
  it("新增入库并标记专用，消失软删除", async () => {
    const calls: string[] = [];
    const db = {
      existingIds: [{ modelId: "keep/a" }, { modelId: "gone/b" }],
      async create(data: Record<string, unknown>) { calls.push(`create:${data["modelId"]}:${data["isSpecialized"]}`); },
      async touch(id: string, remote: { id: string }) { calls.push(`touch:${id}:${remote.id}`); },
      async remove(id: string) { calls.push(`remove:${id}`); },
    };
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "keep/a" }, { id: "nvidia/guard-new" }] }), { status: 200 }));
    const summary = await syncModels({
      baseUrl: "https://x.test/v1", apiKey: "k", fetchFn, db,
      filterKeywords: ["guard"], blacklist: [],
    });
    expect(calls).toContain("create:nvidia/guard-new:true");
    expect(calls).toContain("touch:keep/a:keep/a");
    expect(calls).toContain("remove:gone/b");
    expect(summary).toEqual({ created: 1, updated: 1, removed: 1 });
  });
});
/** 构造一个带 SSE 流式 body 的响应（探测现在按首字节判定可用性） */
function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** 永不产出任何数据的流（模拟"接受连接但上游不干活"的模型） */
function silentResponse(status = 200): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue / close */ } });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

describe("probeModelAvailability", () => {
  it("收到首个数据块即判可用", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"h"}}]}\n\n`,
    ]));
    await expect(probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn))
      .resolves.toMatchObject({ ok: true, code: 200, error: null });
  });
  it("HTTP 200 但流内一个字节都没有 → 判不可用（黑洞模型）", async () => {
    const fetchFn = vi.fn(async () => silentResponse(200));
    const r = await probeModelAvailability(
      "https://x.test/v1", "k", "m/1", fetchFn, Date.now, 30,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timeout");
  });
  it("HTTP 200 但流立即关闭且无数据 → empty stream", async () => {
    const fetchFn = vi.fn(async () => sseResponse([]));
    const r = await probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("empty stream");
  });
  it("404 判不可用并带 http 错误码", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn))
      .resolves.toMatchObject({ ok: false, code: 404, error: "http 404" });
  });
  it("网络异常判不可用并标记 network", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("boom"); });
    await expect(probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn))
      .resolves.toMatchObject({ ok: false, code: null, error: "network: boom" });
  });
  it("超时单独标记 timeout", async () => {
    const fetchFn = vi.fn(async () => {
      const e = new Error("timed out"); e.name = "TimeoutError"; throw e;
    });
    await expect(probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn))
      .resolves.toMatchObject({ ok: false, code: null });
    const r = await probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn);
    expect(r.error).toContain("timeout");
  });
  it("记录探测耗时", async () => {
    const fetchFn = vi.fn(async () => sseResponse([`data: {"choices":[{"delta":{"content":"h"}}]}\n\n`]));
    let t = 0;
    const r = await probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn, () => (t += 150));
    expect(r.ms).toBeGreaterThan(0);
  });
  it("探测请求使用流式（stream:true）", async () => {
    let captured: RequestInit | undefined;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      captured = init;
      expect(url).toBe("https://x.test/v1/chat/completions");
      return sseResponse([`data: {"choices":[{"delta":{"content":"h"}}]}\n\n`]);
    });
    await probeModelAvailability("https://x.test/v1", "k", "m/1", fetchFn);
    expect(JSON.parse(String(captured?.body))).toMatchObject({ stream: true, max_tokens: 1 });
  });
});
describe("isProbedToday", () => {
  it("今/昨/null 三态", () => {
    const now = new Date("2026-09-21T10:00:00");
    expect(isProbedToday(new Date("2026-09-21T08:00:00"), now)).toBe(true);
    expect(isProbedToday(new Date("2026-09-20T23:00:00"), now)).toBe(false);
    expect(isProbedToday(null, now)).toBe(false);
  });
});

describe("同步的破坏性保护（上游返回空/残缺清单）", () => {
  const okFetch = (data: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }));

  const makeDb = (existing: string[]) => {
    const calls: string[] = [];
    return {
      calls,
      db: {
        existingIds: existing.map((modelId) => ({ modelId })),
        async create(d: Record<string, unknown>) { calls.push(`create:${String(d["modelId"])}`); },
        async touch(id: string) { calls.push(`touch:${id}`); },
        async remove(id: string) { calls.push(`remove:${id}`); },
      },
    };
  };

  it("assertSafeReconcile：本地为空时不拦（首次同步）", () => {
    expect(() => assertSafeReconcile(0, [], [])).not.toThrow();
  });

  it("assertSafeReconcile：远程空清单 + 本地有数据 → 抛错", () => {
    expect(() => assertSafeReconcile(3, [], ["a/b", "c/d", "e/f"])).toThrow(/refusing to wipe/);
  });

  it("assertSafeReconcile：远程清单与本地完全不重叠 → 抛错", () => {
    const remote = [{ id: "totally/new" }];
    expect(() => assertSafeReconcile(3, remote, ["a/b", "c/d", "e/f"])).toThrow(/refusing to wipe/);
  });

  it("assertSafeReconcile：只下线一部分 → 放行（部分下线可逆）", () => {
    const remote = [{ id: "a/b" }];
    expect(() => assertSafeReconcile(3, remote, ["c/d", "e/f"])).not.toThrow();
  });

  it("上游返回 200 + data: [] → 中止，且一个写操作都不发生", async () => {
    // 回归：上游限流/维护/权限变更时会返回 200 + 空数组，
    // 无保护时 reconcileModels 会把本地**全部**模型判为下线（看板瞬间清空）。
    const { db, calls } = makeDb(["a/b", "c/d", "e/f"]);
    await expect(
      syncModels({
        baseUrl: "https://x.test/v1", apiKey: "k", fetchFn: okFetch({ data: [] }),
        db, filterKeywords: [], blacklist: [],
      }),
    ).rejects.toThrow(/refusing to wipe/);
    expect(calls).toEqual([]);
  });

  it("上游清单与本地完全不重叠 → 中止，不误删", async () => {
    const { db, calls } = makeDb(["a/b", "c/d", "e/f"]);
    await expect(
      syncModels({
        baseUrl: "https://x.test/v1", apiKey: "k",
        fetchFn: okFetch({ data: [{ id: "totally/new" }] }), db, filterKeywords: [], blacklist: [],
      }),
    ).rejects.toThrow(/refusing to wipe/);
    expect(calls).toEqual([]);
  });

  it("正常的小比例下线不受影响", async () => {
    const { db, calls } = makeDb(["keep/a", "gone/b"]);
    const summary = await syncModels({
      baseUrl: "https://x.test/v1", apiKey: "k",
      fetchFn: okFetch({ data: [{ id: "keep/a" }] }), db, filterKeywords: [], blacklist: [],
    });
    expect(summary.removed).toBe(1);
    expect(calls).toContain("remove:gone/b");
  });

  it("本地为空时上游空清单也放行（首次同步的合法场景）", async () => {
    const { db } = makeDb([]);
    const summary = await syncModels({
      baseUrl: "https://x.test/v1", apiKey: "k",
      fetchFn: okFetch({ data: [] }), db, filterKeywords: [], blacklist: [],
    });
    expect(summary).toEqual({ created: 0, updated: 0, removed: 0 });
  });
});
