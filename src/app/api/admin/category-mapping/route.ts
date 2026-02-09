import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

async function canAccessStudent(adminId: string, studentId: string) {
  const assignment = await prisma.adminAssignment.findUnique({
    where: { adminId_studentId: { adminId, studentId } },
  });
  return !!assignment;
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
  if (!studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }

  if (me.role === "ADMIN") {
    const allowed = await canAccessStudent(me.id, studentId);
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (me.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const overrides = await prisma.categoryOverride.findMany({
    where: { studentId },
    orderBy: [{ createdAt: "desc" }],
  });

  return NextResponse.json({ overrides });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as {
    studentId: string;
    overrides: Array<{ categoryId: string; label: string; color?: string | null }>;
  };

  if (!body.studentId) {
    return NextResponse.json({ error: "studentId required" }, { status: 400 });
  }
  if (!Array.isArray(body.overrides)) {
    return NextResponse.json({ error: "overrides required" }, { status: 400 });
  }

  if (me.role === "ADMIN") {
    const allowed = await canAccessStudent(me.id, body.studentId);
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (me.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const results = [];
  for (const o of body.overrides) {
    if (!o.categoryId || !o.label) continue;
    const record = await prisma.categoryOverride.upsert({
      where: {
        studentId_categoryId: {
          studentId: body.studentId,
          categoryId: o.categoryId,
        },
      },
      update: {
        label: o.label,
        color: o.color ?? null,
      },
      create: {
        studentId: body.studentId,
        categoryId: o.categoryId,
        label: o.label,
        color: o.color ?? null,
      },
    });
    results.push(record);
  }

  return NextResponse.json({ overrides: results });
}
