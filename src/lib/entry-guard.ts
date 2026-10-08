/**
 * 全局入口密码守卫。
 *
 * 生效范围（Settings.entryPasswordHash 非空时）：
 * - 首页 `/`：未解锁 → 重定向 /entry（见 src/app/page.tsx 的服务端包装）；
 * - 公开 API（/api/models*）：未解锁 → 401 JSON；
 * - 不拦 `/entry`、`/api/entry/verify`（它们就是验证入口本身）、`/api/health`（容器健康检查专用，绝不能被门禁拦住）、
 *   `/login` 与 `/admin`（后者已有 NextAuth 会话守卫，登录表单本身无数据可泄）。
 *
 * 为什么不在 middleware 里做：Edge 中间件读不到数据库，无法判断「入口密码
 * 是否已配置」；而本守卫在 Node 运行时（页面/路由处理器）里可直接查 Settings。
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ENTRY_COOKIE_NAME,
  ENTRY_HASH_PREFIX_LEN,
  entryTokenSecret,
  verifyEntryToken,
} from "@/lib/entry-token";

interface EntryState {
  enabled: boolean;
  hash: string | null;
}

/** 读 Settings 单例的入口密码哈希；单例不存在（新库）视为未启用，不触发自愈写。
 *  查询失败（如构建期占位库无表）也按「未启用」处理：
 *  - 门禁的所有消费方都应是 force-dynamic 的动态路由，正常运行期不该走到这里；
 *  - 即便运行期 DB 故障时误放行，数据 API 也全数 500，无数据可泄。 */
export async function getEntryState(): Promise<EntryState> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const hash = row?.entryPasswordHash ?? null;
    return { enabled: typeof hash === "string" && hash !== "", hash };
  } catch {
    return { enabled: false, hash: null };
  }
}

async function isUnlocked(state: EntryState): Promise<boolean> {
  if (!state.enabled || !state.hash) return true;
  const token = cookies().get(ENTRY_COOKIE_NAME)?.value;
  if (!token) return false;
  return verifyEntryToken(
    token,
    state.hash.slice(0, ENTRY_HASH_PREFIX_LEN),
    entryTokenSecret(),
  );
}

/** 页面用：入口是否已解锁（未配置入口密码时恒为 true） */
export async function isEntryUnlocked(): Promise<boolean> {
  return isUnlocked(await getEntryState());
}

/** 公开 API 用：通过返回 null，未通过返回 401 响应（调用方直接 return 它） */
export async function requireEntryAccess(): Promise<NextResponse | null> {
  if (await isUnlocked(await getEntryState())) return null;
  return NextResponse.json({ error: "entry password required" }, { status: 401 });
}
