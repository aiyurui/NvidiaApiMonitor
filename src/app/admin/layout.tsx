"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAndRedirect, useSessionUser } from "@/lib/auth-client";

const NAV: Array<{ href: string; label: string; hint: string }> = [
  { href: "/admin", label: "概览", hint: "整体指标与快捷入口" },
  { href: "/admin/api-keys", label: "API Keys", hint: "上游密钥与轮换" },
  { href: "/admin/test-cases", label: "测试用例", hint: "健检提示词与采样参数" },
  { href: "/admin/models", label: "模型管理", hint: "同步、探测与单模型检测" },
  { href: "/admin/scores", label: "评分管理", hint: "手动打分与备注" },
  { href: "/admin/settings", label: "全局设置", hint: "调度间隔与过滤规则" },
  { href: "/admin/account", label: "账号设置", hint: "修改登录邮箱与密码" },
];

function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useSessionUser();
  const current = NAV.find((n) => n.href === pathname);
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="shrink-0 border-b bg-neutral-50 lg:sticky lg:top-0 lg:h-screen lg:w-56 lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center justify-between px-4 py-3 lg:block lg:px-4 lg:py-4">
          <div>
            <div className="text-sm font-semibold">NVIDIA 监控</div>
            <div className="text-xs text-neutral-500">后台管理</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:px-3">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative shrink-0 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-white font-medium text-black shadow-sm dark:bg-neutral-800 dark:text-white"
                    : "text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {active ? (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded bg-black dark:bg-white" />
                ) : null}
                <span className="block">{item.label}</span>
                <span className="hidden text-[11px] font-normal text-neutral-400 lg:block">
                  {item.hint}
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-white/90 px-4 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90 sm:px-6">
          <div className="min-w-0">
            <div className="truncate font-semibold">{current?.label ?? "后台管理"}</div>
            {current?.hint ? (
              <div className="hidden text-xs text-neutral-500 sm:block">{current.hint}</div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {!loading && user?.email && (
              <span className="hidden text-xs text-neutral-500 sm:inline">{user.email}</span>
            )}
            <Link href="/" className="btn-sm">
              返回首页
            </Link>
            <button
              type="button"
              onClick={() => {
                void signOutAndRedirect("/");
              }}
              className="btn-sm"
            >
              退出登录
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
