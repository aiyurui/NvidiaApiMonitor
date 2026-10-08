import { redirect } from "next/navigation";
import { isEntryUnlocked } from "@/lib/entry-guard";
import DashboardClient from "@/components/dashboard/DashboardClient";

// 强制动态渲染。不要指望「用了 cookies() Next 会自动跳过预渲染」：
// isEntryUnlocked 先查数据库（getEntryState），构建期占位库无表直接抛 P2021，
// 它不是 DynamicServerError、不会触发动态回退，而是让 next build 直接失败
// （2026-10-09 群晖构建实测踩坑）。显式声明才是确定性行为。
export const dynamic = "force-dynamic";

// 服务端守卫：配置了全局入口密码且未解锁时，访问首页一律重定向到 /entry。
// （公开 API 的对应拦截见 entry-guard.ts）
export default async function Home() {
  if (!(await isEntryUnlocked())) redirect("/entry");
  return <DashboardClient />;
}
