import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { runSyncJob, withJobLock } from "@/lib/jobs";

export async function POST() {
  const denied = await requireAdmin(); if (denied) return denied;
  try {
    // 与定时调度、全量健检走同一把任务锁：避免手动同步与后台任务并发跑（重复全量探测）。
    const summary = await withJobLock(runSyncJob);
    if (summary === null) return NextResponse.json({ error: "job running" }, { status: 409 });
    return NextResponse.json(summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "no available api key" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
