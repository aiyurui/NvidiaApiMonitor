import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

/** 当日零点（server-local） */
function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 预览当日数据量：清理前让用户看到将删除什么 */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const since = startOfToday();
  const [healthChecks, syncRuns] = await Promise.all([
    prisma.healthCheck.count({ where: { createdAt: { gte: since } } }),
    prisma.syncRun.count({ where: { startedAt: { gte: since } } }),
  ]);
  return NextResponse.json({
    since: since.toISOString(),
    healthChecks,
    syncRuns,
    total: healthChecks + syncRuns,
  });
}

/**
 * 清理当日数据：删除今天产生的健检记录与任务运行记录。
 *
 * 保留对象：模型表、API Key、测试用例、评分——只清"检测痕迹"。
 * 注意：会重置 `Model.lastProbe*`（同步探测结论）与 `lastHealthAt` 类派生字段，
 * 使其与"当天无数据"的状态一致，避免界面出现"今日 0 次但显示已有结论"的矛盾。
 * 可选 `?resetProbe=1` 时一并清空模型探测结论（默认不重置，仅清记录）。
 */
export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const resetProbe = url.searchParams.get("resetProbe") === "1";
  const since = startOfToday();

  try {
    const [health, runs] = await prisma.$transaction([
      prisma.healthCheck.deleteMany({ where: { createdAt: { gte: since } } }),
      prisma.syncRun.deleteMany({ where: { startedAt: { gte: since } } }),
    ]);

    let resetModels = 0;
    if (resetProbe) {
      const r = await prisma.model.updateMany({
        data: {
          lastProbeAt: null,
          lastProbeOk: null,
          lastProbeCode: null,
          lastProbeMs: null,
          lastProbeError: null,
          // 一并清零「健检连续超时」的派生状态，否则会残留 downReason，
          // 与「已清空探测结论」的界面语义矛盾。
          consecutiveTimeouts: 0,
          downReason: null,
        },
      });
      resetModels = r.count;
    }

    return NextResponse.json({
      ok: true,
      since: since.toISOString(),
      deletedHealthChecks: health.count,
      deletedSyncRuns: runs.count,
      resetModels,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
