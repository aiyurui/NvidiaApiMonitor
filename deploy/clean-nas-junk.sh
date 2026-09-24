#!/bin/sh
# ============================================================
# 清理群晖 NAS 在项目目录里自动生成的元数据
#
# 为什么需要：DSM 的索引/缩略图服务会在它扫描过的目录里创建 `@eaDir`。
# Next.js App Router 会把**任何以 `@` 开头的目录当成并行路由插槽**，
# 于是 src/app/admin/@eaDir 会让 admin 的 layout 类型检查失败：
#     Type error: Type '{ children: ReactNode; }' does not satisfy the constraint 'LayoutProps'.
#     Property 'eaDir' is missing in type '{ children: ReactNode }' but required in type 'LayoutProps'.
#     Failed to compile.
# 报错里完全不提 NAS，极难定位 —— 所以部署前先跑一次这个脚本。
#
# 用法：
#   sh deploy/clean-nas-junk.sh                            # 清理当前目录
#   sh deploy/clean-nas-junk.sh /srv/nvidia-api-monitor  # 指定目录
#   sh deploy/clean-nas-junk.sh --dry-run                  # 只列出，不删除
# ============================================================
set -e

DRY=0
TARGET="."
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    *) TARGET="$arg" ;;
  esac
done

if [ -z "$TARGET" ] || [ "$TARGET" = "/" ]; then
  echo "[clean] 拒绝在根目录执行，请显式指定项目目录。" >&2
  exit 1
fi
if [ ! -d "$TARGET" ]; then
  echo "[clean] 目录不存在: $TARGET" >&2
  exit 1
fi

# 只针对这些**按名字精确匹配**的项，不会碰其他任何文件
DIRS="@eaDir #recycle @tmp @SynoEAStream"
FILES="Thumbs.db desktop.ini .DS_Store"

echo "[clean] 目标目录: $TARGET"
echo "[clean] 模式    : $([ "$DRY" = "1" ] && echo '预演（只列出，不删除）' || echo '实际删除')"
echo

count=0
for name in $DIRS; do
  hits="$(find "$TARGET" -type d -name "$name" -prune 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "$hits" | while IFS= read -r p; do echo "  [目录] $p"; done
    count=$((count + $(printf '%s\n' "$hits" | wc -l)))
  fi
done
for name in $FILES; do
  hits="$(find "$TARGET" -type f -name "$name" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "$hits" | while IFS= read -r p; do echo "  [文件] $p"; done
    count=$((count + $(printf '%s\n' "$hits" | wc -l)))
  fi
done

if [ "$count" -eq 0 ]; then
  echo "  未发现需要清理的项 —— 目录是干净的。"
  exit 0
fi

if [ "$DRY" = "1" ]; then
  echo
  echo "[clean] 共 $count 项待清理。去掉 --dry-run 即可执行删除。"
  exit 0
fi

for name in $DIRS; do
  find "$TARGET" -type d -name "$name" -prune -exec rm -rf {} + 2>/dev/null || true
done
for name in $FILES; do
  find "$TARGET" -type f -name "$name" -delete 2>/dev/null || true
done

left="$(find "$TARGET" -type d \( -name '@eaDir' -o -name '#recycle' \) 2>/dev/null | wc -l)"
echo
echo "[clean] 已清理 $count 项，残留 $left 项。"
if [ "$left" -eq 0 ]; then
  echo "[clean] 完成。可以继续执行 docker compose build。"
else
  echo "[clean] 仍有残留，多为权限问题，请检查目录属主。" >&2
  exit 1
fi
