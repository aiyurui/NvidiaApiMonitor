#!/usr/bin/env bash
# ============================================================
# SQLite 每日备份（保留 14 天）
# 加到 crontab（在项目根目录执行 crontab -e）：
#   0 3 * * * /srv/nvidia-api-monitor/deploy/backup-db.sh >> /var/log/nvidia-api-monitor/backup.log 2>&1
#
# 数据库路径的解析顺序：
#   1) DB_PATH 环境变量（直接指定 .db 文件，容器部署下最省事）
#   2) DATABASE_URL 环境变量
#   3) 项目根目录 .env 里的 DATABASE_URL
# 三者都拿不到 → 明确报错并退出（绝不静默跳过，否则 cron 里天天失败却无人察觉）。
#
# 容器（docker compose）部署时 DATABASE_URL 写在 compose 里、**不在 .env**，
# 所以宿主机上做备份必须显式给出映射后的路径，例如：
#   DB_PATH=/srv/nvidia-api-monitor/data/prod.db \
#     /srv/nvidia-api-monitor/deploy/backup-db.sh
#
# 为什么不直接 cp：
#   应用正在写库时 cp 出来的快照可能处于「已提交一半」的状态。
#   sqlite3 的 .backup 走在线备份 API，能拿到事务一致快照。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
KEEP_DAYS=14
SELF="$APP_DIR/deploy/backup-db.sh"

command -v sqlite3 >/dev/null 2>&1 || {
  echo "[$(date '+%F %T')] ✗ 未找到 sqlite3，请先安装（apt install sqlite3 / opkg install sqlite3）" >&2
  exit 1
}

# ---------- 定位数据库文件 ----------
# 注意：`set -euo pipefail` 下裸 grep 未命中会直接中断脚本（旧实现即如此，
# .env 里没有 DATABASE_URL 时脚本退出码 1 且**零输出**）。这里统一兜住。
DB_PATH="${DB_PATH:-}"
if [[ -z "$DB_PATH" ]]; then
  DB_URL="${DATABASE_URL:-}"
  if [[ -z "$DB_URL" && -f .env ]]; then
    DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"
  fi
  # 去掉可能包裹的引号
  DB_URL="$(printf '%s' "$DB_URL" | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')"
  if [[ -n "$DB_URL" ]]; then
    DB_PATH="${DB_URL#file:}"
  fi
fi

if [[ -z "$DB_PATH" ]]; then
  {
    echo "[$(date '+%F %T')] ✗ 无法确定数据库路径：DB_PATH / DATABASE_URL 均未设置，.env 中也没有 DATABASE_URL"
    echo "   请任选一种方式后重跑："
    echo "     1) DB_PATH=/绝对路径/prod.db $SELF"
    echo "     2) DATABASE_URL='file:/绝对路径/prod.db' $SELF"
    echo "     3) 在项目根目录 .env 中写入 DATABASE_URL=file:/绝对路径/prod.db"
  } >&2
  exit 1
fi

# 相对路径按项目根目录解析（与 Prisma 的 file:./xxx 语义保持一致）
case "$DB_PATH" in
  /*) : ;;
  *) DB_PATH="$APP_DIR/${DB_PATH#./}" ;;
esac

BAK_DIR="$APP_DIR/backup"
mkdir -p "$BAK_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[$(date '+%F %T')] ✗ 数据库不存在：$DB_PATH" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BAK_DIR/prod-$TS.db"
sqlite3 "$DB_PATH" ".backup '$OUT'"
gzip -f "$OUT"
echo "[$(date '+%F %T')] ✓ 备份完成 $(basename "$OUT").gz ($(du -h "$OUT.gz" | cut -f1))"

# 清理过期备份
find "$BAK_DIR" -name 'prod-*.db.gz' -mtime "+$KEEP_DAYS" -print -delete | while read -r f; do
  echo "[$(date '+%F %T')] 已删除过期备份 $(basename "$f")"
done
