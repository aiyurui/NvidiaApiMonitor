import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

function maskKey(encrypted: string): string {
  try {
    const plain = decryptSecret(encrypted);
    if (!plain) return "****";
    return `${plain.slice(0, 4)}****`;
  } catch {
    return "****";
  }
}

function toPublic(row: {
  id: string; name: string; baseUrl: string; enabled: boolean; priority: number;
  lastUsedAt: Date | null; cooledUntil: Date | null; createdAt: Date; updatedAt: Date; key: string;
}) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    priority: row.priority,
    lastUsedAt: row.lastUsedAt,
    cooledUntil: row.cooledUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    keyMasked: maskKey(row.key),
  };
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const existing = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const data: { name?: string; baseUrl?: string; enabled?: boolean; priority?: number; key?: string } = {};
  if (body?.name !== undefined && typeof body.name === "string" && body.name.trim() !== "") {
    data.name = body.name;
  }
  if (body?.baseUrl !== undefined && typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
    data.baseUrl = body.baseUrl;
  }
  if (body?.enabled !== undefined && typeof body.enabled === "boolean") {
    data.enabled = body.enabled;
  }
  if (body?.priority !== undefined && typeof body.priority === "number" && Number.isInteger(body.priority)) {
    data.priority = body.priority;
  }
  if (typeof body?.key === "string" && body.key !== "") {
    try {
      data.key = encryptSecret(body.key);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "failed to encrypt api key" }, { status: 500 });
    }
  }
  const updated = await prisma.apiKey.update({ where: { id: params.id }, data });
  return NextResponse.json(toPublic(updated));
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const existing = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.apiKey.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
