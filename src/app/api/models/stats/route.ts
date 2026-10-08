import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isProbeFresh } from "@/lib/services/model-sync";
import { requireEntryAccess } from "@/lib/entry-guard";
import { getProbeValidityMs } from "@/lib/settings";

/**
 * 强制请求时执行。
 *
 * Next.js 14 会默认把「不读取 request 的无参 GET 路由处理器」在 `next build` 时
 * 静态预渲染 —— 那会让线上这个接口永远返回构建那一刻的统计快照，
 * 而前端每 30 秒轮询的就是它（dev 模式不静态化，所以只在生产构建里暴露）。
 * 本接口必须每次请求都重新查库，因此显式声明为动态。
 */
export const dynamic = "force-dynamic";

const AVAILABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const entryDenied = await requireEntryAccess(); if (entryDenied) return entryDenied;
  const total = await prisma.model.count({
    where: { isActive: true, isSpecialized: false },
  });

  const since = new Date(Date.now() - AVAILABILITY_WINDOW_MS);
  const [models, checkTotals, successAgg, tpsAgg] = await Promise.all([
    // 可用状态只需模型自身的同步探测字段(lastProbeOk/lastProbeAt)，无需 join 健检记录
    prisma.model.findMany({
      where: { isActive: true, isSpecialized: false },
    }),
    prisma.healthCheck.groupBy({
      by: ["success"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.healthCheck.aggregate({
      where: { createdAt: { gte: since }, success: true },
      _avg: { ttftMs: true },
      _count: { _all: true },
    }),
    prisma.healthCheck.aggregate({
      // 排除历史脏数据（tokensPerSec=0 的旧记录）以免拉低均值
      where: { createdAt: { gte: since }, success: true, tokensPerSec: { gt: 0 } },
      _avg: { tokensPerSec: true },
    }),
  ]);

  const validMs = await getProbeValidityMs();
  const now = new Date();
  let available = 0;
  let down = 0;
  let untested = 0;
  for (const m of models) {
    // 可用状态以「同步探测」(lastProbeOk) 为准；健检(healthCheck)只展示延迟/TPS，不改变可用状态。
    // 探测结论在滚动时效窗口内（max(24h, 同步间隔+2h)）才区分可用/不可用，否则未测
    // （滚动窗口消除"过 0 点集体过期"的断崖，与 /api/models 同一判定）。
    const fresh = isProbeFresh(m.lastProbeAt ? new Date(m.lastProbeAt) : null, now, validMs);
    if (m.lastProbeOk === true && fresh) {
      available += 1;
    } else if (m.lastProbeOk === false && fresh) {
      down += 1;
    } else {
      untested += 1;
    }
  }

  // 可用率 = 24h 内成功检测数 / 总检测数（成功：30s 内有任何响应）
  const totalChecks = checkTotals.reduce((acc, g) => acc + g._count._all, 0);
  const okChecks = checkTotals
    .filter((g) => g.success)
    .reduce((acc, g) => acc + g._count._all, 0);
  const availabilityRate = totalChecks > 0 ? okChecks / totalChecks : null;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [agg, lastHealthRun, healthChecksToday, healthRunsToday] = await Promise.all([
    prisma.model.aggregate({
      where: { isActive: true, isSpecialized: false },
      _max: { lastSeenAt: true },
    }),
    // 最近一次全量健检，用于首页判断"调度是否还在跑"
    prisma.syncRun.findFirst({ where: { kind: "health" }, orderBy: { createdAt: "desc" } }),
    // 今日累计探测动作数（每条 healthCheck = 一次单模型×单用例探测）
    prisma.healthCheck.count({ where: { createdAt: { gte: startOfDay } } }),
    // 今日健检轮数
    prisma.syncRun.count({ where: { kind: "health", createdAt: { gte: startOfDay } } }),
  ]);

  return NextResponse.json({
    total,
    available,
    down,
    untested,
    availabilityRate,
    availabilityOk: okChecks,
    availabilityTotal: totalChecks,
    avgTtftMs: successAgg._avg.ttftMs ?? null,
    avgTps: tpsAgg._avg.tokensPerSec ?? null,
    lastSyncAt: agg._max.lastSeenAt,
    lastHealthRunAt: lastHealthRun?.finishedAt ?? null,
    lastHealthChecked: lastHealthRun?.checkedCount ?? null,
    healthChecksToday,
    healthRunsToday,
  });
}
