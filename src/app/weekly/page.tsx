"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type WeekCategory = {
  categoryId: string;
  label: string;
  color: string;
  minutes: number;
  prevMinutes: number;
  deltaMinutes: number;
  memoCount: number;
};

type DayTotal = { day: string; minutes: number };
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

type WeeklyReport = {
  day: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  prevTotalMinutes: number;
  deltaTotalMinutes: number;
  categories: WeekCategory[];
  dailyTotals: DayTotal[];
  dailyCategoryTotals: DailyCategoryTotal[];
  memos: WeeklyMemo[];
};
type ThemeMode = "light" | "dark";
const THEME_KEY = "timetracker_theme_mode_v1";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function isoDayKey03(date = new Date()) {
  const d = new Date(date);
  d.setHours(d.getHours() - 3);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtMin(min: number) {
  const rounded = Math.max(0, Math.round(min));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

function fmtSignedMin(min: number) {
  if (min === 0) return "0";
  const sign = min > 0 ? "+" : "-";
  return `${sign}${fmtMin(Math.abs(min))}`;
}

function fmtDay(iso: string) {
  return `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

function fmtPct(value: number) {
  return `${value.toFixed(1)}%`;
}

export default function WeeklyPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [day, setDay] = useState(isoDayKey03());
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [feedbackSource, setFeedbackSource] = useState<"ai" | "fallback" | null>(null);
  const [loadingFeedback, setLoadingFeedback] = useState(false);
  const [includedCategoryOverrides, setIncludedCategoryOverrides] = useState<Record<string, boolean>>({});
  const [themeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 920px)").matches;
  });

  const theme = useMemo(
    () =>
      themeMode === "dark"
        ? {
            bg: "#121212",
            card: "#171717",
            text: "#EAEAEA",
            muted: "#b0b0b0",
            border: "#2e2e2e",
            borderSoft: "#242424",
            controlBg: "#1f1f1f",
            controlText: "#EAEAEA",
            accentSoft: "#0f2b2f",
          }
        : {
            bg: "#f7f8fb",
            card: "#ffffff",
            text: "#111827",
            muted: "#666666",
            border: "#e5e7eb",
            borderSoft: "#f1f1f1",
            controlBg: "#ffffff",
            controlText: "#111827",
            accentSoft: "#ecfeff",
          },
    [themeMode]
  );

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 920px)");
    const apply = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data: userData } = await supabase.auth.getUser();
        if (!userData.user) {
          router.replace("/login");
          return;
        }
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token ?? null;
        if (!token) {
          router.replace("/login");
          return;
        }
        if (!cancelled) setAccessToken(token);
      } catch {
        if (!cancelled) router.replace("/login");
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/reports/weekly?day=${day}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        if (!cancelled) {
          setError("주간 리포트를 불러오지 못했습니다.");
          setLoading(false);
        }
        return;
      }
      const body = (await res.json()) as { report?: WeeklyReport };
      if (!cancelled) {
        setReport(body.report ?? null);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, day]);

  const includedCategoryIds = useMemo(() => {
    if (!report) return {} as Record<string, boolean>;
    const next: Record<string, boolean> = {};
    for (const c of report.categories) {
      const override = includedCategoryOverrides[c.categoryId];
      next[c.categoryId] = override ?? true;
    }
    return next;
  }, [report, includedCategoryOverrides]);

  const filteredTotalMinutes = useMemo(() => {
    if (!report) return 0;
    return report.categories.reduce(
      (acc, c) => (includedCategoryIds[c.categoryId] === false ? acc : acc + c.minutes),
      0
    );
  }, [report, includedCategoryIds]);

  const filteredPrevTotalMinutes = useMemo(() => {
    if (!report) return 0;
    return report.categories.reduce(
      (acc, c) => (includedCategoryIds[c.categoryId] === false ? acc : acc + c.prevMinutes),
      0
    );
  }, [report, includedCategoryIds]);

  const filteredDeltaTotalMinutes = filteredTotalMinutes - filteredPrevTotalMinutes;

  const filteredDailyTotals = useMemo(() => {
    if (!report) return [] as DayTotal[];
    const source =
      report.dailyCategoryTotals && report.dailyCategoryTotals.length > 0
        ? report.dailyCategoryTotals
        : report.dailyTotals.map((d) => ({ day: d.day, totalMinutes: d.minutes, categoryMinutes: {} }));
    return source.map((d) => {
      const minutes = Object.entries(d.categoryMinutes).reduce((acc, [categoryId, value]) => {
        if (includedCategoryIds[categoryId] === false) return acc;
        const parsed = typeof value === "number" ? value : Number(value);
        return acc + (Number.isFinite(parsed) ? parsed : 0);
      }, 0);
      return { day: d.day, minutes: Object.keys(d.categoryMinutes).length === 0 ? d.totalMinutes : minutes };
    });
  }, [report, includedCategoryIds]);

  const filteredMaxDaily = useMemo(() => {
    if (filteredDailyTotals.length === 0) return 1;
    return Math.max(1, ...filteredDailyTotals.map((d) => d.minutes));
  }, [filteredDailyTotals]);

  const summaryTopCategory = useMemo(() => {
    if (!report || filteredTotalMinutes <= 0) return null;
    const top = report.categories
      .filter((c) => includedCategoryIds[c.categoryId] !== false)
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (!top) return null;
    return {
      label: top.label,
      ratio: (top.minutes / filteredTotalMinutes) * 100,
      minutes: top.minutes,
    };
  }, [report, includedCategoryIds, filteredTotalMinutes]);

  const weakestDay = useMemo(() => {
    if (!report || filteredDailyTotals.length === 0) return null;
    const pastOrCurrentDays = filteredDailyTotals.filter((d) => d.day <= report.day);
    if (pastOrCurrentDays.length === 0) return null;
    const sorted = [...pastOrCurrentDays].sort((a, b) => a.minutes - b.minutes);
    return sorted[0] ?? null;
  }, [report, filteredDailyTotals]);

  async function generateFeedback() {
    if (!accessToken || !report) return;
    setLoadingFeedback(true);
    const res = await fetch("/api/reports/weekly-feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ day: report.day }),
    });
    if (!res.ok) {
      setFeedback("피드백 생성에 실패했습니다.");
      setFeedbackSource(null);
      setLoadingFeedback(false);
      return;
    }
    const body = (await res.json()) as { feedback?: string; source?: "ai" | "fallback" };
    setFeedback(body.feedback ?? "");
    setFeedbackSource(body.source ?? null);
    setLoadingFeedback(false);
  }

  function escapeHtml(text: string) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function exportPdf() {
    if (!report) return;
    const win = window.open("", "_blank", "width=900,height=1200");
    if (!win) return;

    const categoryRows = report.categories
      .map(
        (c) => `
          <tr>
            <td>${escapeHtml(c.label)}</td>
            <td>${escapeHtml(fmtMin(c.minutes))}</td>
            <td>${escapeHtml(fmtMin(c.prevMinutes))}</td>
            <td>${escapeHtml(fmtSignedMin(c.deltaMinutes))}</td>
            <td>${c.memoCount}개</td>
          </tr>
        `
      )
      .join("");

    const memoRows =
      report.memos.length === 0
        ? `<div class="muted">메모가 없습니다.</div>`
        : report.memos
            .slice(0, 50)
            .map(
              (m) => `
              <div class="memo">
                <div class="meta">${escapeHtml(m.day)} · ${escapeHtml(m.categoryLabel)}</div>
                <div>${escapeHtml(m.text)}</div>
              </div>
            `
            )
            .join("");

    const feedbackText = feedback
      ? `<pre>${escapeHtml(feedback)}</pre>`
      : `<div class="muted">피드백이 아직 생성되지 않았습니다.</div>`;

    const html = `
      <!doctype html>
      <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>주간 리포트 ${report.weekStart}~${report.weekEnd}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #111; }
          h1 { margin: 0 0 6px 0; font-size: 24px; }
          h2 { margin: 20px 0 8px 0; font-size: 16px; }
          .muted { color: #666; font-size: 13px; }
          .summary { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 8px; margin-top: 12px; }
          .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
          th, td { border-bottom: 1px solid #eee; padding: 8px 6px; text-align: left; }
          .memo { border: 1px solid #eee; border-radius: 8px; padding: 8px; margin-top: 8px; }
          .meta { font-size: 12px; color: #666; margin-bottom: 4px; }
          pre { white-space: pre-wrap; line-height: 1.5; font-size: 13px; border: 1px solid #ddd; border-radius: 8px; padding: 10px; background: #fafafa; }
          @page { size: A4; margin: 14mm; }
        </style>
      </head>
      <body>
        <h1>주간 리포트</h1>
        <div class="muted">기간: ${report.weekStart} ~ ${report.weekEnd}</div>
        <div class="summary">
          <div class="card"><div class="muted">총 공부시간</div><div><b>${escapeHtml(fmtMin(report.totalMinutes))}</b></div></div>
          <div class="card"><div class="muted">전주 대비</div><div><b>${escapeHtml(fmtSignedMin(report.deltaTotalMinutes))}</b></div></div>
          <div class="card"><div class="muted">메모 수</div><div><b>${report.memos.length}개</b></div></div>
        </div>

        <h2>과목별 동향</h2>
        <table>
          <thead>
            <tr><th>과목</th><th>이번 주</th><th>지난 주</th><th>증감</th><th>메모</th></tr>
          </thead>
          <tbody>${categoryRows}</tbody>
        </table>

        <h2>AI 피드백</h2>
        ${feedbackText}

        <h2>메모 요약</h2>
        ${memoRows}
      </body>
      </html>
    `;

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => {
      win.print();
    }, 250);
  }

  if (loading) {
    return (
      <div style={{ maxWidth: 960, margin: "40px auto", padding: 20, color: theme.text, background: theme.bg }}>
        로딩 중...
      </div>
    );
  }

  if (error || !report) {
    return (
      <div style={{ maxWidth: 960, margin: "40px auto", padding: 20, color: theme.text, background: theme.bg }}>
        <div>{error ?? "데이터가 없습니다."}</div>
        <button onClick={() => router.push("/day")} style={{ marginTop: 12 }}>
          day로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 960,
        margin: "24px auto",
        padding: isNarrow ? 12 : 16,
        boxSizing: "border-box",
        display: "grid",
        gap: 16,
        color: theme.text,
        background: theme.bg,
        overflowX: "hidden",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>주간 리포트</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", width: isNarrow ? "100%" : "auto" }}>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            style={{ padding: "6px 8px", background: theme.controlBg, color: theme.controlText, border: `1px solid ${theme.border}`, borderRadius: 8 }}
          />
          <button onClick={() => router.push("/day")} style={{ padding: "6px 10px", background: theme.controlBg, color: theme.controlText, border: `1px solid ${theme.border}`, borderRadius: 8 }}>
            day 페이지
          </button>
          <button onClick={exportPdf} style={{ padding: "6px 10px", background: theme.controlBg, color: theme.controlText, border: `1px solid ${theme.border}`, borderRadius: 8 }}>
            PDF 저장
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: theme.muted }}>
        기간: {report.weekStart} ~ {report.weekEnd}
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.card }}>
        <div style={{ fontSize: 12, color: theme.muted, marginBottom: 8 }}>총 공부시간 포함 항목 선택</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {report.categories.map((c) => {
            const included = includedCategoryIds[c.categoryId] !== false;
            return (
              <button
                key={`include-${c.categoryId}`}
                onClick={() =>
                  setIncludedCategoryOverrides((prev) => ({
                    ...prev,
                    [c.categoryId]: !(prev[c.categoryId] !== false),
                  }))
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: `1px solid ${theme.border}`,
                  background: included ? theme.accentSoft : theme.controlBg,
                  color: theme.controlText,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 999, background: c.color }} />
                {included ? "✓ " : ""}{c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.card }}>
          <div style={{ fontSize: 12, color: theme.muted }}>총 공부시간</div>
          <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>{fmtMin(filteredTotalMinutes)}</div>
        </div>
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.card }}>
          <div style={{ fontSize: 12, color: theme.muted }}>과목 비율(최대)</div>
          <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>
            {summaryTopCategory
              ? `${summaryTopCategory.label} ${fmtPct(summaryTopCategory.ratio)}`
              : "-"}
          </div>
          {summaryTopCategory && (
            <div style={{ marginTop: 2, fontSize: 12, color: theme.muted }}>
              {fmtMin(summaryTopCategory.minutes)}
            </div>
          )}
        </div>
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.card }}>
          <div style={{ fontSize: 12, color: theme.muted }}>지난주 대비 증감</div>
          <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>{fmtSignedMin(filteredDeltaTotalMinutes)}</div>
        </div>
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.card }}>
          <div style={{ fontSize: 12, color: theme.muted }}>가장 흔들린 요일(최저)</div>
          <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>
            {weakestDay ? `${fmtDay(weakestDay.day)} · ${fmtMin(weakestDay.minutes)}` : "-"}
          </div>
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, background: theme.card }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>일자별 총 공부시간 동향</div>
        <div style={{ display: "grid", gap: 8 }}>
          {filteredDailyTotals.map((d) => (
            <div key={d.day} style={{ display: "grid", gridTemplateColumns: "64px 1fr 80px", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, color: theme.muted }}>{fmtDay(d.day)}</div>
              <div style={{ height: 10, borderRadius: 999, background: "#f3f4f6", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${(d.minutes / filteredMaxDaily) * 100}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, #06b6d4, #22c55e)",
                  }}
                />
              </div>
              <div style={{ fontSize: 12, textAlign: "right" }}>{fmtMin(d.minutes)}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, background: theme.card }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>과목별 동향</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isNarrow ? 520 : 560 }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, color: theme.muted }}>
                <th style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.border}` }}>과목</th>
                <th style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.border}` }}>이번 주</th>
                <th style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.border}` }}>지난 주</th>
                <th style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.border}` }}>증감</th>
                <th style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.border}` }}>메모</th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.categoryId}>
                  <td style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.borderSoft}` }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: c.color }} />
                      {c.label}
                    </span>
                  </td>
                  <td style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.borderSoft}` }}>{fmtMin(c.minutes)}</td>
                  <td style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.borderSoft}` }}>{fmtMin(c.prevMinutes)}</td>
                  <td style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.borderSoft}`, color: c.deltaMinutes >= 0 ? "#16a34a" : "#ef4444" }}>
                    {fmtSignedMin(c.deltaMinutes)}
                  </td>
                  <td style={{ padding: "8px 6px", borderBottom: `1px solid ${theme.borderSoft}` }}>{c.memoCount}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, background: theme.card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>AI 피드백</div>
          <button onClick={generateFeedback} disabled={loadingFeedback} style={{ padding: "6px 10px", background: theme.controlBg, color: theme.controlText, border: `1px solid ${theme.border}`, borderRadius: 8 }}>
            {loadingFeedback ? "생성 중..." : "피드백 생성"}
          </button>
        </div>
        {feedback ? (
          <div style={{ marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 }}>
            {feedback}
            <div style={{ marginTop: 8, fontSize: 12, color: theme.muted }}>
              생성 방식: {feedbackSource === "ai" ? "AI" : "기본 분석"}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 13, color: theme.muted }}>
            메모와 시간 기록을 종합한 주간 피드백을 생성할 수 있습니다.
          </div>
        )}
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, background: theme.card }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>이번 주 메모 요약</div>
        {report.memos.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.muted }}>메모가 없습니다.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {report.memos.slice(0, 30).map((m, idx) => (
              <div key={`${m.day}-${m.categoryId}-${idx}`} style={{ border: `1px solid ${theme.borderSoft}`, borderRadius: 8, padding: 8 }}>
                <div style={{ fontSize: 12, color: theme.muted }}>
                  {m.day} · {m.categoryLabel}
                </div>
                <div style={{ marginTop: 4, fontSize: 14 }}>{m.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
