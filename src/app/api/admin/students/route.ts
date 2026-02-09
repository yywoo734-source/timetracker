import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (me.role === "SUPER_ADMIN") {
    const students = await prisma.user.findMany({
      where: { role: "STUDENT", status: "APPROVED" },
      orderBy: [{ createdAt: "desc" }],
    });
    return NextResponse.json({ students });
  }

  if (me.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const assignments = await prisma.adminAssignment.findMany({
    where: { adminId: me.id },
    include: { student: true },
    orderBy: [{ createdAt: "desc" }],
  });

  const students = assignments.map((a) => a.student);
  return NextResponse.json({ students });
}
