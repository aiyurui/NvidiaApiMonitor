import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { deserializeTags, serializeTags } from "@/lib/services/filter";
import { getSettings } from "@/lib/settings";
import { prisma } from "@/lib/prisma";

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const model = await prisma.model.findUnique({ where: { id: params.id } });
  if (!model) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.isSpecialized !== undefined && typeof body.isSpecialized !== "boolean") {
    return NextResponse.json({ error: "invalid isSpecialized" }, { status: 400 });
  }

  let updated = model;
  if (typeof body?.isSpecialized === "boolean") {
    const wantSpecialized = body.isSpecialized;
    // 用 getSettings()（内部 upsert 自愈）而不是 findUniqueOrThrow：
    // Settings 表为空时后者直接 500 —— 而「专用模型」开关完全独立于设置页，
    // 新部署后第一次勾选就会踩到。
    const { blacklistModelIds: blacklist } = await getSettings();
    let nextBlacklist: string[];
    if (wantSpecialized) {
      nextBlacklist = blacklist.includes(model.modelId) ? blacklist : [...blacklist, model.modelId];
    } else {
      nextBlacklist = blacklist.filter((id) => id !== model.modelId);
    }
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { blacklistModelIds: JSON.stringify(nextBlacklist) },
      create: { id: "singleton", blacklistModelIds: JSON.stringify(nextBlacklist) },
    });

    let tags = deserializeTags(model.specializedTags);
    if (wantSpecialized) {
      if (!tags.includes("blacklist")) tags = [...tags, "blacklist"];
    } else {
      tags = tags.filter((t) => t !== "blacklist");
    }
    updated = await prisma.model.update({
      where: { id: params.id },
      data: { isSpecialized: wantSpecialized, specializedTags: serializeTags(tags) },
    });
  }

  return NextResponse.json({ ...updated, specializedTags: deserializeTags(updated.specializedTags) });
}
