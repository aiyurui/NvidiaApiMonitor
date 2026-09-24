"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/admin/PageHeader";

interface PendingRow {
  id: string;
  modelId: string;
  name: string;
  discoveredAt: string;
}

interface ScoredRow {
  modelId: string;
  name: string | null;
  isActive: boolean | null;
  isSpecialized: boolean | null;
  score: number;
  note: string | null;
  updatedAt: string;
}

interface Draft {
  score: string;
  note: string;
}

function encodeModelId(modelId: string): string {
  return modelId.split("/").map(encodeURIComponent).join("/");
}

export default function ScoresPage() {
  const router = useRouter();
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [scored, setScored] = useState<ScoredRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const [pendingRes, scoredRes] = await Promise.all([
        fetch("/api/admin/scores/pending"),
        fetch("/api/admin/scores"),
      ]);
      if (pendingRes.status === 401 || scoredRes.status === 401) {
        router.push("/login");
        return;
      }
      if (!pendingRes.ok || !scoredRes.ok) {
        throw new Error(`请求失败（pending=${pendingRes.status}, scores=${scoredRes.status}）`);
      }
      const pendingJson = (await pendingRes.json()) as { data: PendingRow[] };
      const scoredJson = (await scoredRes.json()) as { data: ScoredRow[] };
      setPending(pendingJson.data ?? []);
      const scoredRows = scoredJson.data ?? [];
      setScored(scoredRows);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const r of scoredRows) {
          if (!next[r.modelId]) {
            next[r.modelId] = { score: String(r.score), note: r.note ?? "" };
          }
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  function setDraft(modelId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [modelId]: { ...(prev[modelId] ?? { score: "", note: "" }), ...patch },
    }));
  }

  async function handleSave(modelId: string) {
    const draft = drafts[modelId] ?? { score: "", note: "" };
    const score = Number(draft.score);
    if (
      draft.score.trim() === "" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > 100
    ) {
      setRowErrors((prev) => ({ ...prev, [modelId]: "分数必须为 0–100 整数" }));
      return;
    }
    setSaving((prev) => ({ ...prev, [modelId]: true }));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const res = await fetch(`/api/admin/scores/${encodeModelId(modelId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, note: draft.note.trim() === "" ? null : draft.note }),
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `保存失败（${res.status}）`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [modelId]: e instanceof Error ? e.message : "保存失败" }));
    } finally {
      setSaving((prev) => ({ ...prev, [modelId]: false }));
    }
  }

  async function handleDelete(modelId: string) {
    if (!confirm("确定删除该评分吗？")) return;
    setSaving((prev) => ({ ...prev, [modelId]: true }));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const res = await fetch(`/api/admin/scores/${encodeModelId(modelId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `删除失败（${res.status}）`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [modelId]: e instanceof Error ? e.message : "删除失败" }));
    } finally {
      setSaving((prev) => ({ ...prev, [modelId]: false }));
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">加载中…</p>;
  if (error) return <p className="alert alert-error">加载失败：{error}</p>;

  return (
    <div>
      <PageHeader
        title="评分管理"
        description="0–100 手动打分，用于看板「评分」列排序；改动即时生效"
      />

      <div className="flex flex-col gap-6">
        <section>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">待评分模型</h2>
            <span className="badge badge-warn">{pending.length}</span>
          </div>
          {pending.length === 0 ? (
            <p className="empty-state">暂无待评分模型</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>发现时间</th>
                    <th>分数（0–100）</th>
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((m) => {
                    const draft = drafts[m.modelId] ?? { score: "", note: "" };
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="font-medium">{m.name}</div>
                          <div className="font-mono text-xs text-neutral-500">{m.modelId}</div>
                        </td>
                        <td className="whitespace-nowrap text-xs text-neutral-500">
                          {new Date(m.discoveredAt).toLocaleString()}
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={draft.score}
                            onChange={(e) => setDraft(m.modelId, { score: e.target.value })}
                            className="input w-24"
                            placeholder="0–100"
                          />
                          {rowErrors[m.modelId] && (
                            <div className="mt-1 text-xs text-red-600">{rowErrors[m.modelId]}</div>
                          )}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            onClick={() => handleSave(m.modelId)}
                            disabled={!!saving[m.modelId]}
                            className="btn-primary"
                          >
                            {saving[m.modelId] ? "保存中…" : "保存"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">已评分模型</h2>
            <span className="badge badge-ok">{scored.length}</span>
          </div>
          {scored.length === 0 ? (
            <p className="empty-state">暂无已评分模型</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>分数</th>
                    <th>备注</th>
                    <th>更新时间</th>
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {scored.map((r) => {
                    const draft = drafts[r.modelId] ?? { score: String(r.score), note: r.note ?? "" };
                    return (
                      <tr key={r.modelId}>
                        <td>
                          <div className="font-medium">{r.name ?? "—"}</div>
                          <div className="font-mono text-xs text-neutral-500">{r.modelId}</div>
                          <div className="mt-1 flex gap-1">
                            {r.isActive === false && <span className="badge badge-off">已下线</span>}
                            {r.isSpecialized === true && <span className="badge badge-warn">专用</span>}
                          </div>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={draft.score}
                            onChange={(e) => setDraft(r.modelId, { score: e.target.value })}
                            className="input w-24"
                          />
                          {rowErrors[r.modelId] && (
                            <div className="mt-1 text-xs text-red-600">{rowErrors[r.modelId]}</div>
                          )}
                        </td>
                        <td>
                          <input
                            value={draft.note}
                            onChange={(e) => setDraft(r.modelId, { note: e.target.value })}
                            className="input w-full min-w-32"
                            placeholder="备注（可选）"
                          />
                        </td>
                        <td className="whitespace-nowrap text-xs text-neutral-500">
                          {new Date(r.updatedAt).toLocaleString()}
                        </td>
                        <td className="text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => handleSave(r.modelId)}
                              disabled={!!saving[r.modelId]}
                              className="btn-primary"
                            >
                              {saving[r.modelId] ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(r.modelId)}
                              disabled={!!saving[r.modelId]}
                              className="btn-danger"
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
