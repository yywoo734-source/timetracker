"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type User = {
  id: string;
  email: string;
  name?: string | null;
  role: "STUDENT" | "ADMIN" | "SUPER_ADMIN";
  status: "PENDING" | "APPROVED" | "REJECTED";
};

type WeekCategory = {
  categoryId: string;
  label: string;
  color: string;
  minutes: number;
  prevMinutes: number;
  deltaMinutes: number;
  memoCount: number;
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
  memos: WeeklyMemo[];
};

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

export default function AdminWeeklyPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [studentId, setStudentId] = useState("");
  const [day, setDay] = useState(isoDayKey03());
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [feedback, setFeedback] = useState("");
  const [feedbackSource, setFeedbackSource] = useState<"ai" | "fallback" | null>(null);
  const [loadingFeedback, setLoadingFeedback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        router.replace("/login");
        return;
      }
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token ?? null;
      if (!token) {
        router.replace("/login");
        return;
      }

      const meRes = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
      if (!meRes.ok) {
        router.replace("/login");
        return;
      }
      const meBody = await meRes.json();
      const me = meBody.user as User | undefined;
      if (!me || me.role !== "SUPER_ADMIN" || (me.email ?? "").toLowerCase() !== "yywoo7@naver.com") {
        if (!cancelled) {
          setError("권한 없음: 최종 관리자만 접근 가능합니다.");
          setLoading(false);
        }
        return;
      }

      const studentsRes = await fetch("/api/admin/students", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!studentsRes.ok) {
        if (!cancelled) {
          setError("학생 목록을 불러오지 못했습니다.");
          setLoading(false);
        }
        return;
      }
      const studentsBody = await studentsRes.json();
      const list = (studentsBody.students ?? []) as User[];

      if (!cancelled) {
        setAccessToken(token);
        setStudents(list);
        setStudentId(list[0]?.id ?? "");
        setLoading(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    if (!accessToken || !studentId) return;
    let cancelled = false;
    async function load() {
      setError(null);
      const res = await fetch(`/api/admin/reports/weekly?studentId=${studentId}&day=${day}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        if (!cancelled) {
          setError("주간 리포트를 불러오지 못했습니다.");
          setReport(null);
        }
        return;
      }
      const body = await res.json();
      if (!cancelled) {
        setReport((body.report ?? null) as WeeklyReport | null);
        setFeedback("");
        setFeedbackSource(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, studentId, day]);

  async function generateFeedback() {
    if (!accessToken || !studentId || !report) return;
    setLoadingFeedback(true);
    const res = await fetch("/api/admin/reports/weekly-feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ studentId, day: report.day }),
    });
    if (!res.ok) {
      setLoadingFeedback(false);
      setFeedback("피드백 생성 실패");
      setFeedbackSource(null);
      return;
    }
    const body = await res.json();
    setFeedback(String(body.feedback ?? ""));
    setFeedbackSource((body.source ?? null) as "ai" | "fallback" | null);
    setLoadingFeedback(false);
  }

  if (loading) return <div style={{ padding: 24 }}>로딩 중...</div>;

  if (error && !report) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ color: "#b91c1c" }}>{error}</div>
        <button style={{ marginTop: 12 }} onClick={() => router.push("/day")}>
          day로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "24px auto", padding: 16, display: "grid", gap: 12 }}>
      <h1 style={{ margin: 0 }}>학생 주간 리포트 (관리자)</h1>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={studentId} onChange={(e) => setStudentId(e.target.value)} style={{ padding: "6px 8px" }}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.email}
            </option>
          ))}
        </select>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ padding: "6px 8px" }} />
        <button onClick={() => router.push("/day")} style={{ padding: "6px 10px" }}>
          day 페이지
        </button>
      </div>
      {error && <div style={{ color: "#b91c1c" }}>{error}</div>}

      {report && (
        <>
          <div style={{ fontSize: 13, color: "#666" }}>
            기간: {report.weekStart} ~ {report.weekEnd}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>총 공부시간</div>
              <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>{fmtMin(report.totalMinutes)}</div>
            </div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>전주 대비</div>
              <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>{fmtSignedMin(report.deltaTotalMinutes)}</div>
            </div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>메모 수</div>
              <div style={{ marginTop: 4, fontSize: 20, fontWeight: 800 }}>{report.memos.length}개</div>
            </div>
          </div>

          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>과목별 동향</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead>
                  <tr style={{ textAlign: "left", fontSize: 12, color: "#666" }}>
                    <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>과목</th>
                    <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>이번 주</th>
                    <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>지난 주</th>
                    <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>증감</th>
                    <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>메모</th>
                  </tr>
                </thead>
                <tbody>
                  {report.categories.map((c) => (
                    <tr key={c.categoryId}>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid #f5f5f5" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 999, background: c.color }} />
                          {c.label}
                        </span>
                      </td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid #f5f5f5" }}>{fmtMin(c.minutes)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid #f5f5f5" }}>{fmtMin(c.prevMinutes)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid #f5f5f5", color: c.deltaMinutes >= 0 ? "#065f46" : "#991b1b" }}>
                        {fmtSignedMin(c.deltaMinutes)}
                      </td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid #f5f5f5" }}>{c.memoCount}개</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 700 }}>AI 피드백</div>
              <button onClick={generateFeedback} disabled={loadingFeedback} style={{ padding: "6px 10px" }}>
                {loadingFeedback ? "생성 중..." : "피드백 생성"}
              </button>
            </div>
            {feedback ? (
              <div style={{ marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 }}>
                {feedback}
                <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>
                  생성 방식: {feedbackSource === "ai" ? "AI" : "기본 분석"}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 13, color: "#666" }}>이 학생의 주간 피드백을 생성할 수 있습니다.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
