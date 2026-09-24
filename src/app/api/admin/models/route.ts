import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { deserializeTags } from "@/lib/services/filter";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [rows, lastSyncRun, lastHealthRun, healthChecksToday, syncRunsToday, healthRunsToday] = await Promise.all([
    prisma.model.findMany({
      orderBy: { modelId: "asc" },
      include: { healthChecks: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    // 最近一次「模型同步 + 全量探测」的运行结果
    prisma.syncRun.findFirst({ where: { kind: "sync" }, orderBy: { createdAt: "desc" } }),
    // 最近一次「全量健康检测」的运行结果
    prisma.syncRun.findFirst({ where: { kind: "health" }, orderBy: { createdAt: "desc" } }),
    // 今日累计探测次数：今天 0 点后写入的每一条 healthCheck 都是一次真实探测（不论成败）
    prisma.healthCheck.count({ where: { createdAt: { gte: startOfDay } } }),
    // 今日同步轮数
    prisma.syncRun.count({ where: { kind: "sync", createdAt: { gte: startOfDay } } }),
    // 今日健检轮数（与累计探测数区分）
    prisma.syncRun.count({ where: { kind: "health", createdAt: { gte: startOfDay } } }),
  ]);
  return NextResponse.json({
    lastSyncRun,
    lastHealthRun,
    healthChecksToday,
    syncRunsToday,
    healthRunsToday,
    data: rows.map((m) => {
      const latest = m.healthChecks[0] ?? null;
      const { healthChecks: _dropped, ...rest } = m;
      void _dropped;
      return {
        ...rest,
        specializedTags: deserializeTags(m.specializedTags),
        latestCheck: latest
          ? {
              success: latest.success,
              // 展示首包延迟（TTFT）；检测失败时后端返回 null，避免"不可用却有延迟数据"
              ttftMs: latest.success ? latest.ttftMs : null,
              tokensPerSec: latest.success ? latest.tokensPerSec : null,
              errorMessage: latest.errorMessage ?? null,
              createdAt: latest.createdAt,
            }
          : null,
      };
    }),
  });
}
