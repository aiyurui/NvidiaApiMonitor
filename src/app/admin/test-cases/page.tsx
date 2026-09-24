"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TestCaseForm, {
  type TestCaseInitial,
  type TestCaseSubmit,
} from "@/components/admin/TestCaseForm";
import PageHeader from "@/components/admin/PageHeader";

interface TestCaseRow {
  id: string;
  name: string;
  description: string | null;
  messages: string;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
}

function toInitial(row: TestCaseRow): TestCaseInitial {
  let messages: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.messages);
    if (Array.isArray(parsed)) messages = parsed;
  } catch {
    messages = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    messages,
    maxTokens: row.maxTokens,
    temperature: row.temperature,
    enabled: row.enabled,
  };
}

export default function TestCasesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<TestCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TestCaseInitial | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/test-cases");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const json = (await res.json()) as { data: TestCaseRow[] };
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

  async function handleSubmit(values: TestCaseSubmit) {
    setSubmitting(true);
    setFormError(null);
    try {
      const url = editing?.id ? `/api/admin/test-cases/${editing.id}` : "/api/admin/test-cases";
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
    if (!confirm("确定删除该测试用例吗？")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/test-cases/${id}`, { method: "DELETE" });
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
        title="测试用例"
        description="每个模型 × 每个用例产生一次健康检测，禁用用例可减少检测量"
        count={`共 ${rows.length} 条`}
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
        <p className="empty-state">暂无用例，点击右上角「新建」添加</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th className="text-right">Max Tokens</th>
                <th className="text-right">Temperature</th>
                <th>启用</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.name}</td>
                  <td className="max-w-[280px] truncate text-xs text-neutral-500" title={r.description ?? undefined}>
                    {r.description ?? "—"}
                  </td>
                  <td className="text-right tabular-nums">{r.maxTokens}</td>
                  <td className="text-right tabular-nums">{r.temperature}</td>
                  <td>
                    <span className={`badge ${r.enabled ? "badge-ok" : "badge-off"}`}>
                      {r.enabled ? "启用" : "停用"}
                    </span>
                  </td>
                  <td className="text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          setEditing(toInitial(r));
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <TestCaseForm
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
