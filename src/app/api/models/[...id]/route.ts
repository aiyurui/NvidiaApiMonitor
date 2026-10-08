import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEntryAccess } from "@/lib/entry-guard";

// Next.js 要求 catch-all 必须是 URL 最后一段，因此无法使用
// [...id]/history/route.ts（启动即报 Catch-all must be the last part）。
// 采用尾段 catch-all + 派发：/api/models/<modelId 允许含 /…>/history
export async function GET(
  req: Request,
  { params }: { params: { id: string[] } },
) {
  const entryDenied = await requireEntryAccess(); if (entryDenied) return entryDenied;
  const segs = params.id;
  if (segs.length < 2 || segs[segs.length - 1] !== "history") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const modelId = segs.slice(0, -1).join("/");
  const model = await prisma.model.findUnique({ where: { modelId } });
  if (!model) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const range = searchParams.get("range");
  const take = range === "7d" ? 336 : 48;

  const checks = await prisma.healthCheck.findMany({
    where: { modelId: model.id },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      createdAt: true,
      success: true,
      ttftMs: true,
      tokensPerSec: true,
    },
  });

  return NextResponse.json({ data: checks });
}
