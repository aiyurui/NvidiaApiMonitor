import { beforeEach, describe, expect, it } from "vitest";
import { clearLoginFailures, isLoginBlocked, recordLoginFailure } from "../login-throttle";

describe("login-throttle", () => {
  beforeEach(() => {
    clearLoginFailures("a@example.com");
    clearLoginFailures("b@example.com");
  });

  it("5 次失败后 blocked", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure("a@example.com", now + i);
    expect(isLoginBlocked("a@example.com", now + 10)).toBe(true);
  });

  it("第 6 次前清零则放行", () => {
    const now = 2_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure("a@example.com", now + i);
    clearLoginFailures("a@example.com");
    expect(isLoginBlocked("a@example.com", now + 10)).toBe(false);
  });

  it("窗口过期后放行", () => {
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure("a@example.com", now + i);
    expect(isLoginBlocked("a@example.com", now + 10 * 60 * 1000 + 1000)).toBe(false);
  });

  it("多 email 隔离", () => {
    const now = 4_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure("a@example.com", now + i);
    expect(isLoginBlocked("a@example.com", now + 10)).toBe(true);
    expect(isLoginBlocked("b@example.com", now + 10)).toBe(false);
  });

  // 选择第二方案（轻量行为测试）：先灌 2005 个不同 email 各失败 1 次（触发有界逐出），
  // 再对全新 email 连 5 次失败应仍被 blocked，证明超限逐出后新 key 功能正常。
  it("有界：超限后新 email 仍可正常计数阻塞", () => {
    const now = 5_000_000;
    for (let i = 0; i < 2005; i++) recordLoginFailure(`bound${i}@example.com`, now);
    const target = "fresh-bounded@example.com";
    for (let i = 0; i < 5; i++) recordLoginFailure(target, now + i);
    expect(isLoginBlocked(target, now + 10)).toBe(true);
  });
});
