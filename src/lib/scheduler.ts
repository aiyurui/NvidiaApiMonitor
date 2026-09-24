import { getSettings } from "@/lib/settings";
import { runSyncJob, runHealthJob, withJobLock } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";

/**
 * 把设置里的间隔换算为毫秒。
 *
 * 为什么不再用 cron 的 `*​/N`：
 * `*​/N` 的语义是「N 能整除的那些分钟」，**不是「每 N 分钟」** —— cron 每小时独立重置，
 * 所以 N 不整除 60 时节奏必然走样（实测 N=45 → 每小时仅在 :00 与 :45 触发，
 * 间隔在 45/15 之间摆动）；N ≥ 60 时旧实现直接退化成整点，设 90 分钟实际仍是每 60 分钟。
 * 按小时的同步同样有偏差（syncHours=5 → 0/5/10/15/20 点，间隔为 5,5,5,5,4）。
 *
 * 这里改用定时器直接表达「每 N 毫秒」，让设置值**精确生效**——
 * 代价是触发时刻不再对齐整点/整分，这对可用性监控没有影响。
 */
export function buildIntervalMs(syncHours: number, healthMins: number) {
  const h = Math.max(1, Math.floor(syncHours));
  const m = Math.max(1, Math.floor(healthMins));
  return { syncIntervalMs: h * 3_600_000, healthIntervalMs: m * 60_000 };
}

// 句柄挂到 globalThis，避免 dev 热重载（HMR）时模块被重新求值导致旧定时器泄漏 / 重复创建。
const globalForScheduler = globalThis as unknown as {
  __schedulerJobs?: Array<{ stop: () => void }>;
  __schedulerActive?: boolean;
};
let jobs: Array<{ stop: () => void }> = globalForScheduler.__schedulerJobs ?? [];
function setJobs(next: Array<{ stop: () => void }>) {
  jobs = next;
  globalForScheduler.__schedulerJobs = next;
  globalForScheduler.__schedulerActive = next.length > 0;
}

/** 调度器是否已激活（已注册定时任务）。用于界面展示与手动激活判断。 */
export function isSchedulerActive(): boolean {
  const js = globalForScheduler.__schedulerJobs ?? [];
  return js.length > 0 && (globalForScheduler.__schedulerActive ?? false);
}

export function stopScheduler() {
  jobs.forEach((j) => { try { j.stop(); } catch { /* ignore */ } });
  setJobs([]);
}

/** 周期性触发；返回值与 cron 任务对象同形（有 stop()），便于统一管理 */
function makeTimer(intervalMs: number, fn: () => void): { stop: () => void } {
  const t = setInterval(fn, intervalMs);
  return { stop: () => clearInterval(t) };
}

export async function startScheduler() {
  stopScheduler();
  const s = await getSettings();
  const { syncIntervalMs, healthIntervalMs } = buildIntervalMs(s.syncIntervalHours, s.healthIntervalMin);
  console.info(
    `[scheduler] activated — sync every ${s.syncIntervalHours}h (${syncIntervalMs}ms / exact), ` +
    `health every ${s.healthIntervalMin}min (${healthIntervalMs}ms / exact)`,
  );
  setJobs([
    makeTimer(syncIntervalMs, () => {
      void withJobLock(runSyncJob)
        .then((summary) => {
          if (summary !== null) console.info("[scheduler] sync done", JSON.stringify(summary));
        })
        .catch((e) => console.error("[scheduler] sync job failed", e));
    }),
    makeTimer(healthIntervalMs, () => {
      void withJobLock(runHealthJob)
        .then((result) => {
          if (result !== null) console.info("[scheduler] health done", JSON.stringify(result));
        })
        .catch((e) => console.error("[scheduler] health job failed", e));
    }),
  ]);
  // 启动补跑：后台异步执行，不阻塞网站就绪（否则首次同步/健检会卡住 Next.js 启动）。
  // 同步是健检的前提（建表 + 探测可用模型），因此从未跑过或已超间隔时，必须优先补同步。
  void runStartupCatchUp(s).catch((e) => console.error("[scheduler] startup catch-up failed", e));
}

/** 启动后立即补跑一次过期任务：同步优先（若从未跑过或已超间隔），随后按需补健检。 */
async function runStartupCatchUp(s: { syncIntervalHours: number; healthIntervalMin: number }) {
  const lastSync = await prisma.syncRun.findFirst({ where: { kind: "sync" }, orderBy: { createdAt: "desc" } });
  const syncStale = !lastSync || Date.now() - new Date(lastSync.createdAt).getTime() > s.syncIntervalHours * 3600 * 1000;
  const lastCheck = await prisma.healthCheck.findFirst({ orderBy: { createdAt: "desc" } });
  const healthStale = !lastCheck || lastCheck.createdAt < new Date(Date.now() - s.healthIntervalMin * 60 * 1000);

  if (syncStale) {
    await withJobLock(runSyncJob)
      .then((summary) => {
        if (summary !== null) console.info("[scheduler] sync done", JSON.stringify(summary));
      })
      .catch((e) => console.error("[scheduler] sync job failed", e));
    // 同步补全后若健检也已过期，顺带补一次（同步会刷新可探测模型，健检才有数据可跑）
    if (healthStale) {
      await withJobLock(runHealthJob)
        .then((result) => {
          if (result !== null) console.info("[scheduler] health done", JSON.stringify(result));
        })
        .catch((e) => console.error("[scheduler] health catch-up failed", e));
    }
  } else if (healthStale) {
    await withJobLock(runHealthJob)
      .then((result) => {
        if (result !== null) console.info("[scheduler] health done", JSON.stringify(result));
      })
      .catch((e) => console.error("[scheduler] health catch-up failed", e));
  }
}

export async function restartScheduler() {
  await startScheduler();
}
