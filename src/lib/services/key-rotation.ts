import type { KeyCandidate } from "@/types";

/**
 * Key 是否可用：只看是否启用。
 *
 * 本项目**不对 Key 做任何冻结/冷却**——Key 不是失败源：
 * 上游过载（ResourceExhausted）与超时的瓶颈都在模型/Worker 侧，换 Key 无效；
 * 而冻结会造成级联掏空（一个坏模型拖垮整个 Key 池，使后续模型全部记
 * "no available api key"）。`cooledUntil` 字段保留以兼容既有数据，但不再参与判定。
 */
export function isKeyAvailable(key: KeyCandidate): boolean {
  return key.enabled;
}

/**
 * 进程内轮询游标：记录每个 Key 池上次用到的位置。
 *
 * 为什么需要它：仅靠 `lastUsedAt` 排序**无法实现轮询**——`keys` 数组在同一轮任务里
 * 是内存快照，`sort` 的键恒定不变，于是每次都返回同一个 Key
 * （实测 4 个 Key 优先级相同 → 整轮只用其中一个）。
 * 用显式游标按顺序轮转，才能保证真正的轮询。
 */
const rotationCursor = new Map<string, number>();

/**
 * 进程内「正在使用中」计数（Key id → 并发占用数）。
 *
 * 为什么需要它：`selectNextKey` 过去只在池内按游标轮询，而调用方（健检）在
 * 「并发度 = Key 个数」下会同时启动 N 个请求 —— 若最高优先级池只有 1 把 Key，
 * N 个请求会**全部选中同一把**，多 Key 的并发分摊形同虚设。
 * 有了占用计数，选择时优先取空闲 Key，高优先级池全忙时才溢出到下一优先级池。
 */
const inflight = new Map<string, number>();

/** 标记某个 Key 已被占用（发起请求前调用） */
export function markKeyBusy(id: string): void {
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
}

/** 解除占用（请求结束/失败后调用，必须放在 finally 里） */
export function markKeyIdle(id: string): void {
  const n = (inflight.get(id) ?? 0) - 1;
  if (n <= 0) inflight.delete(id);
  else inflight.set(id, n);
}

/** 轮询池标识：同优先级视为同一池，池内轮转；高优先级池优先 */
function poolKey(priority: number): string {
  return `p${priority}`;
}

/**
 * 选择下一个 Key（轮询）。
 *
 * 规则：
 * 1. 只在启用的 Key 中选择（不做任何冻结/冷却，见 isKeyAvailable）。
 * 2. **优先级优先**：优先用最高优先级的池。
 * 3. **池内优先空闲**：同池内在「当前未被并发占用」的 Key 之间轮询；
 *    池内全部处于占用状态时，才溢出到次高优先级池
 *    （否则"并发度 = Key 个数"会退化成 N 个请求打同一把 Key）。
 * 4. 池内**严格轮询**：进程内游标保证跨调用持续轮转；
 *    传入的 `lastUsedAt` 仅作游标缺失时的初始参考。
 */
export function selectNextKey<T extends KeyCandidate>(keys: T[]): T | null {
  const available = keys.filter(isKeyAvailable);
  if (available.length === 0) return null;

  // 按优先级降序、同优先级按 id 稳定排序（不依赖入参顺序）
  const ordered = [...available].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // 优先级层级降序去重；逐层优先取「空闲」的 Key，本层全部被占用才降级到下一层
  const tiers = Array.from(new Set(ordered.map((k) => k.priority)));
  for (const p of tiers) {
    const idleTier = ordered.filter((k) => k.priority === p && (inflight.get(k.id) ?? 0) === 0);
    if (idleTier.length > 0) return pick(idleTier, p);
  }
  // 并发度 > Key 总数：所有 Key 都在使用中，复用最高优先级池
  const topPriority = tiers[0];
  return pick(ordered.filter((k) => k.priority === topPriority), topPriority);
}

/** 在给定候选集内按游标轮询（游标按优先级池分别维护） */
function pick<T extends KeyCandidate>(cand: T[], priority: number): T {
  if (cand.length === 1) return cand[0];
  const pk = poolKey(priority);
  const cursor = rotationCursor.get(pk) ?? 0;
  const picked = cand[cursor % cand.length];
  rotationCursor.set(pk, (cursor + 1) % cand.length);
  return picked;
}

/** 测试辅助：清空轮询游标 */
export function resetKeyRotation(): void {
  rotationCursor.clear();
  inflight.clear();
}

export interface KeyCandidateWithSecret extends KeyCandidate {
  secret: string;
  /**
   * 该 Key 对应的上游地址。请求必须使用**选中 Key 自己的** baseUrl ——
   * 多 Key 指向不同上游时，用「另一把 Key 的地址 + 本 Key 的 secret」必然鉴权失败。
   * 可选是为了兼容测试中只传单个 baseUrl 的构造方式（此时回退到调用方给的 baseUrl）。
   */
  baseUrl?: string;
}
