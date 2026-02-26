"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type ViewMode = "week" | "month";
type Category = { id: string; label: string; color: string };
type PlanItem = {
  id: string;
  text: string;
  done: boolean;
  kind?: string;
  startMin?: number;
  durMin?: number;
  intensity?: number;
  color?: string;
};

const CATEGORIES_KEY = "timetracker_categories_v1";
const HEADER_H = 42;
const HOUR_H = 58;
const SNAP_MIN = 15;

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
function monthStart(day: string) {
  const d = parseIso(day);
  return formatIso(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthEnd(day: string) {
  const d = parseIso(day);
  return formatIso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
function isoDayKey03(date = new Date()) {
  const d = new Date(date);
  d.setHours(d.getHours() - 3);
  return formatIso(d);
}
function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `id_${Math.random().toString(16).slice(2)}`;
}
function fmtClock(min: number) {
  const safe = Math.max(0, Math.min(1439, Math.floor(min)));
  return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`;
}
function loadLocalCategories(): Category[] {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Category[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c?.id && c?.label && c?.color);
  } catch {
    return [];
  }
}

export default function PlanningPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [anchorDay, setAnchorDay] = useState(isoDayKey03());
  const [selectedDay, setSelectedDay] = useState(isoDayKey03());
  const [planningByDay, setPlanningByDay] = useState<Record<string, PlanItem[]>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const [dragPreview, setDragPreview] = useState<{ day: string; startMin: number; endMin: number } | null>(null);
  const dragStateRef = useRef<{ day: string; startMin: number } | null>(null);
  const laneRefs = useRef<Record<string, HTMLDivElement | null>>({});

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
    void init();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    const local = loadLocalCategories();
    if (local.length > 0) {
      setCategories(local);
      setActiveCategoryId((prev) => prev || local[0].id);
    }
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    async function loadCategories() {
      const res = await fetch("/api/categories", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return;
      const body = (await res.json()) as { categories?: Category[] };
      if (!cancelled && Array.isArray(body.categories) && body.categories.length > 0) {
        setCategories(body.categories);
        setActiveCategoryId((prev) => prev || body.categories?.[0]?.id || "");
      }
    }
    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const range = useMemo(() => {
    if (viewMode === "week") {
      const from = mondayStart(anchorDay);
      return { from, to: addDays(from, 6) };
    }
    return { from: monthStart(anchorDay), to: monthEnd(anchorDay) };
  }, [anchorDay, viewMode]);

  const visibleDays = useMemo(() => {
    if (viewMode === "week") {
      return Array.from({ length: 7 }).map((_, i) => addDays(range.from, i));
    }
    const days: string[] = [];
    let cur = range.from;
    while (cur <= range.to) {
      days.push(cur);
      cur = addDays(cur, 1);
    }
    return days;
  }, [range, viewMode]);

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
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, range]);

  async function saveDay(day: string, items: PlanItem[]) {
    if (!accessToken) return;
    setSyncing(true);
    try {
      await fetch("/api/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ day, items }),
      });
    } finally {
      setSyncing(false);
    }
  }

  const activeCategory = categories.find((c) => c.id === activeCategoryId) ?? null;

  function pxToMinute(day: string, clientY: number) {
    const lane = laneRefs.current[day];
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
    const min = Math.round(((y / rect.height) * 1440) / SNAP_MIN) * SNAP_MIN;
    return Math.max(0, Math.min(1435, min));
  }

  function onPointerDown(day: string, e: React.PointerEvent<HTMLDivElement>) {
    if (!activeCategory) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
    const min = pxToMinute(day, e.clientY);
    dragStateRef.current = { day, startMin: min };
    setDragPreview({ day, startMin: min, endMin: Math.min(1439, min + SNAP_MIN) });
  }

  function onPointerMove(day: string, e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.day !== day) return;
    const cur = pxToMinute(day, e.clientY);
    const start = Math.min(drag.startMin, cur);
    const end = Math.max(drag.startMin + SNAP_MIN, cur + SNAP_MIN);
    setDragPreview({ day, startMin: start, endMin: Math.min(1440, end) });
  }

  function onPointerUp(day: string) {
    const drag = dragStateRef.current;
    if (!drag || !activeCategory || !dragPreview || dragPreview.day !== day) {
      dragStateRef.current = null;
      setDragPreview(null);
      return;
    }
    const start = Math.max(0, Math.min(1435, dragPreview.startMin));
    const end = Math.max(start + SNAP_MIN, Math.min(1440, dragPreview.endMin));
    const dur = end - start;

    const title = draftTitle.trim() || activeCategory.label;
    const next = [
      ...(planningByDay[day] ?? []),
      {
        id: uuid(),
        text: title,
        done: false,
        kind: activeCategory.label,
        startMin: start,
        durMin: dur,
        color: activeCategory.color,
        intensity: 80,
      } satisfies PlanItem,
    ];
    setPlanningByDay((prev) => ({ ...prev, [day]: next }));
    void saveDay(day, next);

    dragStateRef.current = null;
    setDragPreview(null);
  }

  const monthTitle = useMemo(() => {
    const d = parseIso(anchorDay);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  }, [anchorDay]);

  return (
    <div style={{ minHeight: "100dvh", background: "#f6f7fb", color: "#1f2937", padding: 16 }}>
      <div style={{ maxWidth: 1560, margin: "0 auto", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 36 }}>{monthTitle}</h1>
          <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? -7 : -30))}>◀</button>
          <button onClick={() => setAnchorDay(isoDayKey03())}>오늘</button>
          <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? 7 : 30))}>▶</button>
          <button onClick={() => setViewMode("week")} style={{ fontWeight: viewMode === "week" ? 800 : 500 }}>주</button>
          <button onClick={() => setViewMode("month")} style={{ fontWeight: viewMode === "month" ? 800 : 500 }}>월</button>
          <button onClick={() => router.push("/day")}>타임트래커</button>
          <button onClick={() => router.push("/weekly")}>리포트</button>
          <span style={{ marginLeft: "auto", color: syncing ? "#2563eb" : "#6b7280", fontSize: 13 }}>
            {syncing ? "Syncing..." : "Synced"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <strong>드래그 과목</strong>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategoryId(c.id)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: activeCategoryId === c.id ? `2px solid ${c.color}` : "1px solid #d1d5db",
                background: activeCategoryId === c.id ? `${c.color}22` : "#fff",
                color: "#1f2937",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <span style={{ width: 8, height: 8, background: c.color, borderRadius: 999, display: "inline-block", marginRight: 6 }} />
              {c.label}
            </button>
          ))}
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="새 블록 제목(선택)"
            style={{ marginLeft: 8, padding: "6px 10px", minWidth: 220 }}
          />
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: `80px repeat(${visibleDays.length}, minmax(140px, 1fr))`, height: HEADER_H }}>
            <div style={{ borderRight: "1px solid #eceff4" }} />
            {visibleDays.map((day) => {
              const d = parseIso(day);
              const selected = day === effectiveSelectedDay;
              return (
                <button
                  key={day}
                  onClick={() => setSelectedDay(day)}
                  style={{
                    border: "none",
                    borderLeft: "1px solid #eceff4",
                    background: selected ? "#eef2ff" : "#fff",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "8px 10px",
                    fontWeight: selected ? 800 : 600,
                  }}
                >
                  {["일", "월", "화", "수", "목", "금", "토"][d.getDay()]} {d.getDate()}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: `80px repeat(${visibleDays.length}, minmax(140px, 1fr))` }}>
            <div style={{ borderTop: "1px solid #eceff4", background: "#fafbff" }}>
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} style={{ height: HOUR_H, borderBottom: "1px solid #f1f5f9", padding: "2px 8px", fontSize: 12, color: "#6b7280" }}>
                  {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
                </div>
              ))}
            </div>

            {visibleDays.map((day) => {
              const dayItems = (planningByDay[day] ?? []).filter((x) => typeof x.startMin === "number" && typeof x.durMin === "number");
              return (
                <div
                  key={day}
                  ref={(el) => {
                    laneRefs.current[day] = el;
                  }}
                  onPointerDown={(e) => onPointerDown(day, e)}
                  onPointerMove={(e) => onPointerMove(day, e)}
                  onPointerUp={() => onPointerUp(day)}
                  onPointerCancel={() => {
                    dragStateRef.current = null;
                    setDragPreview(null);
                  }}
                  style={{
                    position: "relative",
                    borderTop: "1px solid #eceff4",
                    borderLeft: "1px solid #eceff4",
                    height: HOUR_H * 24,
                    background: "#fff",
                    touchAction: "none",
                  }}
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <div
                      key={h}
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: h * HOUR_H,
                        borderTop: "1px solid #f1f5f9",
                      }}
                    />
                  ))}

                  {dayItems.map((item) => {
                    const start = item.startMin ?? 0;
                    const dur = item.durMin ?? SNAP_MIN;
                    const top = (start / 1440) * (HOUR_H * 24);
                    const height = Math.max(22, (dur / 1440) * (HOUR_H * 24));
                    const color = item.color || (activeCategory?.color ?? "#60a5fa");
                    return (
                      <div
                        key={item.id}
                        style={{
                          position: "absolute",
                          left: 4,
                          right: 4,
                          top,
                          height,
                          borderRadius: 10,
                          borderLeft: `4px solid ${color}`,
                          background: `${color}2a`,
                          padding: "6px 8px",
                          boxSizing: "border-box",
                          overflow: "hidden",
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = (planningByDay[day] ?? []).filter((x) => x.id !== item.id);
                          setPlanningByDay((prev) => ({ ...prev, [day]: next }));
                          void saveDay(day, next);
                        }}
                        title="클릭하면 삭제"
                      >
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#374151" }}>{item.text}</div>
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                          {fmtClock(start)} - {fmtClock(start + dur)}
                        </div>
                      </div>
                    );
                  })}

                  {dragPreview && dragPreview.day === day && activeCategory && (
                    <div
                      style={{
                        position: "absolute",
                        left: 4,
                        right: 4,
                        top: (dragPreview.startMin / 1440) * (HOUR_H * 24),
                        height: Math.max(22, ((dragPreview.endMin - dragPreview.startMin) / 1440) * (HOUR_H * 24)),
                        borderRadius: 10,
                        border: `2px dashed ${activeCategory.color}`,
                        background: `${activeCategory.color}20`,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
