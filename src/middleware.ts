import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";

// 未登录时：API 路由返回 401 JSON（方便前端/脚本判断），页面路由跳转到登录页。
export async function middleware(req: NextRequest) {
  // 显式指定 cookieName + secureCookie:false，与 auth.ts 的 cookies 配置保持一致。
  // 否则 Edge 中间件会把内部 HTTP 连接误判为非安全，去找不带前缀的 Cookie，
  // 而 Node 路由（经反代看到 HTTPS）写的是带前缀的 Cookie，二者对不上会触发后台死循环。
  const token = await getToken({
    req,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: false,
  });
  if (token) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
