import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  ENTRY_COOKIE_NAME,
  ENTRY_HASH_PREFIX_LEN,
  entryTokenSecret,
  signEntryToken,
} from "@/lib/entry-token";
import {
  clearEntryFailures,
  isEntryBlocked,
  recordEntryFailure,
} from "@/lib/entry-throttle";

/** 入口 Cookie 保活时长：30 天（与 next-auth 会话默认时长一致）。
 *  ⚠️ 不导出：App Router 的 route 文件只允许导出 HTTP 方法与特定配置字段，
 *  额外导出会违反 Next 生成的路由类型契约、卡 next build。 */
const ENTRY_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip")?.trim() || "local";
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  if (!body || typeof body.password !== "string" || body.password === "") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const hash = row?.entryPasswordHash ?? null;
  if (typeof hash !== "string" || hash === "") {
    return NextResponse.json({ error: "entry password not configured" }, { status: 400 });
  }

  const ip = clientIp(req);
  if (isEntryBlocked(ip)) {
    return NextResponse.json(
      { error: "尝试次数过多，请 10 分钟后再试" },
      { status: 429 },
    );
  }

  const ok = await compare(body.password, hash);
  if (!ok) {
    recordEntryFailure(ip);
    return NextResponse.json({ error: "入口密码错误" }, { status: 401 });
  }

  clearEntryFailures(ip);
  const token = await signEntryToken(
    hash.slice(0, ENTRY_HASH_PREFIX_LEN),
    entryTokenSecret(),
  );
  const res = NextResponse.json({ ok: true });
  // 与 auth-cookie.ts 同一约定：固定名 + secure:false，IP 直连(HTTP)与域名反代(HTTPS)通用
  res.cookies.set(ENTRY_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ENTRY_COOKIE_MAX_AGE,
    secure: false,
  });
  return res;
}
