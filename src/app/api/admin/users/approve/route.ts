import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.role !== "SUPER_ADMIN" || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as {
    userId: string;
    status?: "PENDING" | "APPROVED" | "REJECTED";
    role?: "STUDENT" | "ADMIN";
  };

  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id: body.userId },
    data: {
      status: body.status ?? "APPROVED",
      role: body.role ?? "STUDENT",
    },
  });

  return NextResponse.json({ user: updated });
}
