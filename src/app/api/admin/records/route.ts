import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

function dayToDate(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const studentId = searchParams.get("studentId");
  const day = searchParams.get("day");
  if (!studentId || !day) {
    return NextResponse.json({ error: "studentId and day required" }, { status: 400 });
  }

  if (me.role === "ADMIN") {
    const assignment = await prisma.adminAssignment.findUnique({
      where: { adminId_studentId: { adminId: me.id, studentId } },
    });
    if (!assignment) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (me.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const record = await prisma.dayRecord.findUnique({
    where: {
      userId_day: {
        userId: studentId,
        day: dayToDate(day),
      },
    },
  });

  return NextResponse.json({ record });
}
