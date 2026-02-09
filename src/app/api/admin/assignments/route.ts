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
  const adminId = searchParams.get("adminId") ?? undefined;

  const assignments = await prisma.adminAssignment.findMany({
    where: adminId ? { adminId } : undefined,
    include: {
      admin: true,
      student: true,
      approvedBy: true,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return NextResponse.json({ assignments });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.role !== "SUPER_ADMIN" || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as { adminId: string; studentId: string };
  if (!body.adminId || !body.studentId) {
    return NextResponse.json({ error: "adminId and studentId required" }, { status: 400 });
  }

  const assignment = await prisma.adminAssignment.upsert({
    where: {
      adminId_studentId: { adminId: body.adminId, studentId: body.studentId },
    },
    update: {
      approvedById: me.id,
      approvedAt: new Date(),
    },
    create: {
      adminId: body.adminId,
      studentId: body.studentId,
      approvedById: me.id,
      approvedAt: new Date(),
    },
  });

  return NextResponse.json({ assignment });
}
