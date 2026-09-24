"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ApiKeyForm, {
  type ApiKeyInitial,
  type ApiKeySubmit,
} from "@/components/admin/ApiKeyForm";
import PageHeader from "@/components/admin/PageHeader";

interface ApiKeyRow {
  id: string;
  name: string;
  keyMasked: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  lastUsedAt: string | null;
  cooledUntil: string | null;
}

export default function ApiKeysPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ApiKeyInitial | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/api-keys");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const json = (await res.json()) as { data: ApiKeyRow[] };
      setRows(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(values: ApiKeySubmit) {
    setSubmitting(true);
    setFormError(null);
    try {
      const url = editing?.id ? `/api/admin/api-keys/${editing.id}` : "/api/admin/api-keys";
      const res = await fetch(url, {
        method: editing?.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `保存失败（${res.status}）`);
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("删除该 Key 将连带删除其全部历史检测记录，确定吗？")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/api-keys/${id}`, { method: "DELETE" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(json?.error ?? `删除失败（${res.status}）`);
        return;
      }
      setFormError(null);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="多 Key 按优先级轮换；本项目不冻结 Key（上游过载/超时的瓶颈在模型侧，与 Key 无关）"
        count={`共 ${rows.length} 个`}
        actions={
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
            className="btn-primary"
          >
            新建
          </button>
        }
      />

      {formError && <p className="alert alert-error mb-4">{formError}</p>}

      {loading ? (
        <p className="text-sm text-neutral-500">加载中…</p>
      ) : error ? (
        <p className="alert alert-error">加载失败：{error}</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">暂无 Key，点击右上角「新建」添加</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>Key</th>
                <th>Base URL</th>
                <th>启用</th>
                <th className="text-right">优先级</th>
                <th>最后使用</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                return (
                  <tr key={r.id}>
                    <td className="font-medium">{r.name}</td>
                    <td className="font-mono text-xs text-neutral-500">{r.keyMasked}</td>
                    <td className="max-w-[220px] truncate text-xs text-neutral-500" title={r.baseUrl}>
                      {r.baseUrl}
                    </td>
                    <td>
                      <span className={`badge ${r.enabled ? "badge-ok" : "badge-off"}`}>
                        {r.enabled ? "启用" : "停用"}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{r.priority}</td>
                    <td className="whitespace-nowrap text-xs text-neutral-500">
                      {r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : "—"}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => {
                            setEditing({
                              id: r.id,
                              name: r.name,
                              baseUrl: r.baseUrl,
                              priority: r.priority,
                              enabled: r.enabled,
                            });
                            setShowForm(true);
                          }}
                          className="btn-sm"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          disabled={submitting || deletingId === r.id}
                          onClick={() => handleDelete(r.id)}
                          className="btn-danger"
                        >
                          {deletingId === r.id ? "删除中…" : "删除"}
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

      {showForm && (
        <ApiKeyForm
          key={editing?.id ?? "new"}
          initial={editing ?? undefined}
          submitting={submitting}
          onSubmit={handleSubmit}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
