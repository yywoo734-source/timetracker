import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

type CategoryPayload = {
  id: string;
  label: string;
  color: string;
};

function normalizeCategories(value: unknown): CategoryPayload[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = String((item as { id?: unknown }).id ?? "").trim();
      const label = String((item as { label?: unknown }).label ?? "").trim();
      const color = String((item as { color?: unknown }).color ?? "").trim();
      if (!id || !label || !color) return null;
      return { id, label, color };
    })
    .filter((item): item is CategoryPayload => item !== null);
}

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.categoryOverride.findMany({
    where: { studentId: user.id },
    orderBy: [{ createdAt: "asc" }],
  });

  const categories = rows.map((r) => ({
    id: r.categoryId,
    label: r.label,
    color: r.color ?? "#111827",
  }));

  return NextResponse.json({ categories });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { categories?: unknown };
  const categories = normalizeCategories(body.categories);

  const ids = new Set(categories.map((c) => c.id));

  // Full sync: payload에 없는 카테고리는 제거
  await prisma.categoryOverride.deleteMany({
    where: {
      studentId: user.id,
      ...(ids.size > 0 ? { categoryId: { notIn: Array.from(ids) } } : {}),
    },
  });

  for (const c of categories) {
    await prisma.categoryOverride.upsert({
      where: {
        studentId_categoryId: {
          studentId: user.id,
          categoryId: c.id,
        },
      },
      update: {
        label: c.label,
        color: c.color,
      },
      create: {
        studentId: user.id,
        categoryId: c.id,
        label: c.label,
        color: c.color,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
