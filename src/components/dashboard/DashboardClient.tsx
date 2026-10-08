"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import StatsCards, { type StatsData } from "@/components/dashboard/StatsCards";
import ModelTable, {
  type ModelRow,
  type SortKey,
  type SortOrder,
} from "@/components/dashboard/ModelTable";

export default function DashboardClient() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ok");
  const [minScore, setMinScore] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 轮询/筛选并发竞态：递增 requestId，过期响应丢弃。
  // 选择 requestId 而非 AbortController——fetchData 内含两次 fetch 的 Promise.all，
  // 逐个 abort 接线繁琐，而“只取最新”语义用计数器即可满足。
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    params.set("sort", sort);
    params.set("order", order);
    const [statsRes, modelsRes] = await Promise.all([
      fetch("/api/models/stats"),
      fetch(`/api/models?${params.toString()}`),
    ]);
    // 入口密码中途启用/变更后，服务端包装只拦「导航」，拦不到已挂载页面的轮询；
    // 轮询收到 401 说明当前访问未解锁，硬跳转回验证页。
    if (statsRes.status === 401 || modelsRes.status === 401) {
      window.location.replace("/entry");
      throw new Error("需要入口密码");
    }
    if (!statsRes.ok || !modelsRes.ok) {
      throw new Error(`请求失败（stats=${statsRes.status}, models=${modelsRes.status}）`);
    }
    const statsJson = (await statsRes.json()) as StatsData;
    const modelsJson = (await modelsRes.json()) as { data: ModelRow[] };
    return { statsJson, modelsJson };
  }, [statusFilter, sort, order]);

  const load = useCallback(async () => {
    const myId = ++requestIdRef.current;
    try {
      setError(null);
      const { statsJson, modelsJson } = await fetchData();
      if (myId !== requestIdRef.current) return;
      setStats(statsJson);
      setRows(modelsJson.data);
    } catch (e) {
      if (myId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (myId === requestIdRef.current) setLoading(false);
    }
  }, [fetchData]);

  // 仅在首次挂载时展示整页 loading。切换排序/筛选时保留旧数据直到新结果返回，
  // 否则每点一次列头都会把整个 <main> 卸载重建 → 整页闪白。
  const firstLoadRef = useRef(true);
  useEffect(() => {
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      setLoading(true);
    }
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleSortChange = (s: SortKey, o: SortOrder) => {
    setSort(s);
    setOrder(o);
  };

  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="mx-auto min-h-screen max-w-7xl p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">NVIDIA 模型可用性监控</h1>
          <p className="mt-0.5 text-xs text-neutral-500">
            可用率 = 近 24 小时内「30 秒内有响应」的检测占比 · 每 30 秒自动刷新
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="text-xs text-neutral-500"
            title="最近一次全量健康检测完成时间；括号内为今日健检轮数"
          >
            最近健检：
            {stats?.lastHealthRunAt ? new Date(stats.lastHealthRunAt).toLocaleString() : "—"}
            {typeof stats?.healthRunsToday === "number"
              ? `（今日 ${stats.healthRunsToday} 次）`
              : ""}
          </span>
          <span className="text-xs text-neutral-500">
            最后同步：{stats?.lastSyncAt ? new Date(stats.lastSyncAt).toLocaleString() : "—"}
          </span>
          <Link
            href="/admin"
            className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            后台管理
          </Link>
        </div>
      </header>

      {loading ? (
        <p className="text-neutral-500">加载中…</p>
      ) : error ? (
        <div className="rounded border border-red-300 bg-red-50 p-4">
          <p className="text-sm text-red-700">加载失败：{error}</p>
          <button
            type="button"
            className="mt-2 rounded border px-3 py-1 text-sm"
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            重试
          </button>
        </div>
      ) : (
        <main className="flex flex-col gap-4">
          <StatsCards stats={stats} />
          <ModelTable
            rows={rows}
            sort={sort}
            order={order}
            onSortChange={handleSortChange}
            expandedId={expandedId}
            onToggleExpand={handleToggleExpand}
            statusFilter={statusFilter}
            minScore={minScore}
            onStatusChange={setStatusFilter}
            onMinScoreChange={setMinScore}
          />
        </main>
      )}
    </div>
  );
}
