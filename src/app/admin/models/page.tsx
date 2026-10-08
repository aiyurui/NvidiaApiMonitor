"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/admin/PageHeader";
import { isProbeFresh, probeValidityMs } from "@/lib/services/model-sync";

interface LatestCheck {
  success: boolean;
  ttftMs: number | null;
  tokensPerSec: number | null;
  errorMessage: string | null;
  createdAt: string;
}

interface ModelRow {
  id: string;
  modelId: string;
  name: string | null;
  isSpecialized: boolean | null;
  specializedTags: string[] | null;
  isActive: boolean;
  lastSeenAt: string | null;
  removedAt: string | null;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeCode: number | null;
  lastProbeMs: number | null;
  lastProbeError: string | null;
  /** 健检连续超时次数；达阈值后模型被标记不可用 */
  consecutiveTimeouts: number;
  /** 被标记不可用的原因（如"连续 3 次健康检查超时"） */
  downReason: string | null;
  latestCheck: LatestCheck | null;
}

/** 最近一次后台任务（同步 / 全量健检）的运行结果 */
interface SyncRun {
  id: string;
  ok: boolean;
  running: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  probeOk: number;
  probeDown: number;
  checkedCount: number;
  errorMessage: string | null;
}

interface SyncSummary {
  created: number;
  updated: number;
  removed: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/** 短时分 HH:MM（用于调度概览的"上次/下次"时间） */
function timeStr(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** 预估下一次同步时间：按「每 N 小时整点对齐」估算。
 *  注意：实际调度是「启动时刻 + 固定 N 小时间隔」，不再对齐整点，
 *  因此这里给的是**上限**（真实触发只会更早）。仅在"从未同步过"时兜底展示。 */
function nextSyncBoundary(syncHours: number): Date {
  const N = Math.max(1, Math.floor(syncHours));
  const now = new Date();
  for (let k = 0; k <= 24; k++) {
    const h = (now.getHours() + k) % 24;
    if (h % N === 0) {
      const cand = new Date(now);
      cand.setHours(h, 0, 0, 0);
      // 同一小时但已过了 0 分，需取下一个整点倍数
      if (k === 0 && cand.getTime() <= now.getTime()) continue;
      return cand;
    }
  }
  const fallback = new Date(now);
  fallback.setHours(now.getHours() + N, 0, 0, 0);
  return fallback;
}

/** 最近一次同步 / 探测结果：成功显示「HTTP 码 + 探测耗时」，失败显示返回码或超时。
 *  注意：已下线（isActive=false）或超出时效窗口的探测结论一律标「已过期」，
 *  否则模型下线/久未同步后，旧的 200 会被误读为「当前可用」。
 *  时效窗口 = max(24h, 同步间隔+2h)，滚动判定（不再按自然日，消除 0 点断崖）。 */
function syncResultCell(m: ModelRow, validMs: number): React.ReactNode {
  if (!m.lastProbeAt) return <span className="badge badge-off">未探测</span>;
  const when = new Date(m.lastProbeAt).toLocaleString();
  // 探测结论时效性**优先于**下线原因：模型下线后不再参与同步探测，
  // 若把 downReason 排在前面，一个月前的「健检超时下线」会被永久当作当前状态展示，
  // 且与状态列的「已下线」自相矛盾。
  const stale = !m.isActive || !isProbeFresh(new Date(m.lastProbeAt), new Date(), validMs);
  if (stale) {
    return (
      <span
        className="badge badge-off whitespace-nowrap"
        title={`探测时间 ${when} · 结论已过期${m.isActive ? "（超出时效窗口）" : "（模型已下线）"}`}
      >
        已过期
      </span>
    );
  }
  // 今日且在线，但被健检连续超时标记为不可用：说明原因（探测结论已不由同步探测决定）
  if (m.downReason) {
    return (
      <span className="badge badge-warn whitespace-nowrap" title={`${m.downReason} · 最近探测 ${when}`}>
        健检超时下线
      </span>
    );
  }
  if (m.lastProbeOk === true) {
    const code = m.lastProbeCode ?? "?";
    // lastProbeMs 是本次迭代新增字段，历史探测没有耗时 → 不显示 "—ms"，下次同步后自动补上
    const ms = m.lastProbeMs;
    return (
      <span
        className="badge badge-ok whitespace-nowrap"
        title={ms === null ? `探测时间 ${when} · HTTP ${code} · 耗时未记录，下次同步后补充` : `探测时间 ${when} · HTTP ${code}`}
      >
        {ms === null ? `HTTP ${code}` : `HTTP ${code} · ${ms}ms`}
      </span>
    );
  }
  const err = m.lastProbeError ?? "";
  const isTimeout = err.startsWith("timeout");
  if (isTimeout) {
    return (
      <span className="badge badge-warn whitespace-nowrap" title={`${err || "探测超时"} · ${when}`}>
        超时
      </span>
    );
  }
  const label = m.lastProbeCode ? `HTTP ${m.lastProbeCode}` : "请求失败";
  return (
    <span className="badge badge-danger whitespace-nowrap" title={`${err || "探测失败"} · ${when}`}>
      {label}
    </span>
  );
}

/** 后台任务运行结果卡片：同步 / 全量健检共用 */
function RunCard({
  title,
  run,
  emptyHint,
  okDetail,
}: {
  title: string;
  run: SyncRun | null;
  emptyHint: string;
  okDetail: (run: SyncRun) => React.ReactNode;
}): React.ReactNode {
  return (
    <div className="card p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        {run ? (
          run.running ? (
            <span className="badge badge-info">执行中</span>
          ) : run.ok ? (
            <span className="badge badge-ok">成功</span>
          ) : (
            <span className="badge badge-warn">未完成</span>
          )
        ) : (
          <span className="badge badge-off">暂无记录</span>
        )}
        <span className="text-xs text-neutral-500">
          {run
            ? run.running
              ? `${new Date(run.startedAt).toLocaleString()}（${relativeTime(run.startedAt)}）· 进行中`
              : `${new Date(run.finishedAt).toLocaleString()}（${relativeTime(run.finishedAt)}）· 耗时 ${run.durationMs}ms`
            : emptyHint}
        </span>
      </div>
      {run ? (
        run.ok ? (
          okDetail(run)
        ) : (
          <div className="text-xs text-red-600" title={run.errorMessage ?? ""}>
            {run.errorMessage ?? "执行失败"}
          </div>
        )
      ) : null}
    </div>
  );
}

function statusCell(m: ModelRow, validMs: number): React.ReactNode {
  if (!m.isActive) {
    return <span className="badge badge-off badge-dot">已下线</span>;
  }
  if (m.isSpecialized) {
    const tags = (m.specializedTags ?? []).join(",");
    return (
      <span className="badge badge-warn">
        专用{tags ? `:${tags}` : ""}
      </span>
    );
  }
  // 可用状态以「同步探测」(lastProbeOk) 为准；健检(healthCheck)只展示延迟/TPS。
  // 例外：健检连续超时达阈值会把 lastProbeOk 置 false（见 runHealthJob），
  // 此时模型确实判为不可用，但可通过下一次全量可用性检查恢复。
  if (m.lastProbeOk === null || m.lastProbeAt === null) {
    return <span className="badge badge-off badge-dot">未测</span>;
  }
  const fresh = isProbeFresh(m.lastProbeAt ? new Date(m.lastProbeAt) : null, new Date(), validMs);
  if (!fresh) return <span className="badge badge-off badge-dot">未测</span>;
  if (m.lastProbeOk) {
    return <span className="badge badge-ok badge-dot">可用</span>;
  }
  if (m.downReason) {
    const n = m.consecutiveTimeouts;
    return (
      <span className="badge badge-danger badge-dot" title={`${m.downReason}｜连续超时 ${n} 次，等待下次全量可用性检查恢复`}>
        不可用
      </span>
    );
  }
  return <span className="badge badge-danger badge-dot">不可用</span>;
}

/** 仅在检测成功时展示性能指标，失败用 title 说明原因，避免"不可用却有延迟数据" */
function perfCell(m: ModelRow): React.ReactNode {
  if (!m.latestCheck || !m.latestCheck.success) {
    const reason = m.latestCheck?.errorMessage ?? "暂无成功检测记录";
    return (
      <span className="text-neutral-400" title={reason}>
        —
      </span>
    );
  }
  const ttft = m.latestCheck.ttftMs;
  const tps = m.latestCheck.tokensPerSec;
  return (
    <span className="flex flex-col items-end gap-0.5 tabular-nums">
      <span className="flex items-center gap-1.5 text-xs">
        <span className="text-neutral-400">TTFT</span>
        <span className="font-medium">{ttft === null ? "—" : `${ttft}ms`}</span>
      </span>
      <span className="flex items-center gap-1.5 text-xs">
        <span className="text-neutral-400">TPS</span>
        <span className="font-medium">{tps === null ? "—" : tps}</span>
      </span>
    </span>
  );
}

export default function ModelsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [lastSyncRun, setLastSyncRun] = useState<SyncRun | null>(null);
  const [lastHealthRun, setLastHealthRun] = useState<SyncRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(true);
  const [showSpecialized, setShowSpecialized] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [manualRunning, setManualRunning] = useState<null | "sync" | "health">(null);
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState<string | null>(null);
  const [clearErr, setClearErr] = useState<string | null>(null);
  const [healthIntervalMin, setHealthIntervalMin] = useState<number>(30);
  const [syncIntervalHours, setSyncIntervalHours] = useState<number>(6);
  const [syncRunsToday, setSyncRunsToday] = useState<number>(0);
  const [healthRunsToday, setHealthRunsToday] = useState<number>(0);
  const [schedulerActive, setSchedulerActive] = useState<boolean | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthSummary, setHealthSummary] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/models");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const json = (await res.json()) as {
        data: ModelRow[]; lastSyncRun: SyncRun | null; lastHealthRun: SyncRun | null;
        syncRunsToday: number; healthRunsToday: number;
      };
      setRows(json.data ?? []);
      setLastSyncRun(json.lastSyncRun ?? null);
      setLastHealthRun(json.lastHealthRun ?? null);
      if (typeof json.syncRunsToday === "number") setSyncRunsToday(json.syncRunsToday);
      if (typeof json.healthRunsToday === "number") setHealthRunsToday(json.healthRunsToday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  // 轮询任务运行状态：手动触发或定时调度在跑时，实时刷新"执行中"横幅与运行卡片
  const lastSyncRef = useRef<SyncRun | null>(null);
  const lastHealthRef = useRef<SyncRun | null>(null);
  const manualRef = useRef<null | "sync" | "health">(null);
  useEffect(() => { lastSyncRef.current = lastSyncRun; }, [lastSyncRun]);
  useEffect(() => { lastHealthRef.current = lastHealthRun; }, [lastHealthRun]);
  useEffect(() => { manualRef.current = manualRunning; }, [manualRunning]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (!active) return;
      // 始终轻量轮询：即便空闲也刷新"上次/下次"健检时间，让调度状态常驻可见
      try {
        const res = await fetch("/api/admin/jobs");
        if (!res.ok) return;
        const json = (await res.json()) as {
          sync: SyncRun | null; health: SyncRun | null; healthIntervalMin?: number;
          syncIntervalHours?: number; syncRunsToday?: number; healthRunsToday?: number;
          schedulerActive?: boolean;
        };
        const wasRunning =
          lastSyncRef.current?.running === true || lastHealthRef.current?.running === true;
        const sync = json.sync ?? null;
        const health = json.health ?? null;
        const nowRunning = sync?.running === true || health?.running === true;
        setLastSyncRun(sync);
        setLastHealthRun(health);
        if (typeof json.healthIntervalMin === "number" && json.healthIntervalMin > 0) {
          setHealthIntervalMin(json.healthIntervalMin);
        }
        if (typeof json.syncIntervalHours === "number" && json.syncIntervalHours > 0) {
          setSyncIntervalHours(json.syncIntervalHours);
        }
        if (typeof json.syncRunsToday === "number") setSyncRunsToday(json.syncRunsToday);
        if (typeof json.healthRunsToday === "number") setHealthRunsToday(json.healthRunsToday);
        if (typeof json.schedulerActive === "boolean") setSchedulerActive(json.schedulerActive);
        if (wasRunning && !nowRunning) await load();
      } catch { /* 网络抖动忽略，下次轮询重试 */ }
    };
    const iv = setInterval(tick, 5000);
    return () => { active = false; clearInterval(iv); };
  }, [load]);

  const filtered = useMemo(
    () =>
      rows.filter((m) => {
        if (!showRemoved && !m.isActive) return false;
        if (!showSpecialized && (m.isSpecialized ?? false)) return false;
        return true;
      }),
    [rows, showRemoved, showSpecialized],
  );

  // 探测结论时效窗口：max(24h, 同步间隔+2h)。同步间隔来自 /api/admin/jobs，
  // 初始 6（默认值）在接口返回前也给出正确的窗口下限。
  const validMs = probeValidityMs(syncIntervalHours);

  async function handleSync() {
    setSyncing(true);
    setManualRunning("sync");
    setSyncSummary(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/admin/models/sync", { method: "POST" });
      const json = (await res.json().catch(() => null)) as (Partial<SyncSummary> & {
        error?: string;
      }) | null;
      if (!res.ok) throw new Error(json?.error ?? `同步失败（${res.status}）`);
      const created = json?.created ?? 0;
      const updated = json?.updated ?? 0;
      const removed = json?.removed ?? 0;
      setSyncSummary(`新增 ${created} / 更新 ${updated} / 下线 ${removed}`);
      await load();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
      setManualRunning(null);
    }
  }

  async function handleClearToday() {
    if (clearing) return;
    const preview = await fetch("/api/admin/data/today").then((r) => (r.ok ? r.json() : null)).catch(() => null) as
      | { healthChecks?: number; syncRuns?: number; total?: number }
      | null;
    const n = preview?.total ?? 0;
    if (n === 0) {
      setClearMsg("今天还没有数据，无需清理。");
      setClearErr(null);
      return;
    }
    const confirmed = window.confirm(
      `确定清理今日数据吗？\n\n` +
      `将删除：\n` +
      `· 健检记录 ${preview?.healthChecks ?? 0} 条\n` +
      `· 任务运行记录 ${preview?.syncRuns ?? 0} 条\n\n` +
      `不可撤销。模型 / API Key / 测试用例 / 评分不受影响。`,
    );
    if (!confirmed) return;
    setClearing(true);
    setClearMsg(null);
    setClearErr(null);
    try {
      const res = await fetch("/api/admin/data/today", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        deletedHealthChecks?: number;
        deletedSyncRuns?: number;
        error?: string;
      } | null;
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(json?.error ?? `清理失败（${res.status}）`);
      setClearMsg(
        `已清理：健检记录 ${json?.deletedHealthChecks ?? 0} 条 · 任务运行记录 ${json?.deletedSyncRuns ?? 0} 条`,
      );
      await load();
    } catch (e) {
      setClearErr(e instanceof Error ? e.message : "清理失败");
    } finally {
      setClearing(false);
    }
  }

  async function handleHealthCheckAll() {
    setHealthChecking(true);
    setManualRunning("health");
    setHealthSummary(null);
    setHealthError(null);
    try {
      const res = await fetch("/api/admin/models/health-check-all", { method: "POST" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const json = (await res.json().catch(() => null)) as {
        checked?: number;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? `检测失败（${res.status}）`);
      const checked = json?.checked ?? 0;
      setHealthSummary(`全量检测完成，共 ${checked} 次检测`);
      await load();
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : "检测失败");
    } finally {
      setHealthChecking(false);
      setManualRunning(null);
    }
  }

  async function handleCheck(id: string) {
    setCheckingId(id);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/admin/models/${id}/health-check`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        errorMessage?: string;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? json?.errorMessage ?? `检测失败（${res.status}）`);
      if (json && json.success === false && json.errorMessage) {
        setRowErrors((prev) => ({ ...prev, [id]: json.errorMessage as string }));
      }
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "检测失败" }));
    } finally {
      setCheckingId(null);
    }
  }

  async function handleToggleSpecialized(id: string, next: boolean) {
    setTogglingId(id);
    setRowErrors((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    try {
      const res = await fetch(`/api/admin/models/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSpecialized: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `更新失败（${res.status}）`);
      }
      await load();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "更新失败" }));
    } finally {
      setTogglingId(null);
    }
  }

  async function handleActivateScheduler() {
    setActivating(true);
    setActivateError(null);
    try {
      const res = await fetch("/api/admin/scheduler", { method: "POST" });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; active?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `激活失败（${res.status}）`);
      setSchedulerActive(json.active ?? true);
      await load();
    } catch (e) {
      setActivateError(e instanceof Error ? e.message : "激活失败");
    } finally {
      setActivating(false);
    }
  }

  const runningSync = lastSyncRun?.running === true;
  const runningHealth = lastHealthRun?.running === true;
  const busy = manualRunning !== null || runningSync || runningHealth;
  const runningKind: "sync" | "health" | null = runningSync ? "sync" : runningHealth ? "health" : null;
  const activeKind = manualRunning ?? runningKind;
  const startedAtIso =
    activeKind === "sync" ? lastSyncRun?.startedAt : lastHealthRun?.startedAt;
  const elapsedSec = startedAtIso
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 1000))
    : null;
  const jobLabel = activeKind === "sync" ? "模型同步" : "健康检查";
  // 下次预计健检：基于上次健检结束时间 + 间隔（进行中时基于开始时间）
  const nextHealthAt = useMemo(() => {
    if (!healthIntervalMin || !lastHealthRun) return null;
    const base = lastHealthRun.running ? lastHealthRun.startedAt : lastHealthRun.finishedAt;
    if (!base) return null;
    return new Date(new Date(base).getTime() + healthIntervalMin * 60 * 1000);
  }, [healthIntervalMin, lastHealthRun]);
  // 下次预计同步：基于上次同步结束时间 + 间隔（进行中时基于开始时间）；从未同步过则按整点对齐上限预估
  const nextSyncAt = useMemo(() => {
    if (!syncIntervalHours) return null;
    if (lastSyncRun) {
      const base = lastSyncRun.running ? lastSyncRun.startedAt : lastSyncRun.finishedAt;
      if (base) return new Date(new Date(base).getTime() + syncIntervalHours * 60 * 60 * 1000);
    }
    return nextSyncBoundary(syncIntervalHours);
  }, [syncIntervalHours, lastSyncRun]);

  return (
    <div>
      <PageHeader
        title="模型管理"
        description="同步 NVIDIA 清单并逐个探测；最近同步结果显示本次新增 / 更新 / 下线 与探测成败"
        count={`共 ${filtered.length} 个`}
        actions={
          <>
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="btn-primary"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
            <button
              type="button"
              onClick={handleHealthCheckAll}
              disabled={healthChecking}
              className="btn"
            >
              {healthChecking ? "检测中…" : "执行全量健检"}
            </button>
            <button
              type="button"
              onClick={handleClearToday}
              disabled={clearing || busy}
              className="btn btn-danger"
              title="删除今天产生的健检记录与任务运行记录（模型 / Key / 测试用例不受影响）"
            >
              {clearing ? "清理中…" : "清理今日数据"}
            </button>
          </>
        }
      />

      {clearMsg ? <div className="alert alert-ok mb-3">{clearMsg}</div> : null}
      {clearErr ? <div className="alert alert-error mb-3">{clearErr}</div> : null}

      {/* 调度状态概览：常驻显示，无论忙闲都能看到系统自动健检的节奏与最近结果 */}
      <div className="mb-3 card p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-1.5 font-medium">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${busy ? "animate-pulse bg-blue-500" : "bg-neutral-400"}`} />
            {busy ? "任务运行中" : "调度空闲"}
          </span>
          <span className="text-neutral-600">
            上次同步：{lastSyncRun ? timeStr(lastSyncRun.finishedAt) : "从未"}
          </span>
          <span className="text-neutral-600">
            上次健检：{lastHealthRun ? timeStr(lastHealthRun.finishedAt) : "从未"}
          </span>
          {!busy && nextSyncAt && (
            <span className="text-neutral-600">下次自动同步约 {timeStr(nextSyncAt.toISOString())}</span>
          )}
          {!busy && nextHealthAt && (
            <span className="text-neutral-600">下次自动健检约 {timeStr(nextHealthAt.toISOString())}</span>
          )}
          {busy && (
            <span className="text-blue-700">{jobLabel}已运行 {elapsedSec ?? 0}s</span>
          )}
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${
              schedulerActive === true ? "bg-green-500"
                : schedulerActive === false ? "bg-red-500"
                : "bg-neutral-400"
            }`} />
            {schedulerActive === true
              ? "调度已激活"
              : schedulerActive === false
                ? "调度未激活"
                : "调度状态未知"}
          </span>
          {schedulerActive === false && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={activating}
              onClick={handleActivateScheduler}
            >
              {activating ? "激活中…" : "手动激活调度"}
            </button>
          )}
          {activateError && <span className="text-red-600">{activateError}</span>}
        </div>
        {busy && (
          <div className="mt-2 flex items-center gap-2 text-blue-700">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span>{jobLabel}任务执行中…</span>
          </div>
        )}
      </div>

      {/* 最近一次同步 / 健检的返回结果 */}
      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <RunCard
          title="最近一次同步"
          run={lastSyncRun}
          emptyHint="执行一次同步后这里会显示结果"
          okDetail={(r) => (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
              <span>新增 {r.addedCount}</span>
              <span>更新 {r.updatedCount}</span>
              <span>下线 {r.removedCount}</span>
              <span className="text-green-700">探测可用 {r.probeOk}</span>
              <span className="text-red-600">探测不可用 {r.probeDown}</span>
              <span>今日同步 {syncRunsToday} 次</span>
            </div>
          )}
        />
        <RunCard
          title="最近一次全量健检"
          run={lastHealthRun}
          emptyHint="执行一次健检（或等待定时调度）后这里会显示结果"
          okDetail={(r) => (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
              <span>今日检测 {healthRunsToday} 次</span>
              {r.errorMessage ? (
                <span className="text-amber-700" title={r.errorMessage}>
                  部分异常
                </span>
              ) : null}
            </div>
          )}
        />
      </div>

      {syncSummary && <p className="alert alert-ok mb-3">{syncSummary}</p>}
      {syncError && <p className="alert alert-error mb-3">同步失败：{syncError}</p>}
      {healthSummary && <p className="alert alert-ok mb-3">{healthSummary}</p>}
      {healthError && <p className="alert alert-error mb-3">{healthError}</p>}

      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          显示已下线
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showSpecialized}
            onChange={(e) => setShowSpecialized(e.target.checked)}
          />
          显示专用模型
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">加载中…</p>
      ) : error ? (
        <p className="alert alert-error">加载失败：{error}</p>
      ) : filtered.length === 0 ? (
        <p className="empty-state">没有符合条件的模型</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>模型名</th>
                <th>状态</th>
                <th title="同步阶段对每个模型做的一次轻量流式探测（max_tokens=1），30 秒内收到首个数据块即判可用">
                  最近同步结果
                </th>
                <th className="text-right">最新 TTFT / TPS</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="max-w-[260px] truncate font-medium text-neutral-800 dark:text-neutral-100" title={m.name ?? m.modelId}>
                    {m.name ?? m.modelId}
                  </div>
                  <div className="max-w-[260px] truncate font-mono text-xs text-neutral-400" title={m.modelId}>
                    {m.modelId}
                  </div>
                </td>
                <td className="whitespace-nowrap">{statusCell(m, validMs)}</td>
                <td>{syncResultCell(m, validMs)}</td>
                <td className="text-right">{perfCell(m)}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleCheck(m.id)}
                      disabled={checkingId === m.id}
                      className="btn-sm"
                    >
                      {checkingId === m.id ? "检测中…" : "检测"}
                    </button>
                    <label className="flex items-center gap-1 rounded border px-1.5 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                      <input
                        type="checkbox"
                        checked={m.isSpecialized ?? false}
                        disabled={togglingId === m.id}
                        onChange={(e) => handleToggleSpecialized(m.id, e.target.checked)}
                      />
                      专用
                    </label>
                  </div>
                  {rowErrors[m.id] && (
                    <div className="mt-1 max-w-64 text-right text-xs text-red-600" title={rowErrors[m.id]}>
                      {rowErrors[m.id]}
                    </div>
                  )}
                </td>
              </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
