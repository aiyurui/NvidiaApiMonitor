import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { getSettings, parseSettings } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import type { ScoringWeights } from "@/types";

const WEIGHT_KEYS = [
  "context", "vision", "tools", "json", "reasoning",
  "code", "multilingual", "longContext", "availability",
] as const;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isValidWeights(v: unknown): v is Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.every(
    ([k, val]) =>
      (WEIGHT_KEYS as readonly string[]).includes(k) &&
      typeof val === "number" &&
      Number.isFinite(val) &&
      val >= 0,
  );
}

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const settings = await getSettings();
  return NextResponse.json(settings);
}

export async function PUT(req: Request) {
  const denied = await requireAdmin(); if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.syncIntervalHours !== undefined && !isPositiveInt(body.syncIntervalHours)) {
    return NextResponse.json({ error: "invalid syncIntervalHours" }, { status: 400 });
  }
  if (body.healthIntervalMin !== undefined && !isPositiveInt(body.healthIntervalMin)) {
    return NextResponse.json({ error: "invalid healthIntervalMin" }, { status: 400 });
  }
  if (body.defaultReasoning !== undefined && typeof body.defaultReasoning !== "boolean") {
    return NextResponse.json({ error: "invalid defaultReasoning" }, { status: 400 });
  }
  if (body.filterKeywords !== undefined && !isStringArray(body.filterKeywords)) {
    return NextResponse.json({ error: "invalid filterKeywords" }, { status: 400 });
  }
  if (body.blacklistModelIds !== undefined && !isStringArray(body.blacklistModelIds)) {
    return NextResponse.json({ error: "invalid blacklistModelIds" }, { status: 400 });
  }
  if (body.scoringWeights !== undefined && !isValidWeights(body.scoringWeights)) {
    return NextResponse.json({ error: "invalid scoringWeights" }, { status: 400 });
  }

  // 用 getSettings()（内部 upsert 自愈 + 已 sanitize 权重）而不是
  // `prisma.settings.findUniqueOrThrow`：Settings 表为空时后者直接 500，
  // 而新库 / 刚被清理过的库恰恰没有这行记录。
  const current = await getSettings();
  const mergedWeights: ScoringWeights =
    body.scoringWeights !== undefined
      ? { ...current.scoringWeights, ...(body.scoringWeights as Partial<ScoringWeights>) }
      : { ...current.scoringWeights };
  if (!isValidWeights(mergedWeights)) {
    return NextResponse.json({ error: "invalid scoringWeights" }, { status: 400 });
  }

  const data: {
    syncIntervalHours?: number; healthIntervalMin?: number; defaultReasoning?: boolean;
    filterKeywords?: string; blacklistModelIds?: string; scoringWeights?: string;
  } = {};
  if (body.syncIntervalHours !== undefined) data.syncIntervalHours = body.syncIntervalHours as number;
  if (body.healthIntervalMin !== undefined) data.healthIntervalMin = body.healthIntervalMin as number;
  if (body.defaultReasoning !== undefined) data.defaultReasoning = body.defaultReasoning as boolean;
  if (body.filterKeywords !== undefined) data.filterKeywords = JSON.stringify(body.filterKeywords);
  if (body.blacklistModelIds !== undefined) data.blacklistModelIds = JSON.stringify(body.blacklistModelIds);
  if (body.scoringWeights !== undefined) data.scoringWeights = JSON.stringify(mergedWeights);

  const updated = await prisma.settings.update({ where: { id: "singleton" }, data });
  const { restartScheduler } = await import("@/lib/scheduler");
  await restartScheduler().catch((e) => console.error("[scheduler] restart failed", e));
  return NextResponse.json(parseSettings(updated));
}
