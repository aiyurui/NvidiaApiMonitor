import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

// modelId 含 "/"（如 "meta/llama-3.2-11b"），必须用 catch-all 接收后 join。
export async function PUT(
  req: Request,
  { params }: { params: { modelId: string[] } },
) {
  const denied = await requireAdmin(); if (denied) return denied;
  const modelId = params.modelId.join("/");
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    typeof body?.score !== "number" ||
    !Number.isInteger(body.score) ||
    body.score < 0 ||
    body.score > 100
  ) {
    return NextResponse.json({ error: "invalid score (must be integer 0-100)" }, { status: 400 });
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "invalid note" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note : null;
  const saved = await prisma.manualScore.upsert({
    where: { modelId },
    update: { score: body.score, note },
    create: { modelId, score: body.score, note },
  });
  return NextResponse.json(saved);
}

export async function DELETE(_req: Request, { params }: { params: { modelId: string[] } }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const modelId = params.modelId.join("/");
  const existing = await prisma.manualScore.findUnique({ where: { modelId } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.manualScore.delete({ where: { modelId } });
  return NextResponse.json({ ok: true });
}
