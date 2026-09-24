import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

describe("crypto", () => {
  it("加密后解密能还原原文", () => {
    const enc = encryptSecret("nvapi-secret-123");
    expect(enc).not.toBe("nvapi-secret-123");
    expect(decryptSecret(enc)).toBe("nvapi-secret-123");
  });

  it("两次加密结果不同（随机 IV）", () => {
    expect(encryptSecret("abc")).not.toBe(encryptSecret("abc"));
  });

  it("ENCRYPTION_KEY 非法时抛错", () => {
    process.env.ENCRYPTION_KEY = "short";
    expect(() => encryptSecret("x")).toThrow("ENCRYPTION_KEY");
  });
});
