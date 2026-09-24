import { describe, expect, it } from "vitest";
import { classifyModel, serializeTags, deserializeTags } from "../filter";

const KW = ["safety", "moderation", "guard", "filter", "content-safety", "llama-guard", "nemo-guard"];

describe("classifyModel", () => {
  it("命中关键字则为专用模型", () => {
    const r = classifyModel("nvidia/llama-3.1-nemotron-safety-guard", KW, []);
    expect(r.specialized).toBe(true);
    expect(r.tags).toContain("guard");
  });

  it("大小写不敏感", () => {
    expect(classifyModel("Org/Llama-Guard-4", KW, []).specialized).toBe(true);
  });

  it("黑名单精确命中（大小写不敏感）", () => {
    const r = classifyModel("meta/llama-4-scout", KW, ["META/llama-4-scout"]);
    expect(r.specialized).toBe(true);
    expect(r.tags).toContain("blacklist");
  });

  it("普通模型不标记", () => {
    const r = classifyModel("meta/llama-3.1-8b-instruct", KW, ["other/model"]);
    expect(r.specialized).toBe(false);
    expect(r.tags).toEqual([]);
  });
});

describe("tags serde", () => {
  it("序列化往返一致", () => {
    expect(deserializeTags(serializeTags(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("非法 JSON 返回空数组", () => {
    expect(deserializeTags("not-json")).toEqual([]);
  });
});
