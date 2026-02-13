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

  const { searchParams } = new URL(request.url);
  const day = searchParams.get("day");
  if (!day) {
    return NextResponse.json({ error: "day required" }, { status: 400 });
  }

  const record = await prisma.dayRecord.findUnique({
    where: {
      userId_day: {
        userId: user.id,
        day: dayToDate(day),
      },
    },
  });

  return NextResponse.json({ record });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    day: string;
    blocks: unknown;
    notesByCategory: unknown;
    categories: unknown;
  };

  if (!body.day) {
    return NextResponse.json({ error: "day required" }, { status: 400 });
  }

  const record = await prisma.dayRecord.upsert({
    where: {
      userId_day: {
        userId: user.id,
        day: dayToDate(body.day),
      },
    },
    update: {
      blocks: body.blocks ?? [],
      notes: body.notesByCategory ?? {},
      categories: body.categories ?? {},
    },
    create: {
      userId: user.id,
      day: dayToDate(body.day),
      blocks: body.blocks ?? [],
      notes: body.notesByCategory ?? {},
      categories: body.categories ?? {},
    },
  });

  return NextResponse.json({ record });
}

export async function DELETE(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all");
  const day = searchParams.get("day");

  if (all !== "1") {
    if (!day) {
      return NextResponse.json({ error: "all=1 or day required" }, { status: 400 });
    }

    await prisma.dayRecord.deleteMany({
      where: {
        userId: user.id,
        day: dayToDate(day),
      },
    });

    return NextResponse.json({ ok: true });
  }

  await prisma.dayRecord.deleteMany({
    where: { userId: user.id },
  });

  return NextResponse.json({ ok: true });
}
