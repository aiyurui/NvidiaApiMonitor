import { Fragment } from "react";
import ModelDetail from "./ModelDetail";

export interface ModelRow {
  id: string;
  modelId: string;
  name: string;
  contextLength: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsJson: boolean;
  status: "ok" | "down" | "untested";
  ttftMs: number | null;
  tokensPerSec: number | null;
  availabilityRate: number | null;
  availabilityOk: number;
  availabilityTotal: number;
  manualScore: number | null;
  lastCheckedAt: string | null;
}

export type SortKey = "score" | "availability" | "ttft" | "tps" | "updated";
export type SortOrder = "asc" | "desc";

interface ModelTableProps {
  rows: ModelRow[];
  sort: SortKey;
  order: SortOrder;
  onSortChange: (sort: SortKey, order: SortOrder) => void;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  statusFilter: string;
  minScore: string;
  onStatusChange: (v: string) => void;
  onMinScoreChange: (v: string) => void;
}

const SORT_COLUMNS: { key: SortKey; label: string; title: string; numeric?: boolean }[] = [
  { key: "score", label: "评分", title: "人工评分" },
  { key: "availability", label: "可用率", title: "近 24 小时检测通过率（30 秒内有任何响应即通过）" },
  {
    key: "ttft",
    label: "TTFT",
    title: "首包时间 Time To First Token（近 24 小时成功检测均值）",
    numeric: true,
  },
  { key: "tps", label: "TPS", title: "每秒输出 token 数（近 24 小时成功检测均值）", numeric: true },
  { key: "updated", label: "最后检测", title: "最近一次健康检查时间" },
];

const STATUS_STYLE: Record<ModelRow["status"], string> = {
  ok: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400",
  down: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400",
  untested: "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400",
};

function statusBadge(status: ModelRow["status"]): React.ReactNode {
  const text = status === "ok" ? "可用" : status === "down" ? "不可用" : "未测";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>
      {text}
    </span>
  );
}

function availabilityColor(rate: number): string {
  if (rate >= 0.9) return "text-green-700 dark:text-green-400";
  if (rate >= 0.7) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

export default function ModelTable({
  rows,
  sort,
  order,
  onSortChange,
  expandedId,
  onToggleExpand,
  statusFilter,
  minScore,
  onStatusChange,
  onMinScoreChange,
}: ModelTableProps) {
  const handleSortClick = (key: SortKey) => {
    if (key === sort) {
      onSortChange(key, order === "asc" ? "desc" : "asc");
    } else {
      onSortChange(key, "desc");
    }
  };

  const min = minScore === "" ? null : Number(minScore);
  const visibleRows =
    min === null || Number.isNaN(min)
      ? rows
      : rows.filter((r) => r.manualScore !== null && r.manualScore >= min);

  const sortArrow = (key: SortKey) => {
    if (key !== sort) return "";
    return order === "asc" ? " ▲" : " ▼";
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-white px-3 py-2 shadow-sm dark:bg-neutral-900">
        <span className="text-xs text-neutral-500">筛选</span>
        <label className="flex items-center gap-2 text-sm">
          状态
          <select
            className="rounded border px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => onStatusChange(e.target.value)}
          >
            <option value="">全部</option>
            <option value="ok">可用</option>
            <option value="down">不可用</option>
            <option value="untested">未测</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          最低评分
          <input
            type="number"
            min={0}
            className="w-20 rounded border px-2 py-1 text-sm"
            value={minScore}
            onChange={(e) => onMinScoreChange(e.target.value)}
            placeholder="≥0"
          />
        </label>
        <span className="ml-auto text-xs text-neutral-500">
          共 {visibleRows.length} 个模型
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <p className="rounded border bg-white p-8 text-center text-neutral-500">
          暂无模型数据，可前往后台同步
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm dark:bg-neutral-900">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b bg-neutral-50 text-left text-xs text-neutral-500 dark:bg-neutral-800">
                <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">模型</th>
                {SORT_COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    title={c.title}
                    className={`whitespace-nowrap px-3 py-2 font-medium ${c.numeric ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      className="font-semibold text-neutral-700 hover:underline dark:text-neutral-200"
                      onClick={() => handleSortClick(c.key)}
                    >
                      {c.label}
                      {sortArrow(c.key)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <Fragment key={row.id}>
                  <tr
                    className="cursor-pointer border-b last:border-b-0 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    onClick={() => onToggleExpand(row.id)}
                  >
                    <td className="whitespace-nowrap px-3 py-2">{statusBadge(row.status)}</td>
                    <td className="max-w-[280px] px-3 py-2">
                      <div className="truncate font-medium" title={row.name}>
                        {row.name}
                      </div>
                      <div className="truncate font-mono text-xs text-neutral-500" title={row.modelId}>
                        {row.modelId}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.manualScore === null || row.manualScore === undefined ? (
                        <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-500">
                          待评分
                        </span>
                      ) : (
                        <span>{row.manualScore}</span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${row.availabilityRate === null ? "text-neutral-400" : availabilityColor(row.availabilityRate)}`}
                      title={`近 24h ${row.availabilityOk}/${row.availabilityTotal} 次检测通过`}
                    >
                      {row.availabilityRate === null || row.availabilityRate === undefined
                        ? "—"
                        : `${(row.availabilityRate * 100).toFixed(1)}%`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.ttftMs === null || row.ttftMs === undefined ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        `${row.ttftMs} ms`
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.tokensPerSec === null || row.tokensPerSec === undefined ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        Number(row.tokensPerSec).toFixed(1)
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">
                      {row.lastCheckedAt ? new Date(row.lastCheckedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                  {expandedId === row.id ? (
                    <tr className="border-b bg-neutral-50 dark:bg-neutral-800">
                      <td colSpan={SORT_COLUMNS.length + 2} className="px-3 py-2">
                        <ModelDetail row={row} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
