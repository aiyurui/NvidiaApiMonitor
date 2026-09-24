// 登录失败限流（内存态：仅当前进程有效，多实例/重启后失效）。
// 有界：空数组不驻留、总量超 2000 删最旧。
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_KEYS = 2000;
const fails = new Map<string, number[]>();

function prune(list: number[], now: number): number[] {
  return list.filter((t) => now - t < WINDOW_MS);
}

export function isLoginBlocked(email: string, now = Date.now()): boolean {
  const key = email.toLowerCase();
  const pruned = prune(fails.get(key) ?? [], now);
  if (pruned.length === 0) {
    fails.delete(key);
    return false;
  }
  fails.set(key, pruned);
  return pruned.length >= MAX_FAILS;
}

export function recordLoginFailure(email: string, now = Date.now()): void {
  const key = email.toLowerCase();
  const pruned = prune([...(fails.get(key) ?? []), now], now);
  fails.delete(key);
  fails.set(key, pruned);
  while (fails.size > MAX_KEYS) {
    const oldest = fails.keys().next();
    if (oldest.done) break;
    fails.delete(oldest.value);
  }
}

export function clearLoginFailures(email: string): void {
  fails.delete(email.toLowerCase());
}
