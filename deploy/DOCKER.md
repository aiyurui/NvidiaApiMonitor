# Docker 部署（群晖 NAS / 通用 Linux）

> **一句话：`sh deploy/install.sh` 就够了。** 不需要写 `.env`，不需要生成密钥，  
> 不需要设 `NEXTAUTH_URL`，不需要记 `SEED=1`，不需要手动清 `@eaDir`。

目标路径：`/srv/nvidia-api-monitor`

> **关于部署目录**：本文统一写作 **`/srv/nvidia-api-monitor`**（Linux 通用位置，等同 `/opt/<项目>`）。
>
> ⚠️ **群晖 DSM 例外**：它的 `/` 根目录通常不可写，建不了 `/srv`。请改用  
> **`/volumeN/docker/nvidia-api-monitor`**，其中 `N` = 你的存储空间编号（可能是  
> `volume1` / `volume2` / `volume3`，用 `ls /` 或 File Station 确认）。  
> 下文出现 `/srv/nvidia-api-monitor` 的地方，群晖上都按这一条替换。

---

## 0. 先做两项前提检查

```bash
uname -m                 # 架构：x86_64 / aarch64 都可以；armv7l（32 位 ARM）不建议
docker --version         # 群晖 DSM 7.2 自带 Container Manager，就有 docker
docker compose version   # 若报错，用 docker-compose（脚本两种都支持）
free -h                  # 构建 Next.js 建议可用内存 >= 2GB
```

关于架构：镜像用的是 `node:20-bookworm-slim`，官方支持 `x86_64` 与 `arm64`。  
低端 Realtek 机型（`armv7l`）构建会极慢甚至失败，请走本文末尾的「方案 B：本地构建后导入镜像」。

---

## 1. 放代码，然后跑一条命令

```bash
mkdir -p /srv
cd /srv
tar -xzf /path/to/nvidia-api-monitor-src-*.tar.gz     # 顶层目录已带 nvidia-api-monitor/ 前缀
cd nvidia-api-monitor

sh deploy/install.sh
```

如果你是通过 Container Manager 的「项目」功能建，**项目路径就选 `/srv/nvidia-api-monitor`**。

> 不要直接把 Windows 上的 `node_modules` 拷过来 —— Prisma 的查询引擎是平台相关二进制，  
> 跨平台拷贝必然报 `Query engine binary ... not found`。源码包已经剔除了它，交给容器内 `npm ci` 重装。

### 想定制就加参数（不用手改文件）

```bash
sh deploy/install.sh --port 3001                              # 换宿主机端口
sh deploy/install.sh --email me@example.com                    # 换管理员邮箱
sh deploy/install.sh --password 'MyPwd123'                     # 指定管理员密码
sh deploy/install.sh --url https://mon.example.com             # 强制固定访问地址（通常不需要）
sh deploy/install.sh --skip-build                              # 只重启，复用已有镜像
```

参数会写进一个很小的 `.env`（只含你指定的项，覆盖前会自动备份旧的）。

### 底层其实就是

```bash
docker compose up -d            # 有 .env 也行，没有也行
```

---

## 2. 它在背后做了什么

`install.sh` 只是一层编排，真正让「零配置」成立的是容器自己的启动入口  
（`deploy/docker-entrypoint.sh`）：

| 原来的手工步骤                          | 现在的行为                                        |
| -------------------------------- | -------------------------------------------- |
| 生成 `NEXTAUTH_SECRET` 写进 `.env`   | 首次启动自动生成，持久化到 `data/.secrets.env`，之后重启复用     |
| 生成 `ENCRYPTION_KEY` 写进 `.env`    | 同上                                           |
| 生成 `ADMIN_PASSWORD_HASH`（bcrypt） | 自动生成随机密码并**打印一次**，同时存进 `data/.secrets.env`   |
| 配 `NEXTAUTH_URL`                 | 不需要。`AUTH_TRUST_HOST=1` 让服务端按请求的 `Host` 推导地址 |
| `mkdir -p data backup`           | `install.sh` 自动                              |
| 部署前清 `@eaDir`                    | `install.sh` 自动调 `clean-nas-junk.sh`         |
| 首次启动 `SEED=1`                    | 自动判断：`User` 表为空就 seed（管理员/全局设置/默认用例/人工评分）    |

启动日志长这样，看到 `启动 Next.js…` 就说明前面的步骤都过了：

```
[entrypoint] 数据库      : /data/prod.db
[entrypoint] 时区        : Asia/Shanghai
[entrypoint] NEXTAUTH_SECRET : 已自动生成并保存到 /data/.secrets.env
[entrypoint] ENCRYPTION_KEY  : 已自动生成并保存到 /data/.secrets.env
[entrypoint] NEXTAUTH_URL    : 未设置 —— 按访问地址自动推导（无需配置）
[entrypoint] 同步表结构（prisma db push）…
[entrypoint] 初始数据    : 写入初始数据（管理员 / 全局设置 / 默认测试用例 / 人工评分）…
[entrypoint] 启动 Next.js…
```

首次启动还会打印一次初始账号：

```
============================================================
 首次启动完成 —— 请记下这个登录信息
 （也可在 /data/.secrets.env 里找回）
   登录邮箱：admin@example.com
   初始密码：xxxxxxxxxxxx
 建议登录后在「账号设置」里改成自己的密码。
============================================================
```

> **密钥为什么必须落盘**：`ENCRYPTION_KEY` 换了，库里已存的 NVIDIA API Key 全部解不开；  
> `NEXTAUTH_SECRET` 换了，所有登录会话立刻失效。所以入口脚本绝不「每次启动换一把」，  
> 而是写进 `data/.secrets.env`（权限 600）；写不进去会直接启动失败并报错。

### 找初始密码 / 重置密码

部署成功时 `install.sh` 会**直接打印**登录邮箱和初始密码，正常不用自己查。下面这条只在之后忘了时用：

```bash
# 找回首次启动时生成的账号
# 注意：.secrets.env 里只存密码，邮箱不写进去 —— 所以邮箱要从容器环境变量取（没设过就是 admin@example.com）
docker exec nvidia-api-monitor sh -c 'echo "登录邮箱：${ADMIN_EMAIL:-admin@example.com}"; grep -E "^ADMIN_PASSWORD=" /data/.secrets.env'

# 首次启动的日志里也打印过一次完整的「登录邮箱 + 初始密码」
docker compose logs app 2>/dev/null | grep -A2 '首次启动完成'

# 强制重置成你的密码
ADMIN_PASSWORD='新密码' SEED_FORCE=1 docker compose up -d --force-recreate
```

---

## 3. 看是否真的起来了

```bash
docker compose ps                    # STATUS 应显示 healthy（冷启动约 60~90 秒）
docker compose logs -f app           # 跟踪日志
curl -s localhost:3000/api/health     # {"ok":true}（该端点不受入口密码门禁；
                                     #  启用入口密码后 /api/models/stats 未解锁会返回 401）
```

日志里看到 `[scheduler] activated` 才算真正就绪 —— 调度是进程内定时器，  
只有这一行出现，定时探测才会跑。

```
▲ Next.js 14.2.35
- Local:        http://localhost:3000
[scheduler] activated — sync every 6h (21600000ms / exact), health every 30min (1800000ms / exact)
```

---

## 4. 放行端口

DSM：`控制面板 → 安全性 → 防火墙`，允许 TCP `3000`（或你改成的那个端口）。  
如果是外网访问，建议只在局域网开放，或通过反代 + HTTPS 暴露（见下）。

---

## 5. 反向代理（可选，但要 HTTPS 就得配）

群晖自带 `控制面板 → 登录门户 → 高级 → 反向代理服务器`：

| 项            | 值                               |
| ------------ | ------------------------------- |
| 来源 协议/主机/端口  | HTTPS / `mon.example.com` / 443 |
| 目的地 协议/主机/端口 | HTTP / `localhost` / 3000       |

**配完不用改任何配置、也不用重建容器** —— 之前必须把 `NEXTAUTH_URL` 改成新域名并重建，  
现在访问地址是按请求自动推导的。（反代记得转发 `Host` 和 `X-Forwarded-Proto`；  
群晖自带的反代默认会转发。）

如果反代的读取超时是可调的，调到 180 秒以上 —— 后台手动触发全量健检最坏要跑约 95 秒，太短会返回 504。

> ⚠️ **域名（HTTPS 反代）下后台无限跳转/刷新**  
> 现象：用 IP 直连正常，用域名（经 HTTPS 反代）点「后台管理」就一直在登录页与后台之间死循环。  
> 根因：NextAuth 会按请求协议自动给会话 Cookie 加 `__Secure-` 前缀。Node 路由处理器经反代看到  
> `X-Forwarded-Proto: https` → 写带前缀的 Secure Cookie；而 Edge 中间件看到的是 nginx→应用 的  
> 内部 HTTP 连接 → 去找不带前缀的名字 → 读不到 → 误判未登录 → 跳登录页，登录页又能读到 → 跳回 → 死循环。  
> 修复：`src/lib/auth.ts` 已把 `sessionToken / csrfToken / callbackUrl` 三个 Cookie 强制成**固定、  
> 非 Secure 前缀**的名称（`src/lib/auth-cookie.ts`），中间件 `getToken` 也显式指定同名 Cookie。  
> 这样 HTTP（IP 直连）与 HTTPS（域名反代）都能用，**无需改 NEXTAUTH_URL、无需重建**。  
> 升级到该修复后，旧的 `__Secure-` 会话 Cookie 会失效，重新登录一次即可。

---

## 6. 日常运维

```bash
# 更新代码后重建
cd /srv/nvidia-api-monitor
tar -xzf 新包.tar.gz --strip-components=1
sh deploy/install.sh                      # 等价于 docker compose up -d --build

# 日志
docker compose logs -f --tail=200 app

# 重启 / 停止
docker compose restart
docker compose down
```

### 备份

只需要备份 **`data/` 目录**。**不要直接 `cp` 正在使用的库**（可能拷到半提交状态），  
用容器内的 sqlite3 做在线快照：

```bash
docker exec nvidia-api-monitor sh -c \
  'sqlite3 /data/prod.db ".backup /data/backup-$(date +%F).db"'
```

想自动化就加到 DSM 的「任务计划」里每天跑一次。  
也可以直接用 Hyper Backup 备份整个 `/srv/nvidia-api-monitor/data`。

仓库里带了现成脚本 `deploy/backup-db.sh`（在线快照 + gzip + 保留 14 天）。  
**容器部署下 `DATABASE_URL` 写在 compose 里、不在 `.env`**，所以宿主机上跑它必须显式给出  
映射后的数据库路径，脚本不会去猜：

```bash
# 方式一：显式指定数据库文件（推荐）
DB_PATH=/srv/nvidia-api-monitor/data/prod.db \
  /srv/nvidia-api-monitor/deploy/backup-db.sh

# 方式二：用 DATABASE_URL
DATABASE_URL='file:/srv/nvidia-api-monitor/data/prod.db' \
  /srv/nvidia-api-monitor/deploy/backup-db.sh
```

crontab 示例（每天 03:00）：

```cron
0 3 * * * DB_PATH=/srv/nvidia-api-monitor/data/prod.db /srv/nvidia-api-monitor/deploy/backup-db.sh >> /var/log/nvidia-api-monitor/backup.log 2>&1
```

> 脚本按 `DB_PATH` → `DATABASE_URL` → `.env` 的顺序解析路径；三者都拿不到会**明确报错并退出 1**  
> （而不是静默成功），这样 cron 里的失败不会没人发现。同时会先校验 `sqlite3` 是否可用。

> ⚠️ `data/` 里除 `prod.db` 外还有 **`.secrets.env`** —— 它含 `ENCRYPTION_KEY`。  
> 只备份数据库不备份它，换机器后库里已存的 API Key 会全部解不开。

### 从旧机器迁移数据

在本机（Windows）做一致快照，然后把**两个文件**一起传过去：

```bash
sqlite3 prisma/dev.db ".backup 'migrate.db'"
```

```bash
# NAS 上
scp migrate.db user@<NAS-IP>:/srv/nvidia-api-monitor/data/prod.db
scp .secrets.env user@<NAS-IP>:/srv/nvidia-api-monitor/data/.secrets.env   # 含 ENCRYPTION_KEY
chmod 644 /srv/nvidia-api-monitor/data/prod.db
docker compose restart
```

**前提**：`.secrets.env` 里的 `ENCRYPTION_KEY` 与旧机器一致，否则已存的 API Key 全部失效。  
（若旧机器用的是 `.env` 里的 `ENCRYPTION_KEY`，把那一行照抄进新机器的 `data/.secrets.env` 即可。）

---

## 7. 排错对照表

| 现象                                                                           | 原因 / 处理                                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Next.js build worker exited with code: 1 and signal: null`                  | 构建期有模块级抛错/类型错误，Next 把真实原因吞了。往上翻几十行找 `Type error:` / `Error:`；若是 `eaDir` 相关 → 见下节「@eaDir 陷阱」                                                           |
| `Property 'eaDir' is missing in type ... but required in type 'LayoutProps'` | **群晖特有**：DSM 生成的 `@eaDir` 被 Next 当成并行路由插槽。`install.sh` 已内置清理；若手工构建请先跑 `sh deploy/clean-nas-junk.sh`                                                   |
| `目录 /data 不可写`                                                               | 挂载卷权限问题，`data` 目录需可写（`chown` 成运行 docker 的用户）                                                                                                          |
| `无法写入 /data/.secrets.env`                                                    | 同上。入口脚本刻意在这里失败 —— 因为它绝不允许「密钥换一把」，否则数据会不可逆地解不开                                                                                                         |
| `NEXTAUTH_SECRET 至少 32 字符`                                                   | 你显式在 `.env` 里给了但长度不够。删掉那一行让它自动生成，或补齐                                                                                                                  |
| `ENCRYPTION_KEY 必须是 64 位 hex`                                                | 同上，用了 base64 或长度不对。删掉那一行让它自动生成，或 `openssl rand -hex 32`                                                                                               |
| `Query engine binary ... not found`                                          | 跨平台拷了 `node_modules`。删掉后重新 `docker compose build`                                                                                                     |
| 容器反复重启，日志无输出                                                                 | 内存不足被 OOM kill。`free -h` 确认，或走方案 B                                                                                                                    |
| 表结构没更新                                                                       | 容器启动会跑 `db push`；若需删列会**报错退出**（不自动丢数据）。人工确认后执行：`docker compose run --rm app /app/node_modules/.bin/prisma db push --skip-generate --accept-data-loss` |
| 登录后用一会儿就掉线                                                                   | 检查 `data/.secrets.env` 是否被删（`NEXTAUTH_SECRET` 换了会让所有会话失效）                                                                                             |
| 「今日」数据不对（早上 8 点前被算成昨天）                                                       | `TZ` 没生效，确认 compose 里 `TZ: "Asia/Shanghai"`                                                                                                           |
| 首页数字一直不变                                                                     | 老版本构建的镜像。确认代码里有 `export const dynamic = "force-dynamic"`（`src/app/api/models/stats/route.ts`）后重建                                                      |
| `Bind for 0.0.0.0:3000 failed: port is already allocated`                  | 宿主机 3000 已被别的容器/服务占用。`install.sh` 在启动**前**就检测：未指定端口时自动改用 3001、3002…；若你用 `--port` 指定过、或 `.env` 里写了 `PORT`，则只报错并给出可用端口（那是你的明确选择，不擅自改）。查占用方：`docker compose ps`、`ss -ltnp \| grep :3000` |

### @eaDir 陷阱（群晖特有，必读）

**症状** —— 类型检查阶段失败，报错里只出现一个莫名其妙的 `eaDir`：

```
✓ Compiled successfully
Linting and checking validity of types ...
Failed to compile.

src/app/admin/layout.tsx
Type error: Type '{ children: ReactNode; }' does not satisfy the constraint 'LayoutProps'.
  Property 'eaDir' is missing in type '{ children: ReactNode }' but required in type 'LayoutProps'.

Next.js build worker exited with code: 1 and signal: null
```

**根因**：DSM 的文件索引/缩略图服务会在它扫描过的目录里创建 `@eaDir`（存缩略图和索引库）。  
而 Next.js App Router 规定 **以 `@` 开头的目录 = 并行路由插槽（parallel route slot）**。  
于是 `src/app/admin/@eaDir/` 被当成了名为 `eaDir` 的插槽，Next 为 `/admin` 生成的布局类型变成：

```ts
// .next/types/app/admin/layout.ts（Next 构建时自动生成）
export interface LayoutProps {
  children?: React.ReactNode
  eaDir: React.ReactNode     // ← 因为磁盘上存在 src/app/admin/@eaDir/
  params?: any
}
```

而 `src/app/admin/layout.tsx` 的签名是 `{ children }: { children: React.ReactNode }`，  
少一个必填属性 → 类型检查不通过 → 整个构建中断。

**为什么特别难查**：这条报错**一个字都没提 NAS**，而且 `Compiled successfully` 已经打出来了，  
看起来像代码写错了。实际代码没有任何问题，纯粹是磁盘上多了个目录。

**处理（三层，都已内置）**：

```bash
# ① install.sh 会自动调用；手工构建时自己跑
sh deploy/clean-nas-junk.sh --dry-run     # 先预演，看看会删哪些
sh deploy/clean-nas-junk.sh               # 确认后执行

# ② .dockerignore 已排除 @eaDir 等（防止它们进入构建上下文）

# ③ Dockerfile 构建阶段内置了 find ... -delete 兜底（防止 DSM 在构建前又生成一次）
```

**想根治**（避免 DSM 反复生成）：把该目录从索引里排除 ——  
`控制面板 → 索引服务 → 文件索引 → 排除列表`，加入 `/srv`。

> 同类垃圾还有 `#recycle`、`@tmp`、`@SynoEAStream`、`Thumbs.db`、`desktop.ini`、`.DS_Store`，  
> 清理脚本一并处理。

### 构建失败怎么定位

`Next.js build worker exited with code: 1 and signal: null` 这句话**本身没有信息量** —— 它是 Next 的 build worker  
被模块级异常打断后的兜底提示，真正的错误行在它上面几十行。先按下面两步取证：

```bash
cd /srv/nvidia-api-monitor

# ① 先确认 Dockerfile 是不是带构建期占位符的版本（输出 2 行即正确，0 行说明是老版本）
grep -c "build-time-placeholder" Dockerfile

# ② 重跑构建并完整留存日志（必须 --progress=plain，否则 docker 会用滚动行覆盖掉关键输出）
docker compose build --progress=plain app 2>&1 | tee /tmp/nvb.log

# ③ 捞出真正的错误
grep -nE "Error|error|Failed|Cannot find|heap|exit" /tmp/nvb.log | head -30
```

按 ③ 的结果对照：

| 关键行                                                | 含义                                 | 处理                                                                           |
| -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `NEXTAUTH_SECRET must be set to a 32+ char secret` | Dockerfile 缺少构建期占位符（老版本）           | 换成新版 `Dockerfile`，其中 `[build] NEXTAUTH_SECRET len = 53  OK` 这行自检必须出现         |
| `Environment variable not found: DATABASE_URL`     | 同上，缺 `DATABASE_URL` 占位符            | 同上                                                                           |
| `JavaScript heap out of memory`                    | NAS 内存不足                           | `free -h` 看可用内存；重建容器时共享宿主内存，需 ≥ 2GB。或走方案 B 在别处构建                             |
| `Cannot find module '...'`                         | 源码包不完整                             | 重新解压源码包：`tar -xzf 包.tar.gz --strip-components=1`                             |
| `Query engine binary ... not found`                | 构建上下文里混进了 Windows 的 `node_modules` | 确认 `.dockerignore` 里有 `node_modules` 一行，然后 `docker compose build --no-cache` |


| `Killed` / `exit code 137` | 被系统 OOM 杀掉（不是代码问题） | 加交换分区，或走方案 B |

构建期自检正常时，日志里会有这样一段（**这是判断占位符是否生效的依据**）：

```
[build] NEXT_PHASE            = phase-production-build
[build] NEXTAUTH_SECRET  len  = 53  OK
[build] ENCRYPTION_KEY   len  = 64  OK
[build] DATABASE_URL         = file:/tmp/build-placeholder.db
```

> 构建期占位符**不会进入最终镜像**：builder 与 runner 是两个独立的 `FROM` 阶段，  
> 只有文件被 `COPY` 过去，`ENV` 不继承。真实密钥由入口脚本在运行时生成/注入。

---

## 8. 方案 B：本地构建镜像，再导入 NAS

适合 NAS 性能不足、或架构是 `armv7l` 的情况。前提是本机装了 Docker Desktop。

```bash
# 本机（项目根目录）
docker build -t nvidia-api-monitor:latest .
docker save nvidia-api-monitor:latest | gzip > nvidia-api-monitor-image.tar.gz
```

注意：**必须为你 NAS 的架构构建**。x86 NAS 用默认即可；  
ARM NAS 需要 `docker buildx build --platform linux/arm64 -t nvidia-api-monitor:latest .`。

```bash
# NAS 上：把 docker-compose.yml 里的 build: 段删掉（改为直接用已导入的镜像）
gunzip -c nvidia-api-monitor-image.tar.gz | docker load
docker compose up -d
```

---

## 9. 三条不能破的约束（再强调一次）

1. **只能跑 1 个容器**。调度是进程内定时器，多副本会重复探测 + SQLite 写冲突。  
   不要加 `deploy.replicas`，不要起第二个容器指向同一个 `data` 目录。
2. **`data` 必须在本地卷**（物理磁盘；群晖上即 `/volumeN`）。SQLite 放在 NFS/SMB 网络共享上会因文件锁异常损坏。
3. **`data` 要和数据库一起备份** —— 里面还有 `.secrets.env`（`ENCRYPTION_KEY`）。
