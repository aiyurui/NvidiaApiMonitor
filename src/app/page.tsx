import { redirect } from "next/navigation";
import { isEntryUnlocked } from "@/lib/entry-guard";
import DashboardClient from "@/components/dashboard/DashboardClient";

// 服务端守卫：配置了全局入口密码且未解锁时，访问首页一律重定向到 /entry。
// （cookies() 的使用使本页自动成为动态渲染；公开 API 的对应拦截见 entry-guard.ts）
export default async function Home() {
  if (!(await isEntryUnlocked())) redirect("/entry");
  return <DashboardClient />;
}
