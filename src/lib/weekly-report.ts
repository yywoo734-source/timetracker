import type { PrismaClient } from "@/generated/prisma/client";

type WeekCategoryStat = {
  categoryId: string;
  label: string;
  color: string;
  minutes: number;
  prevMinutes: number;
  deltaMinutes: number;
  memoCount: number;
};

type DayTotal = {
  day: string;
  minutes: number;
};

type DailyCategoryTotal = {
  day: string;
  totalMinutes: number;
  categoryMinutes: Record<string, number>;
};

type WeeklyMemo = {
  day: string;
  categoryId: string;
  categoryLabel: string;
  text: string;
};

export type WeeklyReport = {
  day: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  prevTotalMinutes: number;
  deltaTotalMinutes: number;
  categories: WeekCategoryStat[];
  dailyTotals: DayTotal[];
  dailyCategoryTotals: DailyCategoryTotal[];
  memos: WeeklyMemo[];
};

type BlockShape = { categoryId?: unknown; dur?: unknown };
type CategoryShape = { id?: unknown; label?: unknown; color?: unknown };

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function parseIsoDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatIsoDay(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toDateUtc(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function addDays(iso: string, days: number) {
  const d = parseIsoDay(iso);
  d.setDate(d.getDate() + days);
  return formatIsoDay(d);
}

function mondayStart(iso: string) {
  const d = parseIsoDay(iso);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatIsoDay(d);
}

function toSafeBlocks(value: unknown) {
  if (!Array.isArray(value)) return [] as Array<{ categoryId: string; dur: number }>;
  return value
    .map((b) => {
      const block = b as BlockShape;
      const categoryId = String(block.categoryId ?? "");
      const dur = Number(block.dur ?? 0);
      if (!categoryId || !Number.isFinite(dur) || dur <= 0) return null;
      return { categoryId, dur };
    })
    .filter((x): x is { categoryId: string; dur: number } => x !== null);
}

function toCategoryList(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [] as CategoryShape[];
  const list = (value as { list?: unknown }).list;
  if (!Array.isArray(list)) return [] as CategoryShape[];
  return list as CategoryShape[];
}

function toNotesByCategory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  const raw = value as Record<string, unknown>;
  const byCategory = raw.byCategory;
  const source =
    byCategory && typeof byCategory === "object" && !Array.isArray(byCategory)
      ? (byCategory as Record<string, unknown>)
      : raw;

  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    const text = String(v ?? "").trim();
    if (text) next[k] = text;
  }
  return next;
}

function resolveCategoryLabel(id: string, labels: Map<string, { label: string; color: string }>) {
  const found = labels.get(id);
  if (found) return found;
  return { label: id.slice(0, 8), color: "#6b7280" };
}

export async function buildWeeklyReport(prisma: PrismaClient, userId: string, day: string): Promise<WeeklyReport> {
  const weekStart = mondayStart(day);
  const weekEnd = addDays(weekStart, 6);
  const prevWeekStart = addDays(weekStart, -7);
  const prevWeekEnd = addDays(weekStart, -1);

  const [weekRecords, prevWeekRecords, overrides] = await Promise.all([
    prisma.dayRecord.findMany({
      where: {
        userId,
        day: {
          gte: toDateUtc(weekStart),
          lte: toDateUtc(weekEnd),
        },
      },
      orderBy: { day: "asc" },
    }),
    prisma.dayRecord.findMany({
      where: {
        userId,
        day: {
          gte: toDateUtc(prevWeekStart),
          lte: toDateUtc(prevWeekEnd),
        },
      },
      orderBy: { day: "asc" },
    }),
    prisma.categoryOverride.findMany({
      where: { studentId: userId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const labels = new Map<string, { label: string; color: string }>();
  for (const o of overrides) {
    labels.set(o.categoryId, { label: o.label, color: o.color ?? "#6b7280" });
  }

  for (const r of weekRecords) {
    for (const c of toCategoryList(r.categories)) {
      const id = String(c.id ?? "");
      if (!id || labels.has(id)) continue;
      labels.set(id, {
        label: String(c.label ?? id.slice(0, 8)),
        color: String(c.color ?? "#6b7280"),
      });
    }
  }

  const currentMinutesByCategory: Record<string, number> = {};
  const prevMinutesByCategory: Record<string, number> = {};
  const memoByCategoryCount: Record<string, number> = {};
  const memos: WeeklyMemo[] = [];
  const dayTotalsMap = new Map<string, number>();
  const dayCategoryTotalsMap = new Map<string, Record<string, number>>();

  for (const r of weekRecords) {
    const dayKey = formatIsoDay(r.day);
    let dayMinutes = 0;

    for (const b of toSafeBlocks(r.blocks)) {
      currentMinutesByCategory[b.categoryId] = (currentMinutesByCategory[b.categoryId] ?? 0) + b.dur;
      dayMinutes += b.dur;
      const dayCategoryTotals = dayCategoryTotalsMap.get(dayKey) ?? {};
      dayCategoryTotals[b.categoryId] = (dayCategoryTotals[b.categoryId] ?? 0) + b.dur;
      dayCategoryTotalsMap.set(dayKey, dayCategoryTotals);
    }

    dayTotalsMap.set(dayKey, (dayTotalsMap.get(dayKey) ?? 0) + dayMinutes);

    const notesByCategory = toNotesByCategory(r.notes);
    for (const [categoryId, text] of Object.entries(notesByCategory)) {
      memoByCategoryCount[categoryId] = (memoByCategoryCount[categoryId] ?? 0) + 1;
      const meta = resolveCategoryLabel(categoryId, labels);
      memos.push({
        day: dayKey,
        categoryId,
        categoryLabel: meta.label,
        text,
      });
    }
  }

  for (const r of prevWeekRecords) {
    for (const b of toSafeBlocks(r.blocks)) {
      prevMinutesByCategory[b.categoryId] = (prevMinutesByCategory[b.categoryId] ?? 0) + b.dur;
    }
  }

  const categoryIds = new Set([
    ...Object.keys(currentMinutesByCategory),
    ...Object.keys(prevMinutesByCategory),
    ...Object.keys(memoByCategoryCount),
  ]);

  const categories: WeekCategoryStat[] = Array.from(categoryIds).map((id) => {
    const meta = resolveCategoryLabel(id, labels);
    const minutes = currentMinutesByCategory[id] ?? 0;
    const prevMinutes = prevMinutesByCategory[id] ?? 0;
    return {
      categoryId: id,
      label: meta.label,
      color: meta.color,
      minutes,
      prevMinutes,
      deltaMinutes: minutes - prevMinutes,
      memoCount: memoByCategoryCount[id] ?? 0,
    };
  });

  categories.sort((a, b) => b.minutes - a.minutes);

  const dailyTotals: DayTotal[] = Array.from({ length: 7 }).map((_, i) => {
    const d = addDays(weekStart, i);
    return { day: d, minutes: dayTotalsMap.get(d) ?? 0 };
  });
  const dailyCategoryTotals: DailyCategoryTotal[] = Array.from({ length: 7 }).map((_, i) => {
    const d = addDays(weekStart, i);
    const categoryMinutes = dayCategoryTotalsMap.get(d) ?? {};
    const totalMinutes = Object.values(categoryMinutes).reduce((a, b) => a + b, 0);
    return { day: d, totalMinutes, categoryMinutes };
  });

  const totalMinutes = Object.values(currentMinutesByCategory).reduce((a, b) => a + b, 0);
  const prevTotalMinutes = Object.values(prevMinutesByCategory).reduce((a, b) => a + b, 0);

  return {
    day,
    weekStart,
    weekEnd,
    totalMinutes,
    prevTotalMinutes,
    deltaTotalMinutes: totalMinutes - prevTotalMinutes,
    categories,
    dailyTotals,
    dailyCategoryTotals,
    memos,
  };
}

export function toWeeklyFeedbackPrompt(report: WeeklyReport) {
  return JSON.stringify(
    {
      period: `${report.weekStart} ~ ${report.weekEnd}`,
      totalMinutes: report.totalMinutes,
      deltaTotalMinutes: report.deltaTotalMinutes,
      categories: report.categories.map((c) => ({
        label: c.label,
        minutes: c.minutes,
        deltaMinutes: c.deltaMinutes,
        memoCount: c.memoCount,
      })),
      memos: report.memos.slice(0, 20).map((m) => ({
        day: m.day,
        category: m.categoryLabel,
        text: m.text,
      })),
    },
    null,
    2
  );
}

export function buildFallbackWeeklyFeedback(report: WeeklyReport) {
  const top = report.categories[0];
  const up = [...report.categories].sort((a, b) => b.deltaMinutes - a.deltaMinutes)[0];
  const down = [...report.categories].sort((a, b) => a.deltaMinutes - b.deltaMinutes)[0];
  const lines: string[] = [];

  const totalHour = (report.totalMinutes / 60).toFixed(1);
  const deltaHour = (Math.abs(report.deltaTotalMinutes) / 60).toFixed(1);
  const deltaText =
    report.deltaTotalMinutes > 0 ? `지난주보다 ${deltaHour}시간 증가` : report.deltaTotalMinutes < 0 ? `지난주보다 ${deltaHour}시간 감소` : "지난주와 동일";
  lines.push(`이번 주 총 공부시간은 ${totalHour}시간이며 ${deltaText}입니다.`);

  if (top) lines.push(`가장 많은 시간을 쓴 과목은 ${top.label}(${(top.minutes / 60).toFixed(1)}시간)입니다.`);
  if (up && up.deltaMinutes > 0) lines.push(`상승 폭이 큰 과목은 ${up.label}(+${(up.deltaMinutes / 60).toFixed(1)}시간)입니다.`);
  if (down && down.deltaMinutes < 0) lines.push(`감소한 과목은 ${down.label}(${(down.deltaMinutes / 60).toFixed(1)}시간)입니다.`);

  const memoSample = report.memos.slice(0, 3);
  if (memoSample.length > 0) {
    lines.push("메모 기반으로 보면 최근 학습 포인트가 명확하게 남아 있습니다.");
    for (const m of memoSample) {
      lines.push(`- ${m.day} ${m.categoryLabel}: ${m.text}`);
    }
  }

  lines.push("다음 주에는 상위 1~2개 핵심 과목의 고정 시간을 먼저 확보하고, 감소한 과목을 최소 유지 시간으로 보완해보세요.");
  return lines.join("\n");
}
