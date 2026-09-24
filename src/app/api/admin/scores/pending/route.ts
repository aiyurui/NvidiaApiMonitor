import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const scored = await prisma.manualScore.findMany({ select: { modelId: true } });
  const scoredIds = scored.map((s) => s.modelId);
  const pending = await prisma.model.findMany({
    where: { isActive: true, isSpecialized: false, modelId: { notIn: scoredIds } },
    select: { id: true, modelId: true, name: true, discoveredAt: true },
    orderBy: { discoveredAt: "desc" },
  });
  return NextResponse.json({ data: pending });
}
