import { describe, expect, it } from "vitest";
import { buildIntervalMs } from "../scheduler";

describe("buildIntervalMs", () => {
  it("按小时/分钟精确换算为毫秒", () => {
    expect(buildIntervalMs(6, 30)).toEqual({
      syncIntervalMs: 6 * 3_600_000,
      healthIntervalMs: 30 * 60_000,
    });
  });

  it("非整除 60 的分钟数也精确生效（cron 的 */N 做不到）", () => {
    // 回归：旧实现用 `*/45 * * * *`，实际只在 :00 / :45 触发，间隔在 45/15 之间摆动
    expect(buildIntervalMs(5, 45).healthIntervalMs).toBe(45 * 60_000);
    // 回归：旧实现把 >=60 一律退化成每小时，设 90 分钟实际仍是 60 分钟
    expect(buildIntervalMs(5, 90).healthIntervalMs).toBe(90 * 60_000);
  });

  it("0 / 负数 / 小数按下限 1 兜底", () => {
    expect(buildIntervalMs(0, 0)).toEqual({
      syncIntervalMs: 3_600_000,
      healthIntervalMs: 60_000,
    });
    expect(buildIntervalMs(-3, -10)).toEqual({
      syncIntervalMs: 3_600_000,
      healthIntervalMs: 60_000,
    });
    expect(buildIntervalMs(2.9, 12.7)).toEqual({
      syncIntervalMs: 2 * 3_600_000,
      healthIntervalMs: 12 * 60_000,
    });
  });
});
