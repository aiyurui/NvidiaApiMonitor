/**
 * PM2 进程配置
 *   启动：pm2 start deploy/ecosystem.config.cjs
 *   重载：pm2 reload nvidia-api-monitor
 *   开机自启：pm2 save && pm2 startup
 *
 * ⚠️ 必须保持 instances = 1 / exec_mode = "fork"
 *    调度是「进程内定时器」（src/lib/scheduler.ts），job 锁只在单进程内有效。
 *    起 cluster 或多个副本会导致：重复探测、重复写库、SQLite 写冲突。
 *    确实需要多实例时，只能用外部统一调度（定时 curl 触发），其余实例禁掉 cron。
 */
const APP_DIR = "/srv/nvidia-api-monitor";
const LOG_DIR = "/var/log/nvidia-api-monitor";

module.exports = {
  apps: [
    {
      name: "nvidia-api-monitor",
      cwd: APP_DIR,
      // 直接调 next 的入口，避免 npm 这层 wrapper 吞掉退出信号
      script: "node_modules/next/dist/bin/next",
      // -H 127.0.0.1：只监听本机，由 Nginx 对外暴露，不要把 3000 直接暴露公网
      args: "start -H 127.0.0.1 -p 3000",

      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      // 单轮健检可能跑 1~2 分钟，内存峰值不高，512M 足够；超了自动重启兜底
      max_memory_restart: "512M",
      // 给 Next.js 留够优雅退出时间（默认 1.6s 会在任务跑到一半时硬杀）
      kill_timeout: 15000,
      listen_timeout: 20000,

      out_file: `${LOG_DIR}/out.log`,
      error_file: `${LOG_DIR}/error.log`,
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: "production",
        PORT: "3000",
        // 让 next-auth 按请求的 Host / X-Forwarded-Host 推导访问地址。
        // Nginx 已经转发 Host 与 X-Forwarded-Proto（见 deploy/nginx.conf），
        // 所以这里开启后就不需要再配 NEXTAUTH_URL —— 换域名/IP 都不用改。
        AUTH_TRUST_HOST: "true",
        // 关掉 Next.js 遥测，减少无谓外网请求
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
};
