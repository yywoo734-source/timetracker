import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.role !== "SUPER_ADMIN" || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  const role = searchParams.get("role") ?? undefined;

  const users = await prisma.user.findMany({
    where: {
      status: status as any,
      role: role as any,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return NextResponse.json({ users });
}
