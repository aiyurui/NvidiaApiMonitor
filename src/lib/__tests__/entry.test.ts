import { beforeEach, describe, expect, it } from "vitest";
import { signEntryToken, verifyEntryToken } from "../entry-token";
import {
  clearEntryFailures,
  clientKeyFromHeaders,
  isEntryBlocked,
  isEntryBlockedGlobal,
  recordEntryFailure,
  recordEntryFailureGlobal,
} from "../entry-throttle";

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
    clearEntryFailures("__global__");
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

  it("全局预算：伪造头轮换 IP 也封顶（20 次失败后任何来源都被拦）", () => {
    const now = 5_000_000;
    for (let i = 0; i < 20; i++) {
      recordEntryFailureGlobal(now + i); // 模拟 20 个不同"IP"各失败一次
    }
    expect(isEntryBlockedGlobal(now + 30)).toBe(true);
    // 新 IP 即使 per-IP 计数为 0，全局已锁
    expect(isEntryBlocked("9.9.9.9", now + 30)).toBe(false); // per-IP 未锁
    // 但路由层会先查全局 → 429；此处仅验证两层判定各自独立成立
  });
});

describe("clientKeyFromHeaders（限流键解析，防伪造）", () => {
  const get = (h: Record<string, string>) => (n: string) => h[n] ?? null;

  it("优先 X-Real-IP（我们 nginx 设置的可信头）", () => {
    expect(clientKeyFromHeaders(get({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBe("1.2.3.4");
  });

  it("无 X-Real-IP 时取 XFF 最后一个（反代追加的真实 IP），不是第一个", () => {
    // 第一个值是客户端自带的伪造头，取它等于让攻击者自己选限流键
    expect(clientKeyFromHeaders(get({ "x-forwarded-for": "spoofed-ip, 5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("单值 XFF（直连伪造）原样返回——由全局预算兜底", () => {
    expect(clientKeyFromHeaders(get({ "x-forwarded-for": "spoofed-ip" }))).toBe("spoofed-ip");
  });

  it("无任何头回退 local（本机直连）", () => {
    expect(clientKeyFromHeaders(get({}))).toBe("local");
  });

  it("空白/逗号容错", () => {
    expect(clientKeyFromHeaders(get({ "x-real-ip": "  " , "x-forwarded-for": " , 5.6.7.8 , " }))).toBe("5.6.7.8");
  });
});
