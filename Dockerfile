# ============================================================
# Next.js 14 + Prisma(SQLite) 生产镜像
#
# 为什么用容器：Prisma 的查询引擎是平台相关二进制，
# 在 Windows 上跑 npx prisma generate 再拷到 Linux 一定跑不起来。
# 用容器构建 => 构建环境天然就是 Linux，彻底绕开这个坑。
#
# 构建：docker compose build
# 启动：docker compose up -d
# 完整部署说明见 deploy/DOCKER.md
# ============================================================

# ---------- 阶段 1：安装依赖 ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# 保留 devDependencies：next build 需要 typescript / tailwind / eslint-config-next，
# 运行期 seed 也需要 tsx（deploy/docker-entrypoint.sh 里会调）。
RUN npm ci --include=dev --no-audit --no-fund

# ---------- 阶段 2：构建 ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 清掉群晖 NAS 自动生成的元数据目录 —— 这不是可选项。
#
# DSM 的索引服务会在它扫描过的目录里创建 `@eaDir`。而 Next.js App Router 把
# **任何以 `@` 开头的目录当成并行路由插槽（parallel route slot）**，于是
# `src/app/admin/@eaDir` 会让 Next 生成的 `LayoutProps` 多出一个必填的 `eaDir`：
#     Type error: Type '{ children: ReactNode; }' does not satisfy the constraint 'LayoutProps'.
#     Property 'eaDir' is missing in type '{ children: ReactNode }' but required in type 'LayoutProps'.
#     Failed to compile.  →  Next.js build worker exited with code: 1
# 这个错误信息完全不提 NAS，极难定位，所以在构建阶段直接物理清除。
# `.dockerignore` 里也已排除，这里是第二道防线（防止 DSM 在构建前又生成一次）。
RUN find . -type d \( -name '@eaDir' -o -name '#recycle' -o -name '@tmp' -o -name '@SynoEAStream' \) -prune -exec rm -rf {} + \
    && find . -type f \( -name 'Thumbs.db' -o -name 'desktop.ini' -o -name '.DS_Store' \) -delete \
    && echo "[build] NAS 元数据目录已清理，残留：$(find . -name '@eaDir' | wc -l) 个"

# ⚠️ 下面三个是「构建期占位符」，不是真实凭据。
#
# 为什么必须有：`next build` 会在 "Collecting page data" 阶段**求值路由处理器**，
# 而 src/lib/auth.ts 在 NODE_ENV=production 且 NEXTAUTH_SECRET 缺失或 <32 字符时
# 会在**模块加载期直接抛错**，导致整个构建失败：
#     Error: Failed to collect page data for /api/admin/api-keys
# Docker 构建上下文里没有 .env（已 dockerignore），所以必须在这里补上占位值。
#
# 为什么安全：这些 ENV 只存在于 builder 阶段；runner 阶段是独立的 FROM，
# 只 COPY 文件、不继承 ENV，因此占位符不会进入最终镜像。
# 真实密钥由 docker compose 在**运行时**通过 env_file 注入。
ENV NEXTAUTH_SECRET="build-time-placeholder-not-used-at-runtime-0123456789"
ENV ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
ENV DATABASE_URL="file:/tmp/build-placeholder.db"
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# 构建前自检：把关键变量打出来，并断言长度。
# 若构建仍失败，日志里就能直接看出是「占位符没生效」，
# 而不是只看到一句无法定位的 "Next.js build worker exited with code: 1 and signal: null"。
RUN node -e "\
  const s = process.env.NEXTAUTH_SECRET || ''; \
  const k = process.env.ENCRYPTION_KEY || ''; \
  const u = process.env.DATABASE_URL || ''; \
  console.log('[build] NEXT_PHASE            = ' + process.env.NEXT_PHASE); \
  console.log('[build] NEXTAUTH_SECRET  len  = ' + s.length + (s.length >= 32 ? '  OK' : '  TOO SHORT')); \
  console.log('[build] ENCRYPTION_KEY   len  = ' + k.length + (k.length === 64 ? '  OK' : '  BAD')); \
  console.log('[build] DATABASE_URL         = ' + u); \
  if (s.length < 32 || k.length !== 64 || !u) { throw new Error('build-time placeholders missing'); }"

# 生成 linux 平台的 Prisma Client，然后构建
RUN npx prisma generate && npm run build

# ---------- 阶段 3：运行 ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# 注意：不要在这里设 NEXTAUTH_SECRET / ENCRYPTION_KEY / DATABASE_URL，
# 它们必须由运行时环境提供（compose 的 env_file + environment）。
COPY --from=builder /app/node_modules   ./node_modules
COPY --from=builder /app/.next          ./.next
COPY --from=builder /app/prisma         ./prisma
COPY --from=builder /app/package.json   ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/models/stats >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
