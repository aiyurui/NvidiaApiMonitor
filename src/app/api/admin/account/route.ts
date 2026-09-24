import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { hash, compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";

interface Body {
  email?: string;
  currentPassword?: string;
  newPassword?: string;
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad("请求体不是合法 JSON");
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return bad("当前账号不存在", 404);

  const nextEmail = typeof body.email === "string" ? body.email.trim() : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (nextEmail === "" && newPassword === "") {
    return bad("没有需要更新的内容");
  }

  // 任何修改都必须校验当前密码，避免会话被劫持后直接改密
  if (!body.currentPassword) return bad("请输入当前密码");
  const ok = await compare(body.currentPassword, user.password);
  if (!ok) return bad("当前密码不正确", 403);

  const data: { email?: string; password?: string } = {};

  if (nextEmail !== "" && nextEmail !== user.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) return bad("邮箱格式不正确");
    const exists = await prisma.user.findUnique({ where: { email: nextEmail } });
    if (exists) return bad("该邮箱已被占用", 409);
    data.email = nextEmail;
  }

  if (newPassword !== "") {
    if (newPassword.length < 8) return bad("新密码至少 8 位");
    if (newPassword === body.currentPassword) return bad("新密码不能与当前密码相同");
    data.password = await hash(newPassword, 10);
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });

  return NextResponse.json({
    ok: true,
    email: updated.email,
    // 邮箱变更后 JWT 里的邮箱仍是旧值，提示前端重新登录
    reloginRequired: updated.email !== session.user.email,
  });
}
