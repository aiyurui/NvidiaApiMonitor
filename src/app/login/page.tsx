import { redirect } from "next/navigation";
import { isEntryUnlocked } from "@/lib/entry-guard";
import LoginForm from "@/components/LoginForm";

// 入口密码启用时，登录页本身也不允许绕过：/admin 的中间件会把未登录者送来这里，
// 若这里不设防，陌生人无需入口密码就能看到登录表单。未解锁 → 先去 /entry，
// 验证后带 callbackUrl 原路返回，登录链路完整保留。
// （管理员已登录的会话由 entry-guard 视为已解锁，不会困在 /entry。）
//
// force-dynamic：守卫依赖数据库与 Cookie，绝不能被构建期静态化
// （静态化后运行期将永远执行不到守卫逻辑）。
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  if (!(await isEntryUnlocked())) {
    const next = searchParams?.callbackUrl
      ? `/login?callbackUrl=${encodeURIComponent(searchParams.callbackUrl)}`
      : "/login";
    redirect(`/entry?next=${encodeURIComponent(next)}`);
  }
  return <LoginForm />;
}
