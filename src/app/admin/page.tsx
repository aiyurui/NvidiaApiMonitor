"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatsCards, { type StatsData } from "@/components/dashboard/StatsCards";
import PageHeader from "@/components/admin/PageHeader";

const LINKS: Array<{ href: string; title: string; desc: string }> = [
  { href: "/admin/api-keys", title: "API Keys", desc: "管理 NVIDIA 上游 Key，配置优先级与启用状态。" },
  { href: "/admin/test-cases", title: "测试用例", desc: "管理健康检测用的提示词用例与采样参数。" },
  { href: "/admin/models", title: "模型管理", desc: "查看模型状态，手动同步与触发单模型检测。" },
  { href: "/admin/scores", title: "评分管理", desc: "为模型手动打分，管理评分与备注。" },
  { href: "/admin/settings", title: "全局设置", desc: "配置检测并发、超时与定时任务等全局参数。" },
];

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/models/stats")
      .then((res) => {
        if (!res.ok) throw new Error(`请求失败（stats=${res.status}）`);
        return res.json();
      })
      .then((json: StatsData) => setStats(json))
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  return (
    <div>
      <PageHeader
        title="概览"
        description="与公开看板同口径的近 24 小时指标：可用率为「30 秒内有响应」的检测占比"
      />

      {error ? (
        <p className="alert alert-error">加载失败：{error}</p>
      ) : (
        <div className="flex flex-col gap-6">
          <StatsCards stats={stats} />
          <section>
            <h2 className="mb-3 text-sm font-semibold">快捷入口</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="card group p-4 transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{l.title}</span>
                    <span className="text-neutral-400 transition-transform group-hover:translate-x-0.5">
                      →
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">{l.desc}</p>
                </Link>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
