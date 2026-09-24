#!/usr/bin/env sh
# ============================================================
# 容器启动入口 —— 目标：**没有 .env 也能一键跑起来**
#
# 启动序列：
#   ① 校验数据库目录可写
#   ② 密钥：环境变量 > data 卷里已持久化的 > 自动生成（生成后落盘复用）
#   ③ prisma db push（同步表结构，幂等）
#   ④ 首次启动（User 表为空）自动 seed：管理员 / 全局设置 / 默认用例 / 人工评分
#   ⑤ 打印访问信息 → 拉起 Next.js
#
# 设计原则
#   - **密钥必须持久化**：绝不能每次重启换一把。ENCRYPTION_KEY 变了，库里已存的
#     NVIDIA API Key 全部解不开；NEXTAUTH_SECRET 变了，所有会话立刻失效。
#     因此生成后写入 $DB_DIR/.secrets.env，写不进去就直接失败退出。
#   - **早失败**：目录不可写、显式给了但非法的密钥，都在启动时报清楚。
#   - 想完全手工控制，就把 NEXTAUTH_SECRET / ENCRYPTION_KEY / ADMIN_PASSWORD 写进 .env，
#     环境变量的优先级永远高于自动生成。
# ============================================================
set -e

log() { printf '[entrypoint] %s\n' "$*"; }
die() { printf '[entrypoint] 致命错误：%s\n' "$*" >&2; exit 1; }

gen_hex() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
gen_password() { node -e "process.stdout.write(require('crypto').randomBytes(9).toString('base64url'))"; }
bcrypt_hash() { node -e "process.stdout.write(require('bcryptjs').hashSync(process.argv[1],10))" "$1"; }

# ---------- ① 数据库路径 ----------
DATABASE_URL="${DATABASE_URL:-file:/data/prod.db}"
case "$DATABASE_URL" in
  file:*) DB_PATH="${DATABASE_URL#file:}" ;;
  *) die "本项目只支持 SQLite，DATABASE_URL 必须以 file: 开头（当前：$DATABASE_URL）" ;;
esac

DB_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DB_DIR" 2>/dev/null || true
[ -w "$DB_DIR" ] || die "目录 $DB_DIR 不可写。请检查挂载卷权限（data 目录需可写）。"

log "数据库      : $DB_PATH"
log "时区        : ${TZ:-<未设置，将按容器默认 UTC 计算“今日”>}"

# ---------- ② 密钥 ----------
# 持久化文件放在数据库同目录 —— 它跟数据库是同一份"必须一起备份"的状态。
SECRETS_FILE="${SECRETS_FILE:-$DB_DIR/.secrets.env}"
umask 077

read_secret() {
  [ -f "$SECRETS_FILE" ] || return 0
  # 取最后一次出现的那行（重复定义时以最新的为准），并去掉两侧引号
  sed -n "s/^$1=//p" "$SECRETS_FILE" | tail -n 1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

add_secret() {
  printf "%s='%s'\n" "$1" "$2" >> "$SECRETS_FILE" || die "无法写入 $SECRETS_FILE（data 目录需可写才能保存密钥）"
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
}

# NEXTAUTH_SECRET：>=32 字符
if [ -n "${NEXTAUTH_SECRET:-}" ]; then
  [ "${#NEXTAUTH_SECRET}" -ge 32 ] || die "NEXTAUTH_SECRET 至少 32 字符（当前 ${#NEXTAUTH_SECRET}）。生成：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  log "NEXTAUTH_SECRET : 来自环境变量"
else
  NEXTAUTH_SECRET="$(read_secret NEXTAUTH_SECRET)"
  if [ -z "$NEXTAUTH_SECRET" ]; then
    NEXTAUTH_SECRET="$(gen_hex 32)"
    add_secret NEXTAUTH_SECRET "$NEXTAUTH_SECRET"
    log "NEXTAUTH_SECRET : 已自动生成并保存到 $SECRETS_FILE"
  else
    log "NEXTAUTH_SECRET : 复用 $SECRETS_FILE"
  fi
  export NEXTAUTH_SECRET
fi

# ENCRYPTION_KEY：必须 64 位 hex（AES-256-GCM，32 字节）
if [ -n "${ENCRYPTION_KEY:-}" ]; then
  [ "${#ENCRYPTION_KEY}" -eq 64 ] || die "ENCRYPTION_KEY 必须是 64 位 hex（当前 ${#ENCRYPTION_KEY} 字符）。生成：openssl rand -hex 32"
  log "ENCRYPTION_KEY  : 来自环境变量"
else
  ENCRYPTION_KEY="$(read_secret ENCRYPTION_KEY)"
  if [ -z "$ENCRYPTION_KEY" ]; then
    ENCRYPTION_KEY="$(gen_hex 32)"
    add_secret ENCRYPTION_KEY "$ENCRYPTION_KEY"
    log "ENCRYPTION_KEY  : 已自动生成并保存到 $SECRETS_FILE"
  else
    log "ENCRYPTION_KEY  : 复用 $SECRETS_FILE"
  fi
  export ENCRYPTION_KEY
fi

# NEXTAUTH_URL 不再必需：compose 里 AUTH_TRUST_HOST=1 时，next-auth 会按请求的
# Host / X-Forwarded-Host 推导 origin，客户端也走相对路径。
# 仍然支持显式指定（例如固定用某个域名对外），它优先级最高。
if [ -n "${NEXTAUTH_URL:-}" ]; then
  log "NEXTAUTH_URL    : $NEXTAUTH_URL（显式指定）"
else
  log "NEXTAUTH_URL    : 未设置 —— 按访问地址自动推导（无需配置）"
fi

# ---------- ③ 表结构（幂等；可用 DB_PUSH_ON_START=0 关闭）----------
if [ "${DB_PUSH_ON_START:-1}" = "1" ]; then
  log "同步表结构（prisma db push）…"
  # 用本地二进制而非 npx：避免启动时因联网拉包失败
  if ! ./node_modules/.bin/prisma db push --skip-generate; then
    echo "[entrypoint] prisma db push 失败。" >&2
    echo "[entrypoint] 若提示需要 --accept-data-loss（会删除列/丢数据），请人工确认后手动执行：" >&2
    echo "[entrypoint]   docker compose run --rm app /app/node_modules/.bin/prisma db push --skip-generate --accept-data-loss" >&2
    exit 1
  fi
fi

# ---------- ④ 首次启动自动 seed ----------
# 判据是「User 表是否为空」，不是有没有 .env —— 这样 SEED=1 这个易忘的开关就不需要了。
# 优先用镜像里自带的 sqlite3（快）；没有时退回 Prisma，避免因缺工具而误判成"空库"。
count_users() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" 'SELECT count(*) FROM User;' 2>/dev/null && return 0
  fi
  node -e "
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.user.count()
      .then((n) => { process.stdout.write(String(n)); process.exit(0); })
      .catch(() => process.exit(1));
  " 2>/dev/null
}

USER_COUNT="$(count_users || true)"
USER_COUNT="$(printf '%s' "$USER_COUNT" | tr -d '[:space:]')"
NEED_SEED=0
if [ "${SEED_FORCE:-0}" = "1" ]; then
  NEED_SEED=1
  log "初始数据    : SEED_FORCE=1，强制执行"
elif [ -z "$USER_COUNT" ]; then
  log "初始数据    : 读不到 User 表（可能不是合法数据库），跳过 seed"
elif [ "$USER_COUNT" = "0" ]; then
  NEED_SEED=1
else
  log "初始数据    : 已有 $USER_COUNT 个账号，跳过 seed"
fi

if [ "$NEED_SEED" = "1" ]; then
  # 管理员凭据优先级：ADMIN_PASSWORD_HASH > ADMIN_PASSWORD > 随机生成
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
  export ADMIN_EMAIL
  FIRST_TIME_PASSWORD=""
  if [ -n "${ADMIN_PASSWORD_HASH:-}" ]; then
    log "管理员密码  : 使用环境变量 ADMIN_PASSWORD_HASH"
  elif [ -n "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD_HASH="$(bcrypt_hash "$ADMIN_PASSWORD")"
    export ADMIN_PASSWORD_HASH
    log "管理员密码  : 使用环境变量 ADMIN_PASSWORD"
  else
    ADMIN_PASSWORD_HASH="$(read_secret ADMIN_PASSWORD_HASH)"
    if [ -z "$ADMIN_PASSWORD_HASH" ]; then
      FIRST_TIME_PASSWORD="$(gen_password)"
      ADMIN_PASSWORD_HASH="$(bcrypt_hash "$FIRST_TIME_PASSWORD")"
      add_secret ADMIN_PASSWORD_HASH "$ADMIN_PASSWORD_HASH"
      add_secret ADMIN_PASSWORD "$FIRST_TIME_PASSWORD"
    fi
    export ADMIN_PASSWORD_HASH
    log "管理员密码  : 已自动生成并保存到 $SECRETS_FILE"
  fi

  log "写入初始数据（管理员 / 全局设置 / 默认测试用例 / 人工评分）…"
  ./node_modules/.bin/tsx prisma/seed.ts

  if [ -n "$FIRST_TIME_PASSWORD" ]; then
    printf '\n============================================================\n'
    printf ' 首次启动完成 —— 请记下这个登录信息\n'
    printf ' （也可在 %s 里找回）\n' "$SECRETS_FILE"
    printf '   登录邮箱：%s\n' "$ADMIN_EMAIL"
    printf '   初始密码：%s\n' "$FIRST_TIME_PASSWORD"
    printf ' 建议登录后在「账号设置」里改成自己的密码。\n'
    printf '============================================================\n\n'
  fi
fi

log "启动 Next.js…"
exec "$@"
