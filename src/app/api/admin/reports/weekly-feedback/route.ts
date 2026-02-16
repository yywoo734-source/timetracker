import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";
import {
  buildFallbackWeeklyFeedback,
  buildWeeklyReport,
  toWeeklyFeedbackPrompt,
} from "@/lib/weekly-report";

function normalizeDay(day: unknown) {
  if (typeof day !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day;
}

async function generateAiFeedback(prompt: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.5,
      input: [
        {
          role: "system",
          content:
            "당신은 학습 코치다. 한국어로 간결하게: 1) 이번주 요약 2) 과목별 동향 해석 3) 다음주 실행 액션 3가지를 제시하라.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) return null;
  const json = (await res.json()) as { output_text?: string };
  return json.output_text?.trim() || null;
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

  const body = (await request.json()) as { studentId?: unknown; day?: unknown };
  const studentId = typeof body.studentId === "string" ? body.studentId : null;
  const day = normalizeDay(body.day);
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
  const prompt = toWeeklyFeedbackPrompt(report);
  const aiFeedback = await generateAiFeedback(prompt);
  const feedback = aiFeedback ?? buildFallbackWeeklyFeedback(report);

  return NextResponse.json({
    feedback,
    source: aiFeedback ? "ai" : "fallback",
  });
}
