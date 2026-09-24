import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const scores = await prisma.manualScore.findMany({ orderBy: { updatedAt: "desc" } });
  const models = await prisma.model.findMany({
    where: { modelId: { in: scores.map((s) => s.modelId) } },
    select: { modelId: true, name: true, isActive: true, isSpecialized: true },
  });
  const modelMap = new Map(models.map((m) => [m.modelId, m]));
  return NextResponse.json({
    data: scores.map((s) => ({
      modelId: s.modelId,
      name: modelMap.get(s.modelId)?.name ?? null,
      isActive: modelMap.get(s.modelId)?.isActive ?? null,
      isSpecialized: modelMap.get(s.modelId)?.isSpecialized ?? null,
      score: s.score,
      note: s.note,
      updatedAt: s.updatedAt,
    })),
  });
}
