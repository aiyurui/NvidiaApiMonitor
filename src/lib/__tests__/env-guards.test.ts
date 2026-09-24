import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 这些用例守的是「docker build 能不能过」这条底线。
 *
 * 背景：`next build` 会在 "Collecting page data" 阶段求值路由处理器。
 * 如果环境守卫在**构建期**抛错，抛的是模块级异常，build worker 会直接 exit(1)，
 * 而 Next 只会打印一行：
 *     Next.js build worker exited with code: 1 and signal: null
 * 真实原因被完全吞掉 —— 这正是容器构建时极难定位的那类故障。
 *
 * 因此约定：守卫只在**运行期**生效；构建期一律放过，
 * 由 deploy/docker-entrypoint.sh 与 deploy/release.sh 在启动前拦截。
 */
const VALID_DB = "file:/tmp/env-guard-test.db";

describe("生产环境变量守卫（构建期放过 / 运行期拦截）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("构建期：缺 NEXTAUTH_SECRET 也不得抛错", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("DATABASE_URL", VALID_DB);

    await expect(import("@/lib/auth")).resolves.toBeDefined();
  });

  it("构建期：缺 DATABASE_URL 时补占位值，不抛错", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("NEXTAUTH_SECRET", "x".repeat(32));
    vi.stubEnv("DATABASE_URL", "");

    await expect(import("@/lib/prisma")).resolves.toBeDefined();
    expect(process.env.DATABASE_URL).toBe("file:/tmp/next-build-placeholder.db");
  });

  it("运行期：NEXTAUTH_SECRET 过短必须抛错（早失败，别等登录才炸）", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    vi.stubEnv("NEXTAUTH_SECRET", "tooshort");
    vi.stubEnv("DATABASE_URL", VALID_DB);

    await expect(import("@/lib/auth")).rejects.toThrow(/NEXTAUTH_SECRET/);
  });
});
