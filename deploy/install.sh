#!/usr/bin/env bash
# ============================================================
# 一键部署 / 更新（在项目根目录执行）
#
#   sh deploy/install.sh                     # 零配置部署（推荐）
#   sh deploy/install.sh --port 3001         # 指定宿主机端口（被占会报错并给出可用端口）
#
# 端口策略：不指定时先试 3000，被占用则**自动**改用下一个空闲端口（3001、3002…），
# 避免一上来就撞上 "Bind for 0.0.0.0:3000 failed: port is already allocated"。
# 自己指定了或 .env 里已写了 PORT 的，被占用只报错不动手改 —— 那是你的明确选择。
#   sh deploy/install.sh --password 'MyPwd'  # 指定管理员密码
#   sh deploy/install.sh --skip-build        # 跳过构建，复用已有镜像
#
# 它会依次完成：
#   ① 检查 docker / compose
#   ② 创建 data、backup 目录
#   ③ 清理群晖 DSM 生成的 @eaDir（否则构建必失败）
#   ④ 构建镜像
#   ⑤ 启动容器（表结构同步、初始数据写入都在容器内自动完成）
#   ⑥ 等服务就绪，打印访问地址
#
# 不做也不需要的：不需要手写 .env，不需要生成密钥，不需要 SEED=1，
# 不需要设置 NEXTAUTH_URL —— 密钥由容器首次启动时自动生成并持久化到
# data/.secrets.env，访问地址按请求自动推导。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

PORT_OVERRIDE=""
EMAIL_OVERRIDE=""
PASSWORD_OVERRIDE=""
URL_OVERRIDE=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT_OVERRIDE="${2:-}"; shift 2 ;;
    --email)    EMAIL_OVERRIDE="${2:-}"; shift 2 ;;
    --password) PASSWORD_OVERRIDE="${2:-}"; shift 2 ;;
    --url)      URL_OVERRIDE="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help)
      sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# ---------- ① 依赖检查 ----------
step "1/6 检查环境"
command -v docker >/dev/null 2>&1 || die "没找到 docker，请先安装 Docker（群晖：套件中心 → Container Manager）"

COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "没找到 docker compose / docker-compose"
fi
ok "docker  $(docker --version | sed 's/Docker version //;s/,.*//')"
ok "compose $($COMPOSE version --short 2>/dev/null || echo '可用')"
ok "项目目录 $APP_DIR"

# ---------- ② 目录 ----------
step "2/6 准备目录"
mkdir -p data backup
ok "data/    —— SQLite 库 + 密钥文件（这是唯一需要备份的目录）"
ok "backup/  —— 库快照输出"

# 已有部署要保护：data 里有库和密钥，误删就不可恢复
if [[ -f data/.secrets.env ]]; then
  ok "检测到已有部署（data/.secrets.env 存在），密钥与数据会继续沿用"
fi

# ---------- ③ 清理 NAS 元数据 ----------
step "3/6 清理 NAS 元数据（@eaDir）"
# DSM 的索引服务会在目录里生成 @eaDir，而 Next.js 把任何以 @ 开头的目录
# 当成并行路由插槽 → 类型检查失败。这一步不能省，所以内置在部署流程里。
if [[ -f deploy/clean-nas-junk.sh ]]; then
  sh deploy/clean-nas-junk.sh || warn "清理脚本返回非 0，继续（多为权限问题，不影响容器构建）"
else
  warn "未找到 deploy/clean-nas-junk.sh，跳过"
fi

# ---------- 端口选型 ----------
# docker 在端口被占时的报错是
#   Bind for 0.0.0.0:3000 failed: port is already allocated
# 光看这句查不出是谁占的，所以部署前先自己检测：
#   · 用户显式指定 / .env 里已有  → 占用就明确报错并给出可用端口（不擅自改）
#   · 都没指定                    → 3000 被占就自动往下找一个空闲端口，并写进 .env
port_in_use() {
  local p="$1"
  # 1) docker 已发布的端口 —— 覆盖「容器占着但宿主没在 LISTEN」的情况，最准确
  if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE ":${p}->"; then
      return 0
    fi
  fi
  # 2) 系统监听表
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$" && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$" && return 0
  fi
  # 3) 兜底：ss / netstat 都没有时直接试着连一下
  if (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then
    exec 3<&- 2>/dev/null
    return 0
  fi
  return 1
}

# 从 start 起找第一个空闲端口，最多试 20 个
find_free_port() {
  local start="$1" i p
  for i in $(seq 0 19); do
    p=$((start + i))
    if ! port_in_use "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# 取值优先级：命令行 --port  >  .env 里已有的 PORT  >  3000  >  自动找空闲
EXISTING_PORT=""
if [[ -f .env ]]; then
  EXISTING_PORT="$(sed -n 's/^PORT=//p' .env | head -1 | sed -e "s/^['\"]//" -e "s/['\"]\$//")"
fi

if [[ -n "$PORT_OVERRIDE" ]]; then
  WANT_PORT="$PORT_OVERRIDE"; PORT_FROM="命令行 --port"
elif [[ -n "$EXISTING_PORT" ]]; then
  WANT_PORT="$EXISTING_PORT"; PORT_FROM=".env"
else
  WANT_PORT="3000"; PORT_FROM="默认"
fi

AUTO_PORT=""
RESOLVED_PORT=""
if port_in_use "$WANT_PORT"; then
  if [[ "$PORT_FROM" = "默认" ]]; then
    RESOLVED_PORT="$(find_free_port 3001 || true)"
    [[ -n "$RESOLVED_PORT" ]] || die "3000 已被占用，且 3001–3020 也都不空闲；请用 --port 手动指定一个"
    warn "3000 端口已被占用，自动改用 $RESOLVED_PORT（想指定别的：--port <端口>）"
    AUTO_PORT="$RESOLVED_PORT"
  else
    ALT_PORT="$(find_free_port "$((WANT_PORT + 1))" || true)"
    die "端口 $WANT_PORT（来自$PORT_FROM）已被占用${ALT_PORT:+，可改用 $ALT_PORT}
  查谁在占用：
    $COMPOSE ps
    ss -ltnp 2>/dev/null | grep :$WANT_PORT     # 没有 ss 就用 netstat -ltnp"
  fi
else
  RESOLVED_PORT="$WANT_PORT"
fi

# ---------- ④ 生成 .env ----------
step "4/6 配置"
if [[ -n "$PORT_OVERRIDE" || -n "$AUTO_PORT" || -n "$EMAIL_OVERRIDE" || -n "$PASSWORD_OVERRIDE" || -n "$URL_OVERRIDE" ]]; then
  ENV_FILE=".env"
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
    ok "已备份原 .env"
  fi

  # 值统一用单引号包起来：compose 读 .env 时单引号内是字面量，
  # 既不会被当成变量引用（密码里的 $ 因此安全），也不会被 # 当成注释。
  # 先拼好再落盘，避免中途失败留下半个文件。
  BODY=""
  add_kv() {
    local key="$1" val="$2"
    [[ -z "$val" ]] && return 0
    if [[ "$val" == *"'"* ]]; then
      die "$key 的值里不能包含单引号（会破坏 .env 语法），请换一个"
    fi
    BODY+="$(printf "%s='%s'" "$key" "$val")"$'\n'
    return 0
  }
  add_kv PORT "${PORT_OVERRIDE:-$AUTO_PORT}"
  add_kv ADMIN_EMAIL "$EMAIL_OVERRIDE"
  add_kv ADMIN_PASSWORD "$PASSWORD_OVERRIDE"
  add_kv NEXTAUTH_URL "$URL_OVERRIDE"

  {
    echo "# 由 deploy/install.sh 生成于 $(date '+%F %T')"
    echo "# 密钥不在这里：由容器首次启动时自动生成，持久化在 data/.secrets.env"
    printf '%s' "$BODY"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "已写入 $ENV_FILE（只包含你显式指定的项）"
else
  if [[ -f .env ]]; then
    ok "沿用已有的 .env"
  else
    ok "无 .env —— 全自动模式：密钥自动生成并持久化，访问地址自动推导"
  fi
fi

# ---------- ⑤ 构建 ----------
step "5/6 构建镜像"
if [[ "$SKIP_BUILD" = "1" ]]; then
  warn "跳过构建（--skip-build），直接复用现有镜像"
else
  # --progress=plain：默认滚动输出会覆盖掉关键错误行
  $COMPOSE build --progress=plain app || die "构建失败。往上翻日志找 Type error / Error；若是 eaDir 相关，见 deploy/DOCKER.md"
  ok "镜像构建完成"
fi

# ---------- ⑥ 启动 ----------
step "6/6 启动容器"
$COMPOSE up -d

echo
printf '  等待服务就绪（首次启动要建表 + 写入初始数据，约 30~90 秒）'
READY=0
for _ in $(seq 1 60); do
  if $COMPOSE exec -T app curl -fsS http://127.0.0.1:3000/api/models/stats >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf '.'
  sleep 3
done
printf '\n'

if [[ "$READY" != "1" ]]; then
  echo
  warn "90 秒内未就绪。查看日志："
  echo "    $COMPOSE logs --tail=80 app"
  exit 1
fi
ok "服务已响应"

# ---------- 访问信息 ----------
# 以 compose 实际发布的端口为准；查不到时退回上面 resolve 出来的值
HOST_PORT="$($COMPOSE port app 3000 2>/dev/null | sed -n 's/.*:\([0-9]\+\)$/\1/p' | head -1)"
HOST_PORT="${HOST_PORT:-$RESOLVED_PORT}"

detect_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]\+\).*/\1/p' | head -1)"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -1)"
  fi
  printf '%s' "$ip"
}
LAN_IP="$(detect_ip)"

# ---------- 登录凭据：直接取出来展示，不用再手动敲命令 ----------
# 邮箱：从容器环境变量取「实际生效」的值（没设过 ADMIN_EMAIL 就是默认的 admin@example.com）
CRED_EMAIL="$(docker exec nvidia-api-monitor sh -c 'printf "%s" "${ADMIN_EMAIL:-admin@example.com}"' 2>/dev/null | head -1)"
CRED_EMAIL="${CRED_EMAIL:-admin@example.com}"

# 密码：--password 指定的直接用；否则读 data/.secrets.env 里首次生成的明文
CRED_PASSWORD=""
CRED_NOTE=""
if [[ -n "$PASSWORD_OVERRIDE" ]]; then
  CRED_PASSWORD="$PASSWORD_OVERRIDE"
  CRED_NOTE="（你用 --password 指定的）"
else
  CRED_PASSWORD="$(docker exec nvidia-api-monitor sh -c 'grep -E "^ADMIN_PASSWORD=" /data/.secrets.env' 2>/dev/null \
    | sed -n 's/^ADMIN_PASSWORD=//p' | sed -e "s/^['\"]//" -e "s/['\"]\$//" | head -1)"
  [[ -n "$CRED_PASSWORD" ]] && CRED_NOTE="（首次启动自动生成；若你之后在后台改过，请用改后的）"
fi

if [[ -n "$CRED_PASSWORD" ]]; then
  CRED_BLOCK=" 登录邮箱    ${CRED_EMAIL}
 初始密码    ${CRED_PASSWORD}
             ${CRED_NOTE}"
else
  CRED_BLOCK=" 登录邮箱    ${CRED_EMAIL}
 初始密码    <未能自动读取> —— 多半是你已在后台改过密码，或容器名不是 nvidia-api-monitor。
             想看首次生成的那个：docker exec nvidia-api-monitor sh -c 'grep -E \"^ADMIN_PASSWORD=\" /data/.secrets.env'"
fi

cat <<EOF

============================================================
 部署完成 🎉
============================================================
 访问地址    http://${LAN_IP:-<本机IP>}:${HOST_PORT}
${CRED_BLOCK}

 建议：登录后到「账号设置」把密码改成自己的。

 常用命令：
   $COMPOSE logs -f --tail=100 app     # 看日志
   $COMPOSE restart                    # 重启
   $COMPOSE down                       # 停止

 备份：只需备份 ./data 目录
   —— 里面有 prod.db 和 .secrets.env（含 ENCRYPTION_KEY，丢了库里
      已存的 API Key 就解不开了）。
============================================================
EOF
