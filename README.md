# NVIDIA 模型可用性监控

定时同步 NVIDIA 公开模型列表并对其做可用性健检、打分，在公开看板上展示模型状态与统计，后台可管理 Key / 用例 / 调度设置。

> **内部实现**（架构、任务调度、数据模型、判定口径、API 清单、开发约定）见 [`PROJECT.md`](PROJECT.md)。

核心能力（对应 7 条需求）：

1. 公开看板（`/`）：统计卡片（总数 / 可用 / 不可用 / 未测 / 可用率 / 平均首包 TTFT / 平均吞吐）+ 模型表格（状态与能力筛选、按评分 / 可用率 / 首包 TTFT / TPS / 最后检测排序、30 秒轮询刷新）。
2. 模型同步：拉取 NVIDIA 公开模型列表入库（新增 / 更新 / 标记下线），支持后台手动触发。每次同步（含全量探测）落一条 `SyncRun`，后台展示「最近一次同步」：成功显示新增 / 更新 / 下线 + 探测可用 / 不可用 + 耗时，失败显示错误原因（无可用 Key / 拉列表失败 / 超时）；每个模型单独展示最近一次探测结果（成功 `HTTP 码 · 耗时`，失败 `HTTP 码` 或 `超时`）。
3. 可用性健检：按测试用例对模型做连通性探测，记录首包 TTFT / 总耗时 / tokens-per-sec / 成功失败，支持单模型手动触发。
   - **可用性判定**：只要在 **30 秒**内返回了**任意**数据即判定可用（`HealthCheck.success=true`）；30 秒内一个字节都没回则为超时不可用。已开始返回后即使整体耗时超过 30 秒也算可用。
   - **可用率**：近 24 小时 `success` 检测数 / 总检测数（列表、详情、统计卡片同一口径）。
   - **TPS**：优先使用响应里的 `usage.completion_tokens`；部分模型不回传 usage，此时按输出文本粗估 token 数，避免出现"有输出却显示 0 TPS"。
4. 人工评分：给模型打 0–100 的整数分 + 备注，支持「待评分」列表；九维权重（`scoringWeights`）目前只在后台存储与校验，**尚未参与任何算分**（见 [`PROJECT.md`](PROJECT.md) §12）。
5. API Key 管理：Key 加密存储（ENCRYPTION_KEY），多 Key 按优先级分池 + 进程内游标轮询，可启停。**本项目不冻结 / 冷却任何 Key**（`cooledUntil` 仅为兼容字段）。
6. 后台管理：账号登录（失败限流锁定）+ Key 管理 + 模型管理 + 测试用例管理 + 全局设置（保存后调度热重载）。
7. 定时调度与公开只读 API：单进程内置定时器驱动同步与健检；`/api/models`、`/api/models/stats`、`/api/models/<modelId>/history` 对外只读。
8. **全局入口密码（可选）**：后台「全局设置」页可设置/清除一个共享入口密码。设置后：看板、公开 API、登录页（含从 /admin 跳转的登录）都需要先在验证页输入该密码（30 天内免重复输入；修改密码会使已验证访客重新验证）；**已登录的管理员会话自动免验证**。验证接口按 IP 限流（10 分钟 5 次失败锁定）。

## 环境变量

| 变量                    | 说明                                                    | 生成方法                                                                       |
| --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`        | SQLite 路径，固定 `file:./dev.db`（相对 `prisma/` 解析为 `prisma/dev.db`，见下文 canonical 说明） | 无需生成                                                                       |
| `NEXTAUTH_SECRET`     | NextAuth 会话签名密钥，生产要求 ≥32 字符                           | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NEXTAUTH_URL`        | 站点基地址，如 `http://localhost:3000`                       | 按部署地址填写                                                                    |
| `ADMIN_EMAIL`         | 管理员邮箱，seed 用它创建账号                                     | 如 `admin@example.com`                                                      |
| `ADMIN_PASSWORD_HASH` | 管理员密码的 bcrypt hash                                    | `node -e "console.log(require('bcryptjs').hashSync('你的密码', 10))"`          |
| `ENCRYPTION_KEY`      | API Key 加密密钥，64 位 hex                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

> **Docker 部署不需要手工准备这些。** 上表里的密钥与管理员账号由容器首次启动时自动生成，  
> 持久化在 `data/.secrets.env` 复用；想覆盖就在项目目录建 `.env`，只写要改的那几行。  
> 详见「方案 B」。
>
> **`NEXTAUTH_URL` 是可选项**：默认不配。服务端靠 `AUTH_TRUST_HOST=1` 按请求的  
> `Host` / `X-Forwarded-Host` 推导访问地址，客户端统一走相对路径 —— 因此换 IP、换域名、  
> 加 HTTPS 反代都不用重建镜像，也不会再出现"填错 NEXTAUTH_URL 导致登录失败"。  
> 只有想强制固定成某个域名时才需要设置它。

`.env.example` 是**本机开发**用的模板（`npm run dev`），生产模板见 `deploy/env.production.example`。

## 初始化

```bash
npm install
npx prisma generate

# 首次运行必须先准备配置（仓库里不含 .env，只有模板）：
#   缺 DATABASE_URL → 任何查询都报 "Environment variable not found: DATABASE_URL"（dev 一起来就挂）
#   缺 ADMIN_PASSWORD_HASH → npm run db:seed 抛 "ADMIN_PASSWORD_HASH is required for seeding"
cp .env.example .env
# 然后编辑 .env，至少填这三项（生成命令依赖上面的 npm install）：
#   ADMIN_PASSWORD_HASH  node -e "console.log(require('bcryptjs').hashSync('你的密码',10))"
#   ENCRYPTION_KEY       openssl rand -hex 32          # 必须是 64 位 hex
#   NEXTAUTH_SECRET      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run db:push
npm run db:seed
npm run dev
```

> `.env` 已被 `.gitignore` 忽略，不会进版本库。

`db:seed` 会创建管理员账号、全局设置单例（`syncIntervalHours=6` / `healthIntervalMin=30`）、默认测试用例（`default-brief`）以及 **76 条内置人工评分**。seed 幂等（user/settings/testCase/manualScore 均为 upsert），可重复执行。

## 数据库路径说明

- canonical 库文件：`nvidia-api-monitor/prisma/dev.db`（项目根下的 `prisma/dev.db`）。
- 相对路径的解析基准是 **schema 文件所在目录（`prisma/`）**，不是进程工作目录。  
  即 `DATABASE_URL="file:./dev.db"` → `prisma/dev.db`。  
  应用层（`src/lib/prisma.ts`）、`prisma/seed.ts`、`prisma` CLI 三者**口径完全一致** ——  
  这是刻意设计的，历史上曾因各自按不同基准解析而读写到两个不同的库文件。
- ⚠️ 因此**不要**把值写成 `file:./prisma/dev.db`：它会被解析成 `prisma/prisma/dev.db`（新建文件），  
  而不是应用真正在用的 `prisma/dev.db`。
- 生产建议直接用**绝对路径**（如 `file:/srv/nvidia-api-monitor/data/prod.db`），彻底绕开解析基准问题。

## 生产部署（Linux）

部署物料都在 [`deploy/`](deploy/) 目录，开箱可用：

| 文件                                  | 作用                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `Dockerfile` / `docker-compose.yml` | 容器化方案（**推荐**，见下文方案 B）                                                                |
| `deploy/install.sh`                 | **Docker 一键部署**：建目录 → 清 @eaDir → 构建 → 启动 → 健康检查                                      |
| `deploy/docker-entrypoint.sh`       | 容器启动入口：自动生成并持久化密钥、同步表结构、首次启动自动 seed                                                  |
| `deploy/setup-server.sh`            | PM2 方案：一次性服务器初始化（Node 20 + PM2 + Nginx + sqlite3 + 目录）                               |
| `deploy/release.sh`                 | PM2 方案：发布/更新（备份 → `npm ci` → `prisma generate` → `db push` → `build` → `pm2 reload`） |
| `deploy/ecosystem.config.cjs`       | PM2 配置（强制单实例、绑定 127.0.0.1、日志轮转）                                                      |
| `deploy/nginx.conf`                 | Nginx 反向代理（含长请求超时与静态资源缓存）                                                            |
| `deploy/backup-db.sh`               | SQLite 在线备份（`.backup` 事务一致快照），保留 14 天                                                |
| `deploy/env.production.example`     | 环境变量模板（Docker 方式不需要；PM2 方式需要）                                                        |

### ⚠️ 三条硬性约束

1. **必须在 Linux 上构建**。Prisma 的查询引擎是平台相关二进制，Windows 上生成的 `node_modules` / `npx prisma generate` 产物拷到 Linux 会直接报 `Query engine binary ... not found`。`node_modules` 与 `.next` 都**不要跨平台拷贝**，只同步源码。
2. **`ENCRYPTION_KEY` 必须与旧机器完全一致**（若迁移已有数据库）。它是 AES-256-GCM 密钥，换了就解不开已入库的 NVIDIA API Key，表现为同步时大面积 401 / decrypt 失败。
3. **只能起 1 个实例**。调度是进程内定时器（`src/lib/scheduler.ts`，job 锁仅在进程内有效），多副本会导致重复探测与 SQLite 写冲突。

### 方案 A：PM2 + Nginx（推荐）

```bash
# 0) 服务器初始化（Ubuntu/Debian；RHEL 系差异见脚本头部注释）
sudo bash deploy/setup-server.sh

# 1) 上传源码到 /srv/nvidia-api-monitor（排除 node_modules、.next、*.db）
rsync -av --exclude node_modules --exclude .next --exclude '*.db*' \
      ./ user@host:/srv/nvidia-api-monitor/

# 2) 配置环境变量（ENCRYPTION_KEY 沿用旧值！）
cd /srv/nvidia-api-monitor && cp deploy/env.production.example .env && chmod 600 .env && vim .env

# 3) 首次发布（建库 + seed + 构建 + 启动）
bash deploy/release.sh --fresh

# 4) Nginx
sudo cp deploy/nginx.conf /etc/nginx/conf.d/nvidia-api-monitor.conf
sudo vim /etc/nginx/conf.d/nvidia-api-monitor.conf        # 改 server_name
sudo nginx -t && sudo systemctl reload nginx

# 5) 开机自启
pm2 startup && pm2 save                          # 按提示复制那行命令执行

# 6) 每日备份（脚本需可执行位）
chmod +x deploy/*.sh
crontab -e
# 0 3 * * * /srv/nvidia-api-monitor/deploy/backup-db.sh >> /var/log/nvidia-api-monitor/backup.log 2>&1
```

后续更新只需 `git pull && bash deploy/release.sh`。

### 方案 B：Docker Compose（群晖 NAS 亦适用，推荐）

容器构建天然是 Linux 环境，可绕开约束 1（跨平台二进制问题），而且**不需要手写任何配置文件**。

```bash
cd /srv/nvidia-api-monitor     # 部署目录（Linux 通用位置）；群晖 NAS 改用 /volumeN/docker/nvidia-api-monitor，详见 deploy/DOCKER.md
sh deploy/install.sh                      # 就这一条
```

`install.sh` 会依次完成：检查 docker/compose → 建 `data`、`backup` 目录 → 清理 DSM 的 `@eaDir`  
→ 构建镜像 → 启动容器 → 等服务就绪 → 打印访问地址。**它不会创建 `.env`**，因为不需要：

| 原来要手工做的事                                           | 现在                                  |
| -------------------------------------------------- | ----------------------------------- |
| 生成 `NEXTAUTH_SECRET` / `ENCRYPTION_KEY` 并写进 `.env` | 容器首次启动自动生成，持久化到 `data/.secrets.env` |
| 生成 `ADMIN_PASSWORD_HASH`（bcrypt）                   | 自动生成随机密码并打印一次（也可用 `--password` 指定）  |
| 配 `NEXTAUTH_URL`                                   | 不用配，访问地址按请求自动推导                     |
| `mkdir -p data backup`                             | 脚本自动                                |
| 记得跑 `clean-nas-junk.sh`                            | 脚本自动                                |
| 首次启动加 `SEED=1`                                     | 自动判断（`User` 表为空就 seed）              |

**端口不用操心**：3000 被占用时，脚本会在启动前检测到并**自动**改用下一个空闲端口（3001、3002…），
最后打印的访问地址会跟着变。

想定制就加参数，不用手改文件：

```bash
sh deploy/install.sh --port 3001                  # 指定宿主机端口（被占会报错并给出可用端口）
sh deploy/install.sh --email me@example.com --password 'MyPwd'
sh deploy/install.sh --skip-build                 # 只重启，不重新构建
```

参数会写进一个很小的 `.env`（只含你指定的项）。等价的底层命令就是 `docker compose up -d`  
—— **没有 `.env` 也能直接跑**。

后续更新：

```bash
tar -xzf 新包.tar.gz --strip-components=1
sh deploy/install.sh            # 或 docker compose up -d --build
```

数据库与密钥都在 `./data`（容器内 `/data`）。反代仍按 `deploy/nginx.conf` 指向 `127.0.0.1:3000`，  
注意群晖上若走 DSM 自带的反向代理，等于不经过本机的 Nginx。

- **走 HTTPS 反代（域名访问）**：nginx 必须转发 `X-Forwarded-Proto` 与 `Host` / `X-Forwarded-Host`（见 `deploy/nginx.conf`）。本项目已强制使用**非前缀 Cookie 名**并关闭 Secure 约束，使 Edge 中间件与 Node 路由在 HTTP / HTTPS 下判定一致，避免「域名访问后台无限刷新」的安全 Cookie 死循环。详见 [`deploy/DOCKER.md`](deploy/DOCKER.md) 第 5 节。

Docker 环境下的额外注意：

- **`TZ`**（compose 默认 `Asia/Shanghai`）—— 容器默认 UTC，不设会让「清理今日数据」「今日轮数」等按自然日统计的口径在北京时间 08:00 前算成昨天（可用性判定已改为滚动时效窗口，不再依赖自然日）。
- **`DATABASE_URL` 由 compose 覆盖为 `file:/data/prod.db`** —— 即使 `.env` 里还留着开发用的 `file:./dev.db` 也不会误写进容器内部。
- **`data` 必须是本地卷** —— SQLite 放 NFS/SMB 网络共享上会因文件锁异常损坏。
- **`data` 要和数据库一起备份** —— 除了 `prod.db`，里面还有 `.secrets.env`：丢了 `ENCRYPTION_KEY`，库里已存的 API Key 就解不开了。
- **群晖的 `@eaDir`** —— 已由 `install.sh` 与 Dockerfile 双重清理，一般不会再有影响；若你改用 PM2 方案在 NAS 上直接构建，仍需注意，详见 [`deploy/DOCKER.md`](deploy/DOCKER.md) 的「@eaDir 陷阱」。

### 数据库路径

生产建议用**绝对路径**，彻底避开相对路径解析基准不一致的问题（见上文 canonical 库说明）：

```bash
DATABASE_URL="file:/srv/nvidia-api-monitor/data/prod.db"
```

`deploy/release.sh` 会在发布前自动用 `sqlite3 .backup` 快照当前库，回滚时把 `backup/prod-<时间戳>.db` 拷回目标路径并重启即可。

## 默认账号

- seed 用 `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`（或 `ADMIN_PASSWORD`）创建管理员（`role=ADMIN`）。  
  **只有当 `User` 表为空时才写**，不会覆盖你在后台改过的密码；要强制重置加 `SEED_FORCE=1`。
- **在线改密**：后台「账号设置」页可直接修改登录邮箱与密码（需验证当前密码；改邮箱后自动退出并要求用新邮箱登录）。
- 离线改密（忘记密码时）：
  ```bash
  HASH="$(node -e "console.log(require('bcryptjs').hashSync('新密码', 10))")"
  ADMIN_PASSWORD_HASH="$HASH" SEED_FORCE=1 npm run db:seed   # 本地
  # Docker：SEED_FORCE=1 docker compose up -d --force-recreate
  ```
  或者直接从 `data/.secrets.env` 里找回首次启动时自动生成的初始密码 ——
  但注意那里**只存密码，不存邮箱**；登录邮箱若你没设过 `ADMIN_EMAIL`，就是默认的 `admin@example.com`。

## 定时任务

- 模型同步：默认每 6 小时（`syncIntervalHours`），启动时若发现过期会补跑一次。
- 可用性健检：默认每 30 分钟（`healthIntervalMin`），启动时若上次健检过期会补跑一次。


- 两者均按**固定间隔**触发（自进程启动时刻起算），设置多少就是多少：不再对齐整点，

也不会出现「设 45 分钟实际 45/15 交替」或「设 90 分钟实际退化成 60 分钟」。

- 两项间隔均可在后台「全局设置」页调整，保存后即时生效（页面提示"已保存，调度已热重载"，服务端调用 `restartScheduler()` 重建定时器）。
- ⚠️ 调度是**进程内定时器**（`instrumentation.ts` → `startScheduler()`）：只有 dev/prod 服务进程活着才会跑，关掉终端/进程就不再检测。判断调度是否活着，看首页右上角「最近健检」时间或后台「最近一次全量健检」卡片——每次健检结束都会落一条 `SyncRun(kind=health)`。
- 进程内 job 锁带 30 分钟超时兜底；检测按「批内并发（批大小 = 可用 Key 数）、批间等待 `JOB_INTERVAL_MS`（默认 2s）」执行，单条检测异常不会中断整轮。
- 健检**连续 `CONSECUTIVE_TIMEOUT_THRESHOLD`（默认 3）轮超时**会把模型标记为不可用（`lastProbeOk=false`）。「一轮」= 该轮内这个模型的用例**全部**超时才算一次，任一用例成功即清零（详见 [`PROJECT.md`](PROJECT.md) §7.5）；恢复只能靠下一次全量可用性检查（同步探测成功时清零计数并恢复）。
