"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** 只允许站内相对路径，避免开放重定向（同 login 页，拒绝 // 与反斜杠） */
function safeTarget(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}

function EntryForm() {
  const params = useSearchParams();
  const target = safeTarget(params.get("next"));
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [probing, setProbing] = useState(true);
  const [loading, setLoading] = useState(false);

  // 已解锁（例如输过密码的访客再次点开 /entry 链接）则直接进目标页
  useEffect(() => {
    let alive = true;
    fetch("/api/models/stats")
      .then((r) => {
        if (alive && r.ok) window.location.replace(target);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/entry/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // 硬跳转而非 router.push：整页加载一定带上刚写入的 Cookie，
        // 规避客户端路由缓存导致「验证成功却没进入」的竞态（同 login 页的处理）
        window.location.replace(target);
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(json?.error ?? `验证失败（${res.status}）`);
      setLoading(false);
    } catch {
      setError("网络异常，请重试");
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm items-center p-6">
      {probing ? (
        <p className="w-full text-sm text-neutral-500">正在检查访问状态…</p>
      ) : (
        <form onSubmit={handleSubmit} className="card w-full">
          <div className="card-header">
            <span className="card-title">访问验证</span>
          </div>
          <div className="card-body flex flex-col gap-3">
            {error ? <p className="alert alert-error">{error}</p> : null}
            <label className="field">
              <span>入口密码</span>
              <input
                type="password"
                required
                placeholder="入口密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={loading} className="btn-primary mt-1">
              {loading ? "验证中…" : "进入"}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

export default function EntryPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-neutral-500">加载中…</main>}>
      <EntryForm />
    </Suspense>
  );
}
