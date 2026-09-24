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

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const existing = await prisma.testCase.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const data: { name?: string; description?: string | null; messages?: string; maxTokens?: number; temperature?: number; enabled?: boolean } = {};
  if (body?.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return NextResponse.json({ error: "invalid name" }, { status: 400 });
    }
    data.name = body.name;
  }
  if (body?.description !== undefined) {
    if (typeof body.description !== "string") {
      return NextResponse.json({ error: "invalid description" }, { status: 400 });
    }
    data.description = body.description === "" ? null : body.description;
  }
  if (body?.messages !== undefined) {
    const messages = normalizeMessages(body.messages);
    if (!messages.ok) {
      return NextResponse.json({ error: "messages must be a JSON array" }, { status: 400 });
    }
    data.messages = messages.stored;
  }
  if (body?.maxTokens !== undefined) {
    if (typeof body.maxTokens !== "number" || !Number.isInteger(body.maxTokens) || body.maxTokens <= 0) {
      return NextResponse.json({ error: "invalid maxTokens" }, { status: 400 });
    }
    data.maxTokens = body.maxTokens;
  }
  if (body?.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      return NextResponse.json({ error: "invalid temperature" }, { status: 400 });
    }
    data.temperature = body.temperature;
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "invalid enabled" }, { status: 400 });
    }
    data.enabled = body.enabled;
  }
  const updated = await prisma.testCase.update({ where: { id: params.id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const existing = await prisma.testCase.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.testCase.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
