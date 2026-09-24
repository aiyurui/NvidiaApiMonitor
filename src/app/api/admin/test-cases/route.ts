import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

function normalizeMessages(input: unknown): { ok: true; stored: string } | { ok: false } {
  if (Array.isArray(input)) {
    return { ok: true, stored: JSON.stringify(input) };
  }
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (!Array.isArray(parsed)) return { ok: false };
      return { ok: true, stored: input };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const rows = await prisma.testCase.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ data: rows });
}

export async function POST(req: Request) {
  const denied = await requireAdmin(); if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.name !== "string" || body.name.trim() === "" || body?.messages === undefined) {
    return NextResponse.json({ error: "name and messages are required" }, { status: 400 });
  }
  const messages = normalizeMessages(body.messages);
  if (!messages.ok) {
    return NextResponse.json({ error: "messages must be a JSON array" }, { status: 400 });
  }
  const maxTokens = typeof body.maxTokens === "number" && Number.isInteger(body.maxTokens) && body.maxTokens > 0
    ? body.maxTokens
    : 50;
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature)
    ? body.temperature
    : 0.7;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const created = await prisma.testCase.create({
    data: {
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      messages: messages.stored,
      maxTokens,
      temperature,
      enabled,
    },
  });
  return NextResponse.json(created);
}
