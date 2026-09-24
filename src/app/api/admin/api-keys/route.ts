import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

type ApiKeyRow = {
  id: string;
  name: string;
  key: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  lastUsedAt: Date | null;
  cooledUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function maskKey(encrypted: string): string {
  try {
    const plain = decryptSecret(encrypted);
    if (!plain) return "****";
    return `${plain.slice(0, 4)}****`;
  } catch {
    return "****";
  }
}

function toPublic(row: ApiKeyRow) {
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

export async function GET() {
  const denied = await requireAdmin(); if (denied) return denied;
  const rows = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ data: rows.map(toPublic) });
}

export async function POST(req: Request) {
  const denied = await requireAdmin(); if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = body?.name;
  const key = body?.key;
  if (typeof name !== "string" || name.trim() === "" || typeof key !== "string" || key === "") {
    return NextResponse.json({ error: "name and key are required" }, { status: 400 });
  }
  const baseUrl = typeof body?.baseUrl === "string" && body.baseUrl.trim() !== ""
    ? body.baseUrl
    : DEFAULT_BASE_URL;
  const priority = typeof body?.priority === "number" && Number.isInteger(body.priority)
    ? body.priority
    : 0;
  let encrypted: string;
  try {
    encrypted = encryptSecret(key);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed to encrypt api key" }, { status: 500 });
  }
  const created = await prisma.apiKey.create({
    data: { name, key: encrypted, baseUrl, priority },
  });
  return NextResponse.json(toPublic(created));
}
