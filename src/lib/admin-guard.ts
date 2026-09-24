import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

export async function requireAdmin(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
