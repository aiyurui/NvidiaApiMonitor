"use client";

import { useState } from "react";
import type { ParsedSettings } from "@/types";

export interface SettingsSubmit {
  syncIntervalHours: number;
  healthIntervalMin: number;
  defaultReasoning: boolean;
  filterKeywords: string[];
  blacklistModelIds: string[];
}

export default function SettingsForm({
  initial,
  saving,
  onSubmit,
}: {
  initial: ParsedSettings;
  saving: boolean;
  onSubmit: (values: SettingsSubmit) => void | Promise<void>;
}) {
  const [syncHours, setSyncHours] = useState(String(initial.syncIntervalHours));
  const [healthMin, setHealthMin] = useState(String(initial.healthIntervalMin));
  const [defaultReasoning, setDefaultReasoning] = useState(initial.defaultReasoning);
  const [filterText, setFilterText] = useState(initial.filterKeywords.join(", "));
  const [blacklistText, setBlacklistText] = useState(initial.blacklistModelIds.join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: Record<string, string> = {};

    const syncVal = Number(syncHours);
    if (syncHours.trim() === "" || !Number.isFinite(syncVal) || !Number.isInteger(syncVal) || syncVal < 1) {
      nextErrors.syncIntervalHours = "同步间隔必须为整数且 ≥1（小时）";
    }

    const healthVal = Number(healthMin);
    if (healthMin.trim() === "" || !Number.isFinite(healthVal) || !Number.isInteger(healthVal) || healthVal < 5) {
      nextErrors.healthIntervalMin = "健检间隔必须为整数且 ≥5（分钟）";
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    onSubmit({
      syncIntervalHours: Number(syncHours),
      healthIntervalMin: Number(healthMin),
      defaultReasoning,
      filterKeywords: filterText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      blacklistModelIds: blacklistText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <div className="card-header">
        <span className="card-title">调度与过滤</span>
      </div>
      <div className="card-body flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field">
              <span>同步间隔（小时，≥1）</span>
              <input
                type="number"
                min={1}
                step={1}
                value={syncHours}
                onChange={(e) => setSyncHours(e.target.value)}
                className="input"
              />
            </label>
            {errors.syncIntervalHours && (
              <p className="mt-1 text-xs text-red-600">{errors.syncIntervalHours}</p>
            )}
          </div>
          <div>
            <label className="field">
              <span>健检间隔（分钟，≥5）</span>
              <input
                type="number"
                min={5}
                step={1}
                value={healthMin}
                onChange={(e) => setHealthMin(e.target.value)}
                className="input"
              />
            </label>
            {errors.healthIntervalMin && (
              <p className="mt-1 text-xs text-red-600">{errors.healthIntervalMin}</p>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={defaultReasoning}
            onChange={(e) => setDefaultReasoning(e.target.checked)}
          />
          默认开启推理
          <span className="hint">默认关闭；开启后健检请求将携带推理参数</span>
        </label>

        <label className="field">
          <span>过滤关键词（逗号分隔）</span>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="safety, moderation, guard"
            className="input"
          />
          <span className="hint">命中关键词的模型标记为「专用」，不参与看板统计与健检</span>
        </label>

        <label className="field">
          <span>黑名单模型 ID（每行一个）</span>
          <textarea
            value={blacklistText}
            onChange={(e) => setBlacklistText(e.target.value)}
            rows={4}
            placeholder={"model-id-1\nmodel-id-2"}
            className="input font-mono"
          />
        </label>

        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </form>
  );
}
