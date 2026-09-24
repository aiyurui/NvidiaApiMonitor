import { beforeEach, describe, expect, it } from "vitest";
import { isKeyAvailable, markKeyBusy, markKeyIdle, selectNextKey, resetKeyRotation } from "../key-rotation";
import type { KeyCandidate } from "@/types";

const k = (p: Partial<KeyCandidate> & { id: string }): KeyCandidate => ({
  priority: 0, lastUsedAt: null, cooledUntil: null, enabled: true, ...p,
});

beforeEach(() => resetKeyRotation());

describe("isKeyAvailable", () => {
  it("仅看 enabled", () => {
    expect(isKeyAvailable(k({ id: "a", enabled: true }))).toBe(true);
    expect(isKeyAvailable(k({ id: "a", enabled: false }))).toBe(false);
  });

  it("cooledUntil 不再影响可用性（本项目不冻结 Key）", () => {
    // 历史遗留的冷却时间戳不影响判定，否则会级联掏空 Key 池
    const future = new Date("2099-01-01T00:00:00Z");
    expect(isKeyAvailable(k({ id: "a", cooledUntil: future }))).toBe(true);
    expect(isKeyAvailable(k({ id: "a", cooledUntil: future, enabled: false }))).toBe(false);
  });
});

describe("selectNextKey", () => {
  it("同优先级下严格轮询（含 lastUsedAt 相同的情况）", () => {
    // 关键回归：过去按 lastUsedAt 排序且不更新内存快照，
    // 导致优先级相同 + lastUsedAt 相同时永远选中同一个 Key。
    const keys = [k({ id: "a" }), k({ id: "b" }), k({ id: "c" })];
    const picked = [0, 1, 2, 3, 4, 5].map(() => selectNextKey(keys)?.id);
    expect(picked).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("优先级高者优先，且在高优先级池内轮询", () => {
    const keys = [
      k({ id: "low1", priority: 0 }),
      k({ id: "high1", priority: 10 }),
      k({ id: "high2", priority: 10 }),
    ];
    const picked = [0, 1, 2].map(() => selectNextKey(keys)?.id);
    expect(picked).toEqual(["high1", "high2", "high1"]);
  });

  it("禁用的 Key 不参与轮询", () => {
    const keys = [k({ id: "a" }), k({ id: "b", enabled: false }), k({ id: "c" })];
    const picked = [0, 1, 2].map(() => selectNextKey(keys)?.id);
    expect(picked).toEqual(["a", "c", "a"]);
  });

  it("处于冷却状态的 Key 仍会被选中", () => {
    const keys = [k({ id: "a", cooledUntil: new Date("2099-01-01T00:00:00Z") })];
    expect(selectNextKey(keys)?.id).toBe("a");
  });

  it("无可用返回 null", () => {
    expect(selectNextKey([k({ id: "a", enabled: false })])).toBeNull();
  });
});

describe("并发占用下的选择（避免 N 并发全打同一把 Key）", () => {
  const ks = () => [
    k({ id: "high", priority: 10 }),
    k({ id: "low1", priority: 0 }),
    k({ id: "low2", priority: 0 }),
  ];

  it("高优先级池被占用后溢出到次优先级池", () => {
    // 回归：旧实现只在高优先级池内轮询，而本项目不冻结 Key → 池永不耗尽，
    // 「并发度 = Key 个数」于是退化成 N 个请求打同一把 Key。
    const keys = ks();
    const picked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const key = selectNextKey(keys);
      expect(key).not.toBeNull();
      picked.push(key!.id);
      markKeyBusy(key!.id);
    }
    expect(picked).toEqual(["high", "low1", "low2"]);
  });

  it("释放后重新优先使用高优先级 Key", () => {
    const keys = ks();
    const first = selectNextKey(keys)!;
    expect(first.id).toBe("high");
    markKeyBusy(first.id);
    expect(selectNextKey(keys)!.id).not.toBe("high");
    markKeyIdle(first.id);
    expect(selectNextKey(keys)!.id).toBe("high");
  });

  it("所有 Key 都在使用中时复用最高优先级池（并发度 > Key 数）", () => {
    const keys = ks();
    keys.forEach((key) => markKeyBusy(key.id));
    expect(selectNextKey(keys)!.id).toBe("high");
  });
});
