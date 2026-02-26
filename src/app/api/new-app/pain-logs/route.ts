import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { ensureNewAppUser } from "@/lib/new-app-user";
import { ensureNewAppSchema } from "@/lib/new-app-schema";
import { prismaNewApp } from "@/lib/prisma-new-app";

function parseDate(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    await ensureNewAppSchema();
    await ensureNewAppUser(user);

    const { searchParams } = new URL(request.url);
    const from = parseDate(searchParams.get("from"));
    const to = parseDate(searchParams.get("to"));
    const limitRaw = Number(searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 30;

    const logs = await prismaNewApp.painLog.findMany({
      where: {
        userId: user.id,
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ occurredAt: "desc" }],
      take: limit,
      include: {
        reflection: true,
        actionPlans: {
          orderBy: [{ createdAt: "desc" }],
        },
      },
    });

    return NextResponse.json({ logs });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "DB error";
    return NextResponse.json(
      {
        error:
          "새 앱 DB 조회에 실패했습니다. 새 앱 migration SQL 적용 여부와 DATABASE_URL 연결을 확인해 주세요.",
        detail: message,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    await ensureNewAppSchema();
    await ensureNewAppUser(user);

    const body = (await request.json()) as {
      occurredAt?: unknown;
      intensity?: unknown;
      emotion?: unknown;
      situation?: unknown;
      triggerText?: unknown;
      bodySignal?: unknown;
      autoNote?: unknown;
    };

    const occurredAt = parseDate(
      typeof body.occurredAt === "string" ? body.occurredAt : new Date().toISOString()
    );
    const intensity = Number(body.intensity ?? 0);
    const emotion = String(body.emotion ?? "").trim();
    const situation = String(body.situation ?? "").trim();
    const triggerText = String(body.triggerText ?? "").trim();
    const bodySignal = String(body.bodySignal ?? "").trim();
    const autoNote = String(body.autoNote ?? "").trim();

    if (!occurredAt) {
      return NextResponse.json({ error: "Invalid occurredAt" }, { status: 400 });
    }
    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 10) {
      return NextResponse.json({ error: "intensity must be integer 1..10" }, { status: 400 });
    }
    if (!emotion || !situation || !triggerText || !bodySignal) {
      return NextResponse.json(
        { error: "emotion, situation, triggerText, bodySignal are required" },
        { status: 400 }
      );
    }

    const log = await prismaNewApp.painLog.create({
      data: {
        userId: user.id,
        occurredAt,
        intensity,
        emotion,
        situation,
        triggerText,
        bodySignal,
        autoNote: autoNote || null,
      },
    });

    return NextResponse.json({ log }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "DB error";
    return NextResponse.json(
      {
        error:
          "새 앱 DB 저장에 실패했습니다. 새 앱 migration SQL 적용 여부와 DATABASE_URL 연결을 확인해 주세요.",
        detail: message,
      },
      { status: 500 }
    );
  }
}
