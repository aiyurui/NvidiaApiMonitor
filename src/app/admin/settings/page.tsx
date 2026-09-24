"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SettingsForm, { type SettingsSubmit } from "@/components/admin/SettingsForm";
import PageHeader from "@/components/admin/PageHeader";
import type { ParsedSettings } from "@/types";

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<ParsedSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await fetch("/api/admin/settings");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const json = (await res.json()) as ParsedSettings;
      setSettings(json);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(values: SettingsSubmit) {
    setSaving(true);
    setSaveOk(null);
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
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
      const json = (await res.json()) as ParsedSettings;
      setSettings(json);
      setSaveOk("已保存，调度已热重载");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="全局设置"
        description="保存后调度立即热重载，无需重启进程"
      />
      {loading ? (
        <p className="text-sm text-neutral-500">加载中…</p>
      ) : loadError ? (
        <p className="alert alert-error">加载失败：{loadError}</p>
      ) : settings ? (
        <div className="max-w-3xl">
          {saveOk && <p className="alert alert-ok mb-4">{saveOk}</p>}
          {saveError && <p className="alert alert-error mb-4">{saveError}</p>}
          <SettingsForm
            key={JSON.stringify(settings)}
            initial={settings}
            saving={saving}
            onSubmit={handleSave}
          />
        </div>
      ) : null}
    </div>
  );
}
