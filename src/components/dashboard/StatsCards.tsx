export interface StatsData {
  total: number;
  available: number;
  down: number;
  untested: number;
  availabilityRate: number | null;
  availabilityOk: number;
  availabilityTotal: number;
  avgTtftMs: number | null;
  avgTps: number | null;
  lastSyncAt: string | null;
  lastHealthRunAt?: string | null;
  lastHealthChecked?: number | null;
  healthChecksToday?: number;
  healthRunsToday?: number;
}

function fmtNum(v: number | null, digits = 0): string {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(digits);
}

function fmtRate(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

interface CardSpec {
  label: string;
  title?: string;
  value: string;
  hint?: string;
  /** 0~1，用于卡片底部进度条 */
  progress?: number | null;
  tone?: "default" | "danger";
}

export default function StatsCards({ stats }: { stats: StatsData | null }) {
  const rate = stats?.availabilityRate ?? null;
  const cards: CardSpec[] = [
    { label: "总模型", value: stats ? String(stats.total) : "—" },
    { label: "可用", value: stats ? String(stats.available) : "—" },
    { label: "不可用", value: stats ? String(stats.down) : "—", tone: "danger" },
    { label: "未测", value: stats ? String(stats.untested) : "—" },
    {
      label: "可用率",
      title: "近 24 小时检测通过率（30 秒内有任何响应即通过）",
      value: fmtRate(rate),
      hint: stats ? `${stats.availabilityOk}/${stats.availabilityTotal} 次通过` : "",
      progress: rate,
    },
    {
      label: "平均TTFT",
      title: "近 24 小时成功检测的首包时间均值（TTFT = Time To First Token）",
      value: `${fmtNum(stats?.avgTtftMs ?? null, 0)} ms`,
      hint: "首包时间",
    },
    {
      label: "平均TPS",
      title: "近 24 小时成功检测的每秒输出 token 均值",
      value: fmtNum(stats?.avgTps ?? null, 1),
      hint: "输出速度",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {cards.map((c) => (
        <div
          key={c.label}
          title={c.title}
          className="flex flex-col justify-between rounded-lg border bg-white p-3 shadow-sm dark:bg-neutral-900"
        >
          <div className="truncate text-xs text-neutral-500">{c.label}</div>
          <div
            className={`mt-1 text-xl font-semibold tabular-nums ${
              c.tone === "danger" && stats && stats.down > 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {c.value}
          </div>
          {/* 固定占位高度，保证 7 张卡片等高 */}
          <div className="mt-0.5 min-h-[14px] truncate text-[11px] text-neutral-400">
            {c.hint ?? ""}
          </div>
          {c.progress !== undefined ? (
            <div className="mt-2 h-1 w-full overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
              <div
                className={`h-full rounded ${
                  (c.progress ?? 0) >= 0.9
                    ? "bg-green-500"
                    : (c.progress ?? 0) >= 0.7
                      ? "bg-amber-500"
                      : "bg-red-500"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, (c.progress ?? 0) * 100))}%` }}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
