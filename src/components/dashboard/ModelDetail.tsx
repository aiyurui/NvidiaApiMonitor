import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { ModelRow } from "./ModelTable";

function statusText(status: ModelRow["status"]): string {
  if (status === "ok") return "🟢可用";
  if (status === "down") return "🔴不可用";
  return "⚪未测";
}

interface HistoryPoint {
  createdAt: string;
  success: boolean;
  ttftMs?: number | null;
  tokensPerSec: number | null;
}

export default function ModelDetail({ row }: { row: ModelRow }) {
  const items: { label: string; value: string }[] = [
    { label: "状态", value: statusText(row.status) },
    {
      label: "可用率 (24h)",
      value:
        row.availabilityRate === null || row.availabilityRate === undefined
          ? "—"
          : `${(row.availabilityRate * 100).toFixed(1)}%（${row.availabilityOk}/${row.availabilityTotal}）`,
    },
    {
      label: "TTFT (24h 均值)",
      value: row.ttftMs === null || row.ttftMs === undefined ? "—" : `${row.ttftMs} ms`,
    },
  ];
  items.push(
    {
      label: "TPS",
      value:
        row.tokensPerSec === null || row.tokensPerSec === undefined
          ? "—"
          : Number(row.tokensPerSec).toFixed(1),
    },
    { label: "模型评分", value: row.manualScore === null || row.manualScore === undefined ? "暂无评分" : `${row.manualScore} / 100` },
    {
      label: "最后检测",
      value: row.lastCheckedAt ? new Date(row.lastCheckedAt).toLocaleString() : "—",
    },
  );

  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const encoded = row.modelId.split("/").map(encodeURIComponent).join("/");
        const res = await fetch(`/api/models/${encoded}/history?range=${range}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setHistory(json.data ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [row.modelId, range]);

  const chartData = [...(history ?? [])].reverse().map((h) => ({
    t: new Date(h.createdAt).toLocaleString(),
    ttft: h.success ? h.ttftMs ?? null : null,
    tps: h.tokensPerSec,
  }));

  return (
    <div className="rounded border bg-white p-4 dark:bg-neutral-900">
      <div className="mb-2 break-all text-xs text-neutral-500">{row.modelId}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="rounded bg-neutral-50 p-2 dark:bg-neutral-800">
            <div className="text-xs text-neutral-500">{it.label}</div>
            <div className="mt-0.5 text-sm font-medium">{it.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">趋势</span>
          <button
            type="button"
            className={`rounded border px-2 py-0.5 text-xs ${range === "24h" ? "bg-neutral-900 text-white" : ""}`}
            onClick={() => setRange("24h")}
          >
            24h
          </button>
          <button
            type="button"
            className={`rounded border px-2 py-0.5 text-xs ${range === "7d" ? "bg-neutral-900 text-white" : ""}`}
            onClick={() => setRange("7d")}
          >
            7d
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-neutral-500">加载中…</p>
        ) : error ? (
          <p className="text-sm text-red-500">加载失败：{error}</p>
        ) : !history || history.length === 0 ? (
          <p className="text-sm text-neutral-500">暂无检测记录</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="ttft" name="首包 TTFT (ms)" dot={false} />
              <Line type="monotone" dataKey="tps" name="TPS" yAxisId="right" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
