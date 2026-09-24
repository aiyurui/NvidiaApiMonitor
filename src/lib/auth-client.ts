"use client";

import { useEffect, useState } from "react";

/**
 * 客户端鉴权请求 —— 全部走**相对路径**。
 *
 * 为什么不用 `next-auth/react` 的 signIn / useSession / signOut：
 * 它把这几个 API 的基地址取自 `process.env.NEXTAUTH_URL`，而 Next.js
 * **只把 `NEXT_PUBLIC_*` 注入客户端**（webpack 的 process 垫片里 `env` 是空对象，
 * 见 next/dist/compiled/process/browser.js 的 `t.env={}`）。于是浏览器里
 * `NEXTAUTH_URL` 恒为 undefined，next-auth 回退到硬编码的
 * `http://localhost:3000`（next-auth/utils/parse-url.js 的 defaultUrl）。
 *
 * 后果：从别的机器访问 `http://192.168.x.x:3000` 时，登录/取会话/退出请求
 * 全部打到**访问者自己的** localhost:3000 上 —— 必然失败，且只能靠"把
 * NEXTAUTH_URL 填得跟访问地址一模一样"来绕过，这是部署里最容易错的一步。
 *
 * 改用相对路径后，基地址恒等于当前访问地址（同源），因此：
 *   - 不需要配置 NEXTAUTH_URL；
 *   - 换 IP / 换域名 / 加 HTTPS 反代都不用重建镜像；
 *   - 服务端同样不再依赖 NEXTAUTH_URL —— 见 compose 里的 AUTH_TRUST_HOST=1，
 *     next-auth 会按请求的 Host / X-Forwarded-Host 推导 origin。
 *
 * 这里刻意只依赖 next-auth 的 HTTP 端点契约（与它自家客户端发出的请求完全一致），
 * 不引入额外依赖。
 */

export type SessionUser = { email: string };

/**
 * 读取当前会话的小 hook，替代 `useSession()`。
 * `loading` 为 true 时表示还没拿到结果，避免把"未知"误判成"未登录"而闪跳登录页。
 */
export function useSessionUser(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetchSessionUser()
      .then((u) => {
        if (!alive) return;
        setUser(u);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { user, loading };
}

/** NextAuth 的 CSRF 保护：除 GET 外的鉴权端点都要求带上它。 */
async function readCsrfToken(): Promise<string> {
  const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`获取 CSRF 失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { csrfToken?: string };
  if (!data.csrfToken) throw new Error("获取 CSRF 失败：响应里没有 csrfToken");
  return data.csrfToken;
}

/** 当前登录用户；未登录返回 null。 */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  const res = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
  const email = data?.user?.email;
  return email ? { email } : null;
}

/**
 * 用邮箱 + 密码登录。
 * 返回值语义与 `next-auth/react` 的 `signIn(..., { redirect: false })` 对齐：
 * 失败时返回 `error`（如 "CredentialsSignin"），成功时 `error` 为 null。
 */
export async function signInWithCredentials(input: {
  email: string;
  password: string;
  callbackUrl?: string;
}): Promise<{ error: string | null }> {
  const csrfToken = await readCsrfToken();
  const res = await fetch("/api/auth/callback/credentials", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: input.email,
      password: input.password,
      callbackUrl: input.callbackUrl ?? window.location.href,
      redirect: "false",
      csrfToken,
      json: "true",
    }),
  });

  const data = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!res.ok || !data?.url) return { error: "CredentialsSignin" };

  // 成功时 url 指向 callbackUrl；失败时指向 /api/auth/error?error=xxx
  const error = new URL(data.url, window.location.origin).searchParams.get("error");
  return { error };
}

/** 退出登录并整页跳转（默认回首页）。 */
export async function signOutAndRedirect(callbackUrl = "/"): Promise<void> {
  try {
    const csrfToken = await readCsrfToken();
    const res = await fetch("/api/auth/signout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, callbackUrl, json: "true" }),
    });
    const data = (await res.json().catch(() => null)) as { url?: string } | null;
    window.location.href = data?.url ?? callbackUrl;
  } catch {
    // 退出接口异常时也要让用户离开受保护页面
    window.location.href = callbackUrl;
  }
}
