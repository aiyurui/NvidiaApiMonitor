import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { clearLoginFailures, isLoginBlocked, recordLoginFailure } from "@/lib/login-throttle";
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CALLBACK_COOKIE_NAME,
} from "@/lib/auth-cookie";

// 生产环境必须有 >=32 字符的 NEXTAUTH_SECRET。
//
// ⚠️ 但**构建期必须放过**：`next build` 会在 "Collecting page data" 阶段求值路由处理器，
// 而容器构建上下文里没有 .env（已被 .dockerignore 排除）。若在构建期抛错，抛的是模块级
// 异常，会让 build worker 直接 exit(1)，Next 只会打印一行
//     Next.js build worker exited with code: 1 and signal: null
// 把真实原因（这里这句 Error）完全吞掉，极难定位。
//
// 运行期的兜底由 deploy/docker-entrypoint.sh 与 deploy/release.sh 提前拦截，
// 报错信息比这里明确得多，因此跳过构建期不降低安全性。
const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

if (
  !isProductionBuild &&
  process.env.NODE_ENV === "production" &&
  (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET.length < 32)
) {
  throw new Error("NEXTAUTH_SECRET must be set to a 32+ char secret in production");
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: { email: { type: "text" }, password: { type: "password" } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        if (isLoginBlocked(credentials.email)) return null;
        const user = await prisma.user.findUnique({ where: { email: credentials.email } });
        if (!user) { recordLoginFailure(credentials.email); return null; }
        const ok = await compare(credentials.password, user.password);
        if (!ok) { recordLoginFailure(credentials.email); return null; }
        clearLoginFailures(credentials.email);
        return { id: user.id, email: user.email };
      },
    }),
  ],
  pages: { signIn: "/login" },

  // 固定 Cookie 名称 + 关闭 Secure 前缀，消除「反代 HTTPS 下 Node 与 Edge 中间件
  // 对 Cookie 名字判定不一致」导致的后台无限重定向死循环。
  // 详见 src/lib/auth-cookie.ts 的说明。HTTP（IP 直连）与 HTTPS（域名反代）均可正常使用。
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
    },
    csrfToken: {
      name: CSRF_COOKIE_NAME,
      options: { httpOnly: false, sameSite: "lax", path: "/", secure: false },
    },
    callbackUrl: {
      name: CALLBACK_COOKIE_NAME,
      options: { httpOnly: false, sameSite: "lax", path: "/", secure: false },
    },
  },
};
