import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * 容器健康检查专用端点 —— **不设入口密码门禁**。
 *
 * 为什么不能用 /api/models/stats 做健康检查：全局入口密码启用后该接口对
 * 未解锁的访问者返回 401，Docker HEALTHCHECK / install.sh 的健康等待
 * 会把容器误判为 unhealthy。
 *
 * 顺带 ping 一下数据库（SELECT 1）：Web 活着但 DB 挂了（卷损坏/锁死）
 * 也应视为不健康。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "db unavailable" },
      { status: 503 },
    );
  }
}
