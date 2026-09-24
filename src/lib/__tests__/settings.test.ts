import { describe, expect, it } from "vitest";
import { parseSettings } from "../settings";

describe("parseSettings", () => {
  it("非法 JSON 字段回退默认值", () => {
    const s = parseSettings({
      id: "singleton",
      syncIntervalHours: 6, healthIntervalMin: 30, defaultReasoning: false,
      filterKeywords: "broken", blacklistModelIds: "[1,2]",
      scoringWeights: "{}",
      updatedAt: new Date(),
    });
    expect(s.filterKeywords).toContain("safety");
    expect(s.blacklistModelIds).toEqual([]);
    expect(s.scoringWeights.context).toBe(1);
  });

  it("合法值正常解析", () => {
    const s = parseSettings({
      id: "singleton",
      syncIntervalHours: 12, healthIntervalMin: 15, defaultReasoning: true,
      filterKeywords: "[\"x\"]", blacklistModelIds: "[\"a/b\"]",
      scoringWeights: "{\"context\":2}",
      updatedAt: new Date(),
    });
    expect(s.syncIntervalHours).toBe(12);
    expect(s.blacklistModelIds).toEqual(["a/b"]);
    expect(s.scoringWeights.context).toBe(2);
    expect(s.scoringWeights.vision).toBe(1);
  });
});
