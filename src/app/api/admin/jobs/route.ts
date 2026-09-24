import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { isSchedulerActive } from "@/lib/scheduler";

/** 轻量任务状态接口：返回最近一次同步 / 全量健检的运行记录（含 running 标记）+ 同步/健检间隔 + 当天同步/检测次数。
 *  专供后台页面轮询，避免每次都拉整张模型表。 */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [sync, health, settings, healthChecksToday, syncRunsToday, healthRunsToday] = await Promise.all([
    prisma.syncRun.findFirst({ where: { kind: "sync" }, orderBy: { createdAt: "desc" } }),
    prisma.syncRun.findFirst({ where: { kind: "health" }, orderBy: { createdAt: "desc" } }),
    getSettings(),
    // 今日累计探测动作数：每条 healthCheck = 一次「单模型×单用例」探测（不论成败）
    prisma.healthCheck.count({ where: { createdAt: { gte: startOfDay } } }),
    // 今日同步轮数
    prisma.syncRun.count({ where: { kind: "sync", createdAt: { gte: startOfDay } } }),
    // 今日健检轮数（与累计探测数区分，避免「次」歧义）
    prisma.syncRun.count({ where: { kind: "health", createdAt: { gte: startOfDay } } }),
  ]);
  return NextResponse.json({
    sync,
    health,
    healthIntervalMin: settings.healthIntervalMin,
    syncIntervalHours: settings.syncIntervalHours,
    healthChecksToday,
    syncRunsToday,
    healthRunsToday,
    schedulerActive: isSchedulerActive(),
  });
}
