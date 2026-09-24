#!/usr/bin/env bash
# ============================================================
# 一次性服务器初始化（Ubuntu 22.04 / Debian 12 验证过）
# 用法：sudo bash deploy/setup-server.sh
#
# RHEL / CentOS / Rocky 差异：
#   - dnf module install nodejs:20      （替代 NodeSource 那两行）
#   - dnf install nginx sqlite
#   - 安全组用 firewalld：firewall-cmd --add-service=http --permanent && firewall-cmd --reload
# ============================================================
set -euo pipefail

APP_DIR="/srv/nvidia-api-monitor"
DATA_DIR="/srv/nvidia-api-monitor/data"
LOG_DIR="/var/log/nvidia-api-monitor"
BACKUP_DIR="/srv/nvidia-api-monitor/backup"

echo "==> 1/5 安装 Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> 2/5 安装 PM2 / Nginx / sqlite3"
apt-get install -y nginx sqlite3 rsync
npm install -g pm2

echo "==> 3/5 创建目录"
mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
# 用当前 sudo 调用者作为属主；没有 SUDO_USER 时退回 root
OWNER="${SUDO_USER:-root}"
chown -R "$OWNER":"$OWNER" "$APP_DIR" "$LOG_DIR"

echo "==> 4/5 启动 Nginx"
systemctl enable --now nginx

echo "==> 5/5 完成"
cat <<EOF

接下来：
  1) 把项目代码放到 $APP_DIR（git clone 或 rsync，排除 node_modules/.next/*.db）
  2) cd $APP_DIR && cp deploy/env.production.example .env
     - 填好 NEXTAUTH_SECRET / ENCRYPTION_KEY / ADMIN_PASSWORD_HASH / NEXTAUTH_URL
     - 若迁移已有数据库，ENCRYPTION_KEY 必须沿用旧值！
  3) bash deploy/release.sh                                   # 首次发布
  4) sudo cp deploy/nginx.conf /etc/nginx/conf.d/nvidia-api-monitor.conf
     sudo vim /etc/nginx/conf.d/nvidia-api-monitor.conf                # 改 server_name
     sudo nginx -t && sudo systemctl reload nginx
  5) su - $OWNER -c "pm2 startup && pm2 save"                  # 开机自启（按提示复制那行命令执行）

当前属主：$OWNER
EOF
