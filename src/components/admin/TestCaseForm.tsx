"use client";

import { useState } from "react";

export interface TestCaseInitial {
  id?: string;
  name: string;
  description?: string | null;
  messages: unknown[];
  maxTokens: number;
  temperature: number;
  enabled: boolean;
}

export interface TestCaseSubmit {
  name: string;
  description?: string;
  messages: unknown[];
  maxTokens: number;
  temperature: number;
  enabled: boolean;
}

export default function TestCaseForm({
  initial,
  onSubmit,
  onCancel,
  submitting = false,
}: {
  initial?: TestCaseInitial;
  onSubmit: (values: TestCaseSubmit) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [messagesText, setMessagesText] = useState(
    initial ? JSON.stringify(initial.messages, null, 2) : '[{"role":"user","content":"hello"}]',
  );
  const [maxTokens, setMaxTokens] = useState(String(initial?.maxTokens ?? 50));
  const [temperature, setTemperature] = useState(String(initial?.temperature ?? 0.7));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [numberError, setNumberError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(messagesText);
    } catch {
      setMessagesError("messages 不是合法 JSON");
      return;
    }
    if (!Array.isArray(parsed)) {
      setMessagesError("messages 必须是数组");
      return;
    }
    setMessagesError(null);
    const maxVal = Number(maxTokens);
    if (maxTokens.trim() === "" || !Number.isInteger(maxVal) || maxVal < 1) {
      setNumberError("maxTokens 必须为正整数（≥1）");
      return;
    }
    const tempVal = Number(temperature);
    if (temperature.trim() === "" || !Number.isFinite(tempVal)) {
      setNumberError("temperature 必须为数字");
      return;
    }
    if (tempVal < 0 || tempVal > 2) {
      setNumberError("temperature 建议范围 0–2");
      return;
    }
    setNumberError(null);
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      messages: parsed,
      maxTokens: maxVal,
      temperature: tempVal,
      enabled,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card mt-4 max-w-3xl">
      <div className="card-header">
        <span className="card-title">{initial?.id ? "编辑用例" : "新建用例"}</span>
        <button type="button" onClick={onCancel} className="btn-sm">
          关闭
        </button>
      </div>
      <div className="card-body flex flex-col gap-3">
        {numberError && <p className="alert alert-error">{numberError}</p>}
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
          <span>描述</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
          />
        </label>
        <label className="field">
          <span>Messages（JSON 数组）</span>
          <textarea
            value={messagesText}
            onChange={(e) => setMessagesText(e.target.value)}
            rows={6}
            className="input font-mono"
          />
        </label>
        {messagesError && <p className="alert alert-error">{messagesError}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field">
            <span>Max Tokens</span>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              className="input"
            />
          </label>
          <label className="field">
            <span>Temperature</span>
            <input
              type="number"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              className="input"
            />
          </label>
        </div>
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
