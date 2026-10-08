import { beforeEach, describe, expect, it } from "vitest";
import { signEntryToken, verifyEntryToken } from "../entry-token";
import { clearEntryFailures, isEntryBlocked, recordEntryFailure } from "../entry-throttle";

const SECRET = "test-secret-0123456789abcdef";
const HASH_PREFIX_A = "$2b$10$aaaa"; // 模拟 bcrypt 哈希前缀（改密码 → 前缀变）
const HASH_PREFIX_B = "$2b$10$bbbb";

describe("entry-token", () => {
  it("签名后可验证通过", async () => {
    const token = await signEntryToken(HASH_PREFIX_A, SECRET);
    expect(token.startsWith("v1.")).toBe(true);
    expect(await verifyEntryToken(token, HASH_PREFIX_A, SECRET)).toBe(true);
  });

  it("修改入口密码（哈希前缀变化）后旧令牌立即失效", async () => {
    const token = await signEntryToken(HASH_PREFIX_A, SECRET);
    expect(await verifyEntryToken(token, HASH_PREFIX_B, SECRET)).toBe(false);
  });

  it("密钥不同则验证失败", async () => {
    const token = await signEntryToken(HASH_PREFIX_A, SECRET);
    expect(await verifyEntryToken(token, HASH_PREFIX_A, "another-secret")).toBe(false);
  });

  it("垃圾输入不抛异常、一律拒绝", async () => {
    expect(await verifyEntryToken("", HASH_PREFIX_A, SECRET)).toBe(false);
    expect(await verifyEntryToken("v1.zzzz", HASH_PREFIX_A, SECRET)).toBe(false);
    expect(await verifyEntryToken("v2." + "a".repeat(64), HASH_PREFIX_A, SECRET)).toBe(false);
    expect(await verifyEntryToken("v1." + "g".repeat(64), HASH_PREFIX_A, SECRET)).toBe(false);
  });

  it("同前缀两次签名结果一致（HMAC 确定性）", async () => {
    const a = await signEntryToken(HASH_PREFIX_A, SECRET);
    const b = await signEntryToken(HASH_PREFIX_A, SECRET);
    expect(a).toBe(b);
  });
});

describe("entry-throttle", () => {
  beforeEach(() => {
    clearEntryFailures("1.2.3.4");
    clearEntryFailures("5.6.7.8");
  });

  it("5 次失败后 blocked", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordEntryFailure("1.2.3.4", now + i);
    expect(isEntryBlocked("1.2.3.4", now + 10)).toBe(true);
  });

  it("成功后清零则放行", () => {
    const now = 2_000_000;
    for (let i = 0; i < 5; i++) recordEntryFailure("1.2.3.4", now + i);
    clearEntryFailures("1.2.3.4");
    expect(isEntryBlocked("1.2.3.4", now + 10)).toBe(false);
  });

  it("窗口过期后放行", () => {
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) recordEntryFailure("1.2.3.4", now + i);
    expect(isEntryBlocked("1.2.3.4", now + 10 * 60 * 1000 + 1000)).toBe(false);
  });

  it("多 IP 隔离", () => {
    const now = 4_000_000;
    for (let i = 0; i < 5; i++) recordEntryFailure("1.2.3.4", now + i);
    expect(isEntryBlocked("1.2.3.4", now + 10)).toBe(true);
    expect(isEntryBlocked("5.6.7.8", now + 10)).toBe(false);
  });
});
