"use client";

import { useState } from "react";

export interface ApiKeyInitial {
  id?: string;
  name: string;
  baseUrl: string;
  priority: number;
  enabled: boolean;
}

export interface ApiKeySubmit {
  name: string;
  key?: string;
  baseUrl: string;
  priority: number;
  enabled: boolean;
}

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export default function ApiKeyForm({
  initial,
  onSubmit,
  onCancel,
  submitting = false,
}: {
  initial?: ApiKeyInitial;
  onSubmit: (values: ApiKeySubmit) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const isEdit = Boolean(initial?.id);
  const [name, setName] = useState(initial?.name ?? "");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL);
  const [priority, setPriority] = useState(String(initial?.priority ?? 0));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === "") {
      setFormError("名称不能为空");
      return;
    }
    // 粘贴 Key 时常带首尾空白/换行：校验按「去空白后的长度」，
    // 提交也必须用去空白后的值 —— 否则带空白的 Key 会原样入库，上游一律 401。
    const strippedKey = key.replace(/\s/g, "");
    if (!isEdit || strippedKey !== "") {
      if (strippedKey.length < 8) {
        setFormError("Key 至少 8 位（去除空格后）");
        return;
      }
    }
    const priorityNum = Number(priority);
    if (priority.trim() === "" || !Number.isInteger(priorityNum)) {
      setFormError("优先级必须为整数");
      return;
    }
    setFormError(null);
    onSubmit({
      name: name.trim(),
      ...(strippedKey !== "" ? { key: strippedKey } : {}),
      baseUrl: baseUrl.trim() === "" ? DEFAULT_BASE_URL : baseUrl.trim(),
      priority: priorityNum,
      enabled,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card mt-4 max-w-2xl">
      <div className="card-header">
        <span className="card-title">{isEdit ? "编辑 Key" : "新建 Key"}</span>
        <button type="button" onClick={onCancel} className="btn-sm">
          关闭
        </button>
      </div>
      <div className="card-body flex flex-col gap-3">
        {formError && <p className="alert alert-error">{formError}</p>}
        <label className="field">
          <span>名称（必填）</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </label>
        <label className="field">
          <span>Key{isEdit ? "（留空表示不改）" : "（必填）"}</span>
          <input
            type="password"
            required={!isEdit}
            minLength={8}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={isEdit ? "留空表示不修改" : "请输入 Key"}
            className="input"
          />
          <span className="hint">Key 至少 8 位，过短可能无法通过上游鉴权</span>
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="input"
          />
        </label>
        <label className="field">
          <span>优先级（越大越优先）</span>
          <input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? "保存中…" : "保存"}
          </button>
          <button type="button" onClick={onCancel} className="btn">
            取消
          </button>
        </div>
      </div>
    </form>
  );
}
