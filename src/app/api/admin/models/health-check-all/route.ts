import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { runHealthJob, withJobLock } from "@/lib/jobs";

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const result = await withJobLock(runHealthJob);
    if (result === null) return NextResponse.json({ error: "job running" }, { status: 409 });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
