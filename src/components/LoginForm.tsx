"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchSessionUser, signInWithCredentials } from "@/lib/auth-client";

/** 只允许站内相对路径，避免开放重定向。
 *  注意必须同时拒绝反斜杠：浏览器会把 `/\evil.com` 规范化为 `//evil.com`（协议相对 URL），
 *  从而绕过「以 // 开头即拒绝」的判断跳到外站。 */
function safeTarget(raw: string | null): string {
  if (!raw) return "/admin";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/admin";
  return raw;
}

function LoginFormFields() {
  const params = useSearchParams();
  const target = safeTarget(params.get("callbackUrl"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 已登录时直接进后台，避免"登录成功却停在登录页"
  useEffect(() => {
    let alive = true;
    fetchSessionUser()
      .then((user) => {
        if (alive && user) window.location.replace(target);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [target]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signInWithCredentials({ email, password, callbackUrl: target });
      if (res.error) {
        setError("邮箱或密码错误");
        setLoading(false);
        return;
      }
      // 硬跳转而非 router.push：整页加载一定带上刚写入的 session cookie，
      // 规避客户端路由缓存与 middleware 之间的竞态（表现为登录成功却不跳转）
      window.location.replace(target);
    } catch {
      setError("网络异常，请重试");
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm items-center p-6">
      <form onSubmit={handleSubmit} className="card w-full">
        <div className="card-header">
          <span className="card-title">登录后台</span>
        </div>
        <div className="card-body flex flex-col gap-3">
          {error ? <p className="alert alert-error">{error}</p> : null}
          <label className="field">
            <span>邮箱</span>
            <input
              type="email"
              required
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              required
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              autoComplete="current-password"
            />
          </label>
          <button type="submit" disabled={loading} className="btn-primary mt-1">
            {loading ? "登录中…" : "登录"}
          </button>
          <p className="hint">登录失败 5 次会临时锁定。</p>
        </div>
      </form>
    </main>
  );
}

export default function LoginForm() {
  // /login 在 /admin 布局之外，这里单独包一层 Suspense 以满足 useSearchParams 的要求
  return (
    <Suspense fallback={<main className="p-6 text-sm text-neutral-500">加载中…</main>}>
      <LoginFormFields />
    </Suspense>
  );
}
