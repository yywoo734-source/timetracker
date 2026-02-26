"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type PlanItem = { id: string; text: string; done: boolean };
type ViewMode = "week" | "month";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function formatIso(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function parseIso(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function addDays(day: string, diff: number) {
  const d = parseIso(day);
  d.setDate(d.getDate() + diff);
  return formatIso(d);
}
function mondayStart(day: string) {
  const d = parseIso(day);
  const w = d.getDay();
  const diff = w === 0 ? -6 : 1 - w;
  d.setDate(d.getDate() + diff);
  return formatIso(d);
}
function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `id_${Math.random().toString(16).slice(2)}`;
}
function isoDayKey03(date = new Date()) {
  const d = new Date(date);
  d.setHours(d.getHours() - 3);
  return formatIso(d);
}
function monthStart(day: string) {
  const d = parseIso(day);
  return formatIso(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthEnd(day: string) {
  const d = parseIso(day);
  return formatIso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export default function PlanningPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [anchorDay, setAnchorDay] = useState(isoDayKey03());
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [selectedDay, setSelectedDay] = useState(isoDayKey03());
  const [planningByDay, setPlanningByDay] = useState<Record<string, PlanItem[]>>({});
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? null;
      if (!token) {
        router.replace("/login");
        return;
      }
      if (!cancelled) setAccessToken(token);
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const range = useMemo(() => {
    if (viewMode === "week") {
      const from = mondayStart(anchorDay);
      const to = addDays(from, 6);
      return { from, to };
    }
    return { from: monthStart(anchorDay), to: monthEnd(anchorDay) };
  }, [anchorDay, viewMode]);

  const visibleDays = useMemo(() => {
    const days: string[] = [];
    let cur = range.from;
    while (cur <= range.to) {
      days.push(cur);
      cur = addDays(cur, 1);
    }
    return days;
  }, [range]);

  const effectiveSelectedDay = useMemo(
    () => (visibleDays.includes(selectedDay) ? selectedDay : (visibleDays[0] ?? anchorDay)),
    [visibleDays, selectedDay, anchorDay]
  );

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    async function load() {
      const res = await fetch(`/api/planning?from=${range.from}&to=${range.to}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { planningByDay?: Record<string, PlanItem[]> };
      if (!cancelled && body.planningByDay) {
        setPlanningByDay((prev) => ({ ...prev, ...body.planningByDay }));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, range]);

  async function saveDay(day: string, items: PlanItem[]) {
    if (!accessToken) return;
    await fetch("/api/planning", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ day, items }),
    });
  }

  const selectedItems = planningByDay[effectiveSelectedDay] ?? [];
  const doneCount = selectedItems.filter((x) => x.done).length;

  return (
    <div style={{ maxWidth: 1100, margin: "20px auto", padding: 16, display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0 }}>플래닝 캘린더</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => router.push("/day")}>타임트래커</button>
          <button onClick={() => router.push("/weekly")}>주간 리포트</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? -7 : -30))}>이전</button>
        <button onClick={() => setAnchorDay(isoDayKey03())}>오늘로</button>
        <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? 7 : 30))}>다음</button>
        <div style={{ marginLeft: 8, fontWeight: 700 }}>{range.from} ~ {range.to}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setViewMode("week")} style={{ fontWeight: viewMode === "week" ? 800 : 400 }}>주별</button>
          <button onClick={() => setViewMode("month")} style={{ fontWeight: viewMode === "month" ? 800 : 400 }}>월별</button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: viewMode === "week" ? "repeat(7,minmax(0,1fr))" : "repeat(7,minmax(0,1fr))",
          gap: 8,
        }}
      >
        {visibleDays.map((day) => {
          const items = planningByDay[day] ?? [];
          const done = items.filter((x) => x.done).length;
          const selected = day === effectiveSelectedDay;
          return (
            <button
              key={day}
              onClick={() => setSelectedDay(day)}
              style={{
                textAlign: "left",
                border: selected ? "2px solid #2563eb" : "1px solid #e5e7eb",
                borderRadius: 10,
                padding: 10,
                background: "#fff",
                cursor: "pointer",
                minHeight: 74,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 12 }}>{day.slice(5)}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>{done}/{items.length} 완료</div>
            </button>
          );
        })}
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 800 }}>{effectiveSelectedDay} 계획</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{doneCount}/{selectedItems.length} 완료</div>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="할 일을 입력해줘"
            style={{ flex: 1, padding: "8px 10px" }}
          />
          <button
            onClick={() => {
              const text = draft.trim();
              if (!text) return;
              const next = [...selectedItems, { id: uuid(), text: text.slice(0, 120), done: false }];
              setPlanningByDay((prev) => ({ ...prev, [effectiveSelectedDay]: next }));
              setDraft("");
              void saveDay(effectiveSelectedDay, next);
            }}
          >
            추가
          </button>
        </div>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {selectedItems.length === 0 && (
            <div style={{ fontSize: 12, color: "#6b7280" }}>등록된 계획이 없어.</div>
          )}
          {selectedItems.map((item) => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #f1f1f1", borderRadius: 8, padding: 8 }}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={(e) => {
                  const next = selectedItems.map((x) =>
                    x.id === item.id ? { ...x, done: e.target.checked } : x
                  );
                  setPlanningByDay((prev) => ({ ...prev, [effectiveSelectedDay]: next }));
                  void saveDay(effectiveSelectedDay, next);
                }}
              />
              <div style={{ flex: 1, textDecoration: item.done ? "line-through" : "none", opacity: item.done ? 0.65 : 1 }}>
                {item.text}
              </div>
              <button
                onClick={() => {
                  const next = selectedItems.filter((x) => x.id !== item.id);
                  setPlanningByDay((prev) => ({ ...prev, [effectiveSelectedDay]: next }));
                  void saveDay(effectiveSelectedDay, next);
                }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
