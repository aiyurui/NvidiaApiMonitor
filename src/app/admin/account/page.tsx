"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOutAndRedirect, useSessionUser } from "@/lib/auth-client";
import PageHeader from "@/components/admin/PageHeader";

export default function AccountPage() {
  const router = useRouter();
  const { user, loading } = useSessionUser();
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    if (user?.email) setEmail(user.email);
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (newPassword !== "" && newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/account", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          currentPassword,
          ...(newPassword !== "" ? { newPassword } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string; ok?: boolean; reloginRequired?: boolean;
      } | null;
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(json?.error ?? `保存失败（${res.status}）`);

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (json?.reloginRequired) {
        setOk("邮箱已更新，请使用新邮箱重新登录");
        setTimeout(() => {
          void signOutAndRedirect("/login");
        }, 1500);
      } else {
        setOk(newPassword !== "" ? "密码已更新，下次登录生效" : "已保存");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="账号设置"
        description="修改后台登录邮箱与密码；任何修改都需要验证当前密码"
      />

      <form onSubmit={handleSubmit} className="card max-w-xl">
        <div className="card-header">
          <span className="card-title">登录凭据</span>
          {loading ? <span className="hint">加载中…</span> : null}
        </div>
        <div className="card-body flex flex-col gap-4">
          {error && <p className="alert alert-error">{error}</p>}
          {ok && <p className="alert alert-ok">{ok}</p>}

          <label className="field">
            <span>登录邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              autoComplete="username"
            />
            <span className="hint">修改邮箱后需重新登录</span>
          </label>

          <label className="field">
            <span>当前密码（必填）</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="input"
              autoComplete="current-password"
              placeholder="用于确认身份"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span>新密码（留空表示不改）</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input"
                autoComplete="new-password"
              />
            </label>
            <label className="field">
              <span>确认新密码</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input"
                autoComplete="new-password"
              />
            </label>
          </div>
          <p className="hint">新密码至少 8 位，且不能与当前密码相同。</p>

          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEmail(user?.email ?? "");
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setError(null);
                setOk(null);
              }}
            >
              重置
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
