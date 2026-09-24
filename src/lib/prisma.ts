import { PrismaClient } from "@prisma/client";

// 不使用自定义路径解析：DATABASE_URL="file:./dev.db" 由 Prisma 默认按 schema 目录解析为 prisma/dev.db，
// 与 prisma CLI / seed / 独立 @prisma/client 完全一致，避免 DB 文件错配（曾因 cwd 解析导致读写不同文件）。
// 构建期（next build 的 "Collecting page data" 阶段）会 import 本模块并实例化 PrismaClient。
// 容器构建上下文里没有 .env（已被 .dockerignore 排除），缺 DATABASE_URL 会让 build worker
// 直接崩溃，同样只报出那句难以定位的
//     Next.js build worker exited with code: 1 and signal: null
// 这里给构建期补一个临时占位，让 `next build` 与运行环境**完全解耦**。
// 运行期必须有真实 DATABASE_URL，由 deploy/docker-entrypoint.sh 在启动前校验。
if (process.env.NEXT_PHASE === "phase-production-build" && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:/tmp/next-build-placeholder.db";
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
