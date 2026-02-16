import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";
import { buildWeeklyReport } from "@/lib/weekly-report";

function normalizeDay(day: string | null) {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day;
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
  const day = normalizeDay(searchParams.get("day"));
  if (!studentId || !day) {
    return NextResponse.json({ error: "studentId and day required" }, { status: 400 });
  }

  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
  const isOnlyAdmin =
    me.role === "SUPER_ADMIN" &&
    (!superAdminEmail || me.email.toLowerCase() === superAdminEmail);

  if (!isOnlyAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const report = await buildWeeklyReport(prisma, studentId, day);
  return NextResponse.json({ report });
}
