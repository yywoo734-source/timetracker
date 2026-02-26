import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

type PlannerItem = {
  id: string;
  text: string;
  done: boolean;
  kind?: string;
  startMin?: number;
  durMin?: number;
  intensity?: number;
  color?: string;
  repeatType?: string;
  repeatUntil?: string;
  repeatGroupId?: string;
  repeatWeekdays?: number[];
};

function dayToDate(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

function normalizeDay(day: string | null) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day;
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeItems(value: unknown): PlannerItem[] {
  if (!Array.isArray(value)) return [];
  const out: PlannerItem[] = [];
  for (const x of value) {
    const item = asObject(x);
    const id = String(item.id ?? "").trim();
    const text = String(item.text ?? "").trim();
    if (!id || !text) continue;

    const next: PlannerItem = {
      id,
      text: text.slice(0, 120),
      done: Boolean(item.done),
    };

    const kindRaw = String(item.kind ?? "").trim();
    if (kindRaw) next.kind = kindRaw.slice(0, 24);

    const startRaw = Number(item.startMin);
    if (Number.isFinite(startRaw)) next.startMin = Math.max(0, Math.min(1439, Math.round(startRaw)));

    const durRaw = Number(item.durMin);
    if (Number.isFinite(durRaw)) next.durMin = Math.max(5, Math.min(12 * 60, Math.round(durRaw)));

    const intensityRaw = Number(item.intensity);
    if (Number.isFinite(intensityRaw)) next.intensity = Math.max(0, Math.min(100, Math.round(intensityRaw)));

    const colorRaw = String(item.color ?? "").trim();
    if (colorRaw) next.color = colorRaw.slice(0, 24);

    const repeatTypeRaw = String(item.repeatType ?? "").trim().toUpperCase();
    if (repeatTypeRaw === "DAILY" || repeatTypeRaw === "WEEKLY" || repeatTypeRaw === "CUSTOM") {
      next.repeatType = repeatTypeRaw;
    }

    const repeatUntilRaw = String(item.repeatUntil ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(repeatUntilRaw)) next.repeatUntil = repeatUntilRaw;

    const repeatGroupIdRaw = String(item.repeatGroupId ?? "").trim();
    if (repeatGroupIdRaw) next.repeatGroupId = repeatGroupIdRaw.slice(0, 80);

    if (Array.isArray(item.repeatWeekdays)) {
      const weekdays = item.repeatWeekdays
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (weekdays.length > 0) next.repeatWeekdays = Array.from(new Set(weekdays));
    }

    out.push(next);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = normalizeDay(searchParams.get("from"));
  const to = normalizeDay(searchParams.get("to"));
  if (!from || !to) {
    return NextResponse.json({ error: "from/to required (YYYY-MM-DD)" }, { status: 400 });
  }

  const records = await prisma.dayRecord.findMany({
    where: {
      userId: user.id,
      day: {
        gte: dayToDate(from),
        lte: dayToDate(to),
      },
    },
    select: { day: true, notes: true },
    orderBy: { day: "asc" },
  });

  const planningByDay: Record<string, PlannerItem[]> = {};
  for (const r of records) {
    const day = r.day.toISOString().slice(0, 10);
    const notes = asObject(r.notes);
    planningByDay[day] = sanitizeItems(notes.plannerTodos);
  }

  return NextResponse.json({ planningByDay });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { day?: string; items?: unknown };
  const day = normalizeDay(body.day ?? null);
  if (!day) {
    return NextResponse.json({ error: "day required (YYYY-MM-DD)" }, { status: 400 });
  }
  const items = sanitizeItems(body.items);

  const existing = await prisma.dayRecord.findUnique({
    where: { userId_day: { userId: user.id, day: dayToDate(day) } },
    select: { blocks: true, notes: true, categories: true },
  });

  const existingNotes = asObject(existing?.notes);
  const nextNotes = { ...existingNotes, plannerTodos: items };

  await prisma.dayRecord.upsert({
    where: { userId_day: { userId: user.id, day: dayToDate(day) } },
    update: {
      blocks: existing?.blocks ?? [],
      notes: nextNotes,
      categories: existing?.categories ?? {},
    },
    create: {
      userId: user.id,
      day: dayToDate(day),
      blocks: existing?.blocks ?? [],
      notes: nextNotes,
      categories: existing?.categories ?? {},
    },
  });

  return NextResponse.json({ ok: true });
}
