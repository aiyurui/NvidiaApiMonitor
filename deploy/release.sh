#!/usr/bin/env bash
# ============================================================
# 发布 / 更新脚本（在服务器上、项目根目录执行）
#   bash deploy/release.sh            # 常规发布
#   bash deploy/release.sh --fresh    # 首次发布（含建库 + seed）
#
# ⚠️ 必须在 Linux 上执行本脚本。
#    Prisma 的查询引擎是平台相关的二进制，Windows 上生成的 node_modules
#    直接拷到 Linux 会报「Query engine binary not found / ENOENT」。
#    同理 node_modules 与 .next 都不要跨平台拷贝。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
FRESH=0
[[ "${1:-}" == "--fresh" ]] && FRESH=1

echo "=========================================="
echo " 发布目录：$APP_DIR"
echo " 模式：$([[ $FRESH -eq 1 ]] && echo '首次发布（建库+seed）' || echo '常规更新')"
echo "=========================================="

# ---------- 0. 前置检查 ----------
if [[ ! -f .env ]]; then
  echo "✗ 缺少 .env，请先：cp deploy/env.production.example .env 并填好内容" >&2
  exit 1
fi
# 从 .env 读 DATABASE_URL（去掉引号），用于建库与备份
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')"
DB_PATH="${DB_URL#file:}"
echo "数据库文件：$DB_PATH"

if [[ "$DB_PATH" != /* ]]; then
  echo "⚠️  DATABASE_URL 不是绝对路径。生产环境强烈建议改成 file:/绝对/路径/prod.db，" >&2
  echo "    否则 Prisma CLI 与运行时对相对路径的解析基准可能不一致。" >&2
fi
mkdir -p "$(dirname "$DB_PATH")"

# NEXTAUTH_SECRET 长度校验。
# 注意这个值不只在运行期需要 —— `next build` 会在 "Collecting page data" 阶段
# 求值路由处理器，而 src/lib/auth.ts 在 NODE_ENV=production 下若密钥缺失或 <32 字符
# 会于模块加载期直接抛错，构建会以「Failed to collect page data」失败。
# 所以这里提前拦住，避免跑到第 5 步才失败。
SECRET_LEN="$(grep -E '^NEXTAUTH_SECRET=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'' | tr -d '\r' | wc -c)"
if [[ "$SECRET_LEN" -lt 33 ]]; then
  echo "✗ NEXTAUTH_SECRET 少于 32 字符（当前 $((SECRET_LEN-1))），生产环境启动会直接报错" >&2
  echo "  生成：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
  exit 1
fi

# ENCRYPTION_KEY 校验（AES-256-GCM 要求 32 字节 hex；长度不对会在首次加解密时抛错）
KEY_LEN="$(grep -E '^ENCRYPTION_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'' | tr -d '\r' | wc -c)"
if [[ "$KEY_LEN" -ne 65 ]]; then
  echo "✗ ENCRYPTION_KEY 必须是 64 位 hex（当前 $((KEY_LEN-1)) 字符）" >&2
  echo "  生成：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
  echo "  ⚠️ 若在迁移已有数据库，这里必须沿用【旧机器上的原值】，否则已入库的 API Key 全部解不开。" >&2
  exit 1
fi

# ---------- 1. 备份现有数据库 ----------
if [[ -f "$DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BAK_DIR="$APP_DIR/backup"
  mkdir -p "$BAK_DIR"
  # 必须用 .backup，直接 cp 在有写事务时可能拷到不一致的快照
  sqlite3 "$DB_PATH" ".backup '$BAK_DIR/prod-$TS.db'"
  echo "✓ 已备份数据库 → backup/prod-$TS.db"
fi

# ---------- 2. 安装依赖 ----------
echo "==> npm ci"
# --include=dev：next build 需要 typescript / tailwind / eslint-config-next
export NODE_ENV=development
npm ci --include=dev --no-audit --no-fund
export NODE_ENV=production

# ---------- 3. 生成 Prisma Client（本机平台）----------
echo "==> prisma generate"
npx prisma generate

# ---------- 4. 同步表结构 ----------
if [[ $FRESH -eq 1 ]]; then
  echo "==> prisma db push（建库）"
  npx prisma db push
  echo "==> prisma db seed"
  npm run db:seed
else
  # 常规更新：schema 没变时跳过，变了才推
  echo "==> prisma db push（增量）"
  npx prisma db push --skip-generate
fi

# ---------- 4.5 清理 NAS 元数据（群晖特有）----------
# DSM 的索引服务会在它扫描过的目录里生成 `@eaDir`。而 Next.js App Router 会把
# **任何以 `@` 开头的目录当成并行路由插槽（parallel route slot）**，于是
# src/app/admin/@eaDir 会让 admin 的 layout 类型检查失败：
#     Property 'eaDir' is missing in type '{ children: ReactNode }' but required in type 'LayoutProps'
# 报错里一个字都没提 NAS，极难定位 —— 所以在构建前直接物理清除。
JUNK_COUNT="$(find . -not -path './node_modules/*' -not -path './.next/*' -type d -name '@eaDir' 2>/dev/null | wc -l || true)"
JUNK_COUNT="${JUNK_COUNT// /}"
if [[ "${JUNK_COUNT:-0}" -gt 0 ]]; then
  echo "==> 清理 $JUNK_COUNT 个 NAS 元数据目录（@eaDir 等）"
  find . -not -path './node_modules/*' -not -path './.next/*' -type d \
    \( -name '@eaDir' -o -name '#recycle' -o -name '@tmp' -o -name '@SynoEAStream' \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
  find . -not -path './node_modules/*' -not -path './.next/*' -type f \
    \( -name 'Thumbs.db' -o -name 'desktop.ini' -o -name '.DS_Store' \) -delete 2>/dev/null || true
else
  echo "==> 无 NAS 元数据目录（@eaDir）需要清理"
fi

# ---------- 5. 构建 ----------
echo "==> next build"
NEXT_TELEMETRY_DISABLED=1 npm run build

# ---------- 6. 重启 ----------
echo "==> pm2 reload"
if pm2 describe nvidia-api-monitor >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

# ---------- 7. 健康检查 ----------
echo "==> 等待服务就绪"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/api/models/stats" >/dev/null 2>&1; then
    echo "✓ 发布成功，服务已响应（$(date '+%F %T')）"
    curl -fsS "http://127.0.0.1:3000/api/models/stats" | head -c 300
    echo
    echo "--- 最近日志 ---"
    pm2 logs nvidia-api-monitor --lines 15 --nostream
    exit 0
  fi
  sleep 1
done

echo "✗ 30 秒内服务未就绪，请查看日志：" >&2
echo "  pm2 logs nvidia-api-monitor --lines 50" >&2
exit 1
