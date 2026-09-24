import { afterEach, describe, expect, it, vi } from "vitest";
import { readIntEnv } from "@/lib/jobs";

/**
 * 守的是「compose 注入空字符串」这条坑。
 *
 * `environment: K: "${K:-}"` 在变量未配置时给容器传的是**空字符串**，
 * 而 `Number(process.env.K ?? 默认值)` 里的 `??` 只对 null/undefined 回退，
 * 于是 `Number("") === 0` —— 后果是 HEALTH_JOB_BUDGET_MS=0 让健检全部被跳过、
 * JOB_INTERVAL_MS=0 让批间节流失效、CONSECUTIVE_TIMEOUT_THRESHOLD=0 让模型一次超时就下线。
 */
afterEach(() => vi.unstubAllEnvs());

describe("readIntEnv", () => {
  it("未设置时用默认值", () => {
    expect(readIntEnv("NV_TEST_UNSET", 42)).toBe(42);
  });

  it("空串 / 全空白按未设置处理（而不是 0）", () => {
    vi.stubEnv("NV_TEST_EMPTY", "");
    expect(readIntEnv("NV_TEST_EMPTY", 42)).toBe(42);
    vi.stubEnv("NV_TEST_BLANK", "   ");
    expect(readIntEnv("NV_TEST_BLANK", 42)).toBe(42);
  });

  it("非法值回退到默认值", () => {
    vi.stubEnv("NV_TEST_NAN", "abc");
    expect(readIntEnv("NV_TEST_NAN", 42)).toBe(42);
    vi.stubEnv("NV_TEST_INF", "Infinity");
    expect(readIntEnv("NV_TEST_INF", 42)).toBe(42);
  });

  it("低于下限时回退到默认值", () => {
    vi.stubEnv("NV_TEST_NEG", "-1");
    expect(readIntEnv("NV_TEST_NEG", 42, 1)).toBe(42);
    vi.stubEnv("NV_TEST_ZERO_MIN1", "0");
    expect(readIntEnv("NV_TEST_ZERO_MIN1", 42, 1)).toBe(42);
  });

  it("合法值被采用，小数向下取整", () => {
    vi.stubEnv("NV_TEST_OK", "1500");
    expect(readIntEnv("NV_TEST_OK", 42)).toBe(1500);
    vi.stubEnv("NV_TEST_FLOAT", "12.7");
    expect(readIntEnv("NV_TEST_FLOAT", 42)).toBe(12);
  });

  it("min 为 0 时允许显式设 0（如 JOB_INTERVAL_MS 关闭批间节流）", () => {
    vi.stubEnv("NV_TEST_EXPLICIT_ZERO", "0");
    expect(readIntEnv("NV_TEST_EXPLICIT_ZERO", 2_000, 0)).toBe(0);
  });
});
