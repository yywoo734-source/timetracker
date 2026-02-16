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

  const { searchParams } = new URL(request.url);
  const day = normalizeDay(searchParams.get("day"));
  if (!day) {
    return NextResponse.json({ error: "day required (YYYY-MM-DD)" }, { status: 400 });
  }

  const report = await buildWeeklyReport(prisma, user.id, day);
  return NextResponse.json({ report });
}
