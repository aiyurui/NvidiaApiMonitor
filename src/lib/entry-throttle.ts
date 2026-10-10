// 入口密码验证失败限流（内存态：仅当前进程有效，多实例/重启后失效）。
// 与 login-throttle 同构：10 分钟窗口内失败 5 次即锁定，按客户端 IP 计。
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_KEYS = 2000;
const fails = new Map<string, number[]>();

/** 全局兜底预算：所有 IP 合计失败达该次数同样锁定。
 *  为什么需要它：应用层只能从头里解析来源 IP——经反代时取 X-Real-IP / XFF 末位可信，
 *  但直连容器端口（compose 的 ports 是公开映射）时攻击者可任意伪造这些头轮换"IP"。
 *  代价：恶意刷失败可让 10 分钟内入口验证全站不可用（管理员有会话旁路，不受影响）。 */
const GLOBAL_KEY = "__global__";
export const ENTRY_GLOBAL_MAX_FAILS = 20;

function prune(list: number[], now: number): number[] {
  return list.filter((t) => now - t < WINDOW_MS);
}

/** 从请求头解析客户端标识（用于 per-IP 限流）。
 *  顺序：X-Real-IP（我们的 nginx 用 $remote_addr 设置，不可伪造）
 *  → X-Forwarded-For 的**最后一个**（$proxy_add_x_forwarded_for 追加的那个；
 *    ⚠️ 第一个值是客户端自带的，取它等于让攻击者自己选限流键）
 *  → "local"（直连/无头）。 */
export function clientKeyFromHeaders(get: (name: string) => string | null): string {
  const realIp = get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return "local";
}

export function isEntryBlocked(key: string, now = Date.now()): boolean {
  const pruned = prune(fails.get(key) ?? [], now);
  if (pruned.length === 0) {
    fails.delete(key);
    return false;
  }
  fails.set(key, pruned);
  return pruned.length >= MAX_FAILS;
}

export function recordEntryFailure(key: string, now = Date.now()): void {
  const pruned = prune([...(fails.get(key) ?? []), now], now);
  fails.delete(key);
  fails.set(key, pruned);
  while (fails.size > MAX_KEYS) {
    const oldest = fails.keys().next();
    if (oldest.done) break;
    fails.delete(oldest.value);
  }
}

export function clearEntryFailures(key: string): void {
  fails.delete(key);
}

export function isEntryBlockedGlobal(now = Date.now()): boolean {
  const pruned = prune(fails.get(GLOBAL_KEY) ?? [], now);
  if (pruned.length === 0) {
    fails.delete(GLOBAL_KEY);
    return false;
  }
  fails.set(GLOBAL_KEY, pruned);
  return pruned.length >= ENTRY_GLOBAL_MAX_FAILS;
}

export function recordEntryFailureGlobal(now = Date.now()): void {
  recordEntryFailure(GLOBAL_KEY, now);
}
