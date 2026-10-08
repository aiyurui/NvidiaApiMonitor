import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isProbeFresh } from "@/lib/services/model-sync";
import { requireEntryAccess } from "@/lib/entry-guard";
import { getProbeValidityMs } from "@/lib/settings";

/** 可用率统计窗口 */
const AVAILABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const entryDenied = await requireEntryAccess(); if (entryDenied) return entryDenied;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // ok | down | untested
  const capability = searchParams.get("capability"); // vision | tools | json
  const sort = searchParams.get("sort") ?? "score"; // score | availability | ttft | tps | updated
  const order = searchParams.get("order") === "asc" ? "asc" : "desc";

  // ManualScore 与 Model 无 Prisma relation（含 modelId 斜杠 key，用 modelId 字符串匹配）：
  // 此处不用 include，分别查询后按 modelId 内存 join。
  const since = new Date(Date.now() - AVAILABILITY_WINDOW_MS);
  const [models, manualScores, checkTotals, checkOks, ttftAvg, tpsAvg] = await Promise.all([
    prisma.model.findMany({
      where: { isActive: true, isSpecialized: false },
      include: {
        healthChecks: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.manualScore.findMany({ select: { modelId: true, score: true } }),
    // 可用率 = 成功检测数 / 总检测数（成功定义为：30s 内有任何响应）
    prisma.healthCheck.groupBy({
      by: ["modelId"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.healthCheck.groupBy({
      by: ["modelId"],
      where: { createdAt: { gte: since }, success: true },
      _count: { _all: true },
    }),
    // 首包 TTFT / TPS 取近 24h 成功检测均值；TPS 排除 0 值（历史脏数据：usage 缺失导致的 0）
    prisma.healthCheck.groupBy({
      by: ["modelId"],
      where: { createdAt: { gte: since }, success: true },
      _avg: { ttftMs: true },
      _count: { _all: true },
    }),
    prisma.healthCheck.groupBy({
      by: ["modelId"],
      where: { createdAt: { gte: since }, success: true, tokensPerSec: { gt: 0 } },
      _avg: { tokensPerSec: true },
    }),
  ]);
  const scoreMap = new Map(manualScores.map((s) => [s.modelId, s.score]));
  const totalMap = new Map(checkTotals.map((g) => [g.modelId, g._count._all]));
  const okMap = new Map(checkOks.map((g) => [g.modelId, g._count._all]));
  const ttftAvgMap = new Map(ttftAvg.map((g) => [g.modelId, g._avg.ttftMs]));
  const tpsAvgMap = new Map(tpsAvg.map((g) => [g.modelId, g._avg.tokensPerSec]));

  const validMs = await getProbeValidityMs();
  const now = new Date();
  const rows = models.map((m) => {
    const latest = m.healthChecks[0] ?? null;
    // 可用状态以「同步探测」(lastProbeOk) 为准；健检(healthCheck)仅用于展示延迟/TPS，不改变可用状态。
    // 探测结论在滚动时效窗口内（max(24h, 同步间隔+2h)）才区分可用/不可用，否则未测
    // （避免陈旧结论一直显示为可用；滚动窗口消除"过 0 点集体过期"的断崖）。
    const fresh = isProbeFresh(m.lastProbeAt ? new Date(m.lastProbeAt) : null, now, validMs);
    const modelStatus =
      m.lastProbeOk === true && fresh ? "ok"
        : m.lastProbeOk === false && fresh ? "down"
        : "untested";
    const checks = totalMap.get(m.id) ?? 0;
    const okChecks = okMap.get(m.id) ?? 0;
    return {
      id: m.id, modelId: m.modelId, name: m.name,
      contextLength: m.contextLength,
      supportsVision: m.supportsVision, supportsTools: m.supportsTools, supportsJson: m.supportsJson,
      status: modelStatus,
      availabilityRate: checks > 0 ? okChecks / checks : null,
      availabilityOk: okChecks,
      availabilityTotal: checks,
      // 首包 TTFT / TPS 均为近 24h 成功检测均值；无成功样本时为 null
      ttftMs: (() => {
        const v = ttftAvgMap.get(m.id);
        return typeof v === "number" ? Math.round(v) : null;
      })(),
      tokensPerSec: (() => {
        const v = tpsAvgMap.get(m.id);
        return typeof v === "number" ? Math.round(v * 100) / 100 : null;
      })(),
      manualScore: scoreMap.get(m.modelId) ?? null,
      lastCheckedAt: latest?.createdAt ?? null,
    };
  }).filter((r) => {
    if (status && r.status !== status) return false;
    if (capability === "vision" && !r.supportsVision) return false;
    if (capability === "tools" && !r.supportsTools) return false;
    if (capability === "json" && !r.supportsJson) return false;
    return true;
  });

  const key = sort === "availability" ? "availabilityRate" : sort === "ttft" ? "ttftMs" : sort === "tps" ? "tokensPerSec" : sort === "updated" ? "lastCheckedAt" : "manualScore";
  rows.sort((a, b) => {
    const av = a[key] ?? (order === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const bv = b[key] ?? (order === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    return order === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });

  return NextResponse.json({ data: rows });
}
