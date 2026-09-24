import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { isSchedulerActive, startScheduler } from "@/lib/scheduler";

/** 手动激活调度器：当 instrumentation 未自动启动（如部署环境未加载 instrumentation）时，
 *  后台可一键拉起定时任务。 */
export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    await startScheduler();
    return NextResponse.json({ ok: true, active: isSchedulerActive() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
