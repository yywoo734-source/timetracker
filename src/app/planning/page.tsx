"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type ViewMode = "week" | "month";
type PlanKind = "DEEP_WORK" | "RESEARCH" | "WRITING" | "BREAK";
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

const KIND_META: Record<PlanKind, { label: string; color: string }> = {
  DEEP_WORK: { label: "DEEP WORK", color: "#3b82f6" },
  RESEARCH: { label: "RESEARCH", color: "#38bdf8" },
  WRITING: { label: "WRITING", color: "#2dd4bf" },
  BREAK: { label: "BREAK", color: "#f59e0b" },
};

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
function fmtClock(min: number) {
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}
function fmtHMS(totalSec: number) {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

export default function PlanningPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [anchorDay, setAnchorDay] = useState(isoDayKey03());
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [selectedDay, setSelectedDay] = useState(isoDayKey03());
  const [planningByDay, setPlanningByDay] = useState<Record<string, PlanItem[]>>({});
  const [syncing, setSyncing] = useState(false);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftKind, setDraftKind] = useState<PlanKind>("DEEP_WORK");
  const [draftStart, setDraftStart] = useState("08:00");
  const [draftDur, setDraftDur] = useState(120);
  const [draftIntensity, setDraftIntensity] = useState(80);

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

  const range = useMemo(() => {
    if (viewMode === "week") {
      const from = mondayStart(anchorDay);
      return { from, to: addDays(from, 6) };
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

  const selectedItems = useMemo(
    () => (planningByDay[effectiveSelectedDay] ?? []).slice().sort((a, b) => (a.startMin ?? 8 * 60) - (b.startMin ?? 8 * 60)),
    [planningByDay, effectiveSelectedDay]
  );
  const totalPlannedMin = selectedItems.reduce((acc, x) => acc + (x.durMin ?? 60), 0);

  const kindCards = useMemo(() => {
    const init: Record<PlanKind, number> = { DEEP_WORK: 0, RESEARCH: 0, WRITING: 0, BREAK: 0 };
    for (const item of selectedItems) {
      const kind = (item.kind as PlanKind) || "DEEP_WORK";
      if (init[kind] !== undefined) init[kind] += item.durMin ?? 60;
    }
    return (Object.keys(KIND_META) as PlanKind[]).map((k) => ({ kind: k, seconds: init[k] * 60 }));
  }, [selectedItems]);

  const hourStart = 8;
  const hourEnd = 20;
  const totalHours = hourEnd - hourStart;

  const goals = useMemo(() => {
    const kinds = ["DEEP_WORK", "RESEARCH", "WRITING"] as const;
    return kinds.map((k) => {
      const list = selectedItems.filter((x) => (x.kind as PlanKind) === k);
      const done = list.filter((x) => x.done).length;
      const pct = list.length ? Math.round((done / list.length) * 100) : 0;
      return { label: KIND_META[k].label, pct, color: KIND_META[k].color };
    });
  }, [selectedItems]);

  function addSession() {
    const text = draftTitle.trim();
    if (!text) return;
    const [hh, mm] = draftStart.split(":").map(Number);
    const startMin = Math.max(0, Math.min(1439, (hh || 0) * 60 + (mm || 0)));
    const next: PlanItem[] = [
      ...selectedItems,
      {
        id: uuid(),
        text: text.slice(0, 120),
        done: false,
        kind: draftKind,
        startMin,
        durMin: Math.max(5, Math.min(12 * 60, draftDur)),
        intensity: Math.max(0, Math.min(100, draftIntensity)),
        color: KIND_META[draftKind].color,
      },
    ];
    setPlanningByDay((prev) => ({ ...prev, [effectiveSelectedDay]: next }));
    setDraftTitle("");
    void saveDay(effectiveSelectedDay, next);
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "radial-gradient(1200px 600px at 30% -10%, #0f2a56 0%, #07152e 45%, #060f22 100%)",
        color: "#d6e2ff",
        padding: 20,
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1440, margin: "0 auto", display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ color: "#3b82f6", fontWeight: 800, fontSize: 30 }}>›_</div>
            <div style={{ fontWeight: 800, fontSize: 28, letterSpacing: ".02em" }}>ACADEMIC.OS</div>
            <div style={{ color: "#89a4d5" }}>{effectiveSelectedDay}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 12, letterSpacing: ".14em", color: "#8ea6d3" }}>DAILY TOTAL TIME</div>
            <div style={{ fontWeight: 900, fontSize: 52, lineHeight: 1 }}>{fmtHMS(totalPlannedMin * 60)}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ color: syncing ? "#60a5fa" : "#8ea6d3", fontSize: 13 }}>
              {syncing ? "Syncing..." : "Synced"}
            </div>
            <button onClick={() => router.push("/day")}>TimeTracker</button>
            <button onClick={() => router.push("/weekly")}>Weekly</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? -7 : -30))}>◀</button>
          <button onClick={() => setAnchorDay(isoDayKey03())}>Today</button>
          <button onClick={() => setAnchorDay(addDays(anchorDay, viewMode === "week" ? 7 : 30))}>▶</button>
          <div style={{ color: "#8ea6d3" }}>{range.from} ~ {range.to}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => setViewMode("week")} style={{ fontWeight: viewMode === "week" ? 800 : 500 }}>Week</button>
            <button onClick={() => setViewMode("month")} style={{ fontWeight: viewMode === "month" ? 800 : 500 }}>Month</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: 8 }}>
          {visibleDays.map((day) => {
            const items = planningByDay[day] ?? [];
            const selected = day === effectiveSelectedDay;
            return (
              <button
                key={day}
                onClick={() => setSelectedDay(day)}
                style={{
                  border: selected ? "1px solid #3b82f6" : "1px solid rgba(148,163,184,.25)",
                  background: selected ? "rgba(37,99,235,.2)" : "rgba(15,23,42,.55)",
                  borderRadius: 10,
                  color: "#c9d7f8",
                  padding: "8px 9px",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 12 }}>{day.slice(5)}</div>
                <div style={{ opacity: 0.8, fontSize: 11 }}>{items.length} sessions</div>
              </button>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 18 }}>
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12 }}>
              {kindCards.map((card) => (
                <div
                  key={card.kind}
                  style={{
                    border: "1px solid rgba(148,163,184,.22)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, rgba(24,37,68,.72), rgba(12,23,44,.72))",
                  }}
                >
                  <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#8ea6d3" }}>
                    {KIND_META[card.kind].label}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 42, fontWeight: 800, lineHeight: 1 }}>
                    {fmtHMS(card.seconds)}
                  </div>
                </div>
              ))}
            </div>

            <div
              style={{
                border: "1px solid rgba(148,163,184,.22)",
                borderRadius: 18,
                overflow: "hidden",
                background: "linear-gradient(180deg, rgba(17,30,57,.76), rgba(8,18,36,.78))",
              }}
            >
              <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(148,163,184,.2)", fontWeight: 700 }}>
                Daily Timeline
              </div>
              <div style={{ position: "relative", minHeight: 840 }}>
                {Array.from({ length: totalHours + 1 }).map((_, i) => {
                  const top = (i / totalHours) * 100;
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: `${top}%`,
                        borderTop: "1px solid rgba(148,163,184,.1)",
                      }}
                    >
                      <div style={{ position: "absolute", left: 10, top: -10, fontSize: 12, color: "#6f86b2" }}>
                        {pad2(hourStart + i)}:00
                      </div>
                    </div>
                  );
                })}

                <div style={{ position: "absolute", inset: 0, padding: "0 16px 12px 78px" }}>
                  {selectedItems.map((item) => {
                    const start = item.startMin ?? 8 * 60;
                    const dur = item.durMin ?? 60;
                    const end = start + dur;
                    const top = ((start - hourStart * 60) / (totalHours * 60)) * 100;
                    const height = (dur / (totalHours * 60)) * 100;
                    if (end < hourStart * 60 || start > hourEnd * 60) return null;
                    const color = item.color ?? KIND_META[(item.kind as PlanKind) || "DEEP_WORK"].color;
                    return (
                      <div
                        key={item.id}
                        style={{
                          position: "absolute",
                          left: 8,
                          right: 8,
                          top: `${Math.max(0, top)}%`,
                          height: `${Math.max(6, height)}%`,
                          borderRadius: 12,
                          borderLeft: `4px solid ${color}`,
                          background: `linear-gradient(90deg, ${color}28, rgba(30,41,59,.48))`,
                          padding: "10px 12px",
                          boxSizing: "border-box",
                          overflow: "hidden",
                        }}
                      >
                        <div style={{ fontWeight: 700, color }}>{item.text}</div>
                        <div style={{ marginTop: 4, fontSize: 12, color: "#9fb3da" }}>
                          {fmtClock(start)} - {fmtClock(start + dur)} • {item.intensity ?? 80}% Intensity
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              borderLeft: "1px solid rgba(148,163,184,.22)",
              paddingLeft: 18,
              display: "grid",
              alignContent: "start",
              gap: 20,
            }}
          >
            <div style={{ letterSpacing: ".16em", color: "#8ea6d3", fontSize: 12 }}>PROJECT GOALS</div>
            {goals.map((goal) => (
              <div key={goal.label} style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                  <span>{goal.label}</span>
                  <span style={{ color: goal.color }}>{goal.pct}%</span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: "rgba(148,163,184,.25)", overflow: "hidden" }}>
                  <div style={{ width: `${goal.pct}%`, height: "100%", background: goal.color }} />
                </div>
              </div>
            ))}

            <div
              style={{
                border: "1px solid rgba(239,68,68,.35)",
                borderRadius: 14,
                padding: 14,
                color: "#fecaca",
                background: "rgba(127,29,29,.12)",
              }}
            >
              <div style={{ fontWeight: 800, letterSpacing: ".06em" }}>EFFICIENCY ALERT</div>
              <div style={{ marginTop: 8, fontSize: 14, color: "#fca5a5" }}>
                최근 세션 중 완료율이 낮은 구간이 있어. 다음 세션은 60~90분으로 쪼개서 실행해봐.
              </div>
            </div>

            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Session title" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <select value={draftKind} onChange={(e) => setDraftKind(e.target.value as PlanKind)}>
                  {(Object.keys(KIND_META) as PlanKind[]).map((k) => (
                    <option key={k} value={k}>{KIND_META[k].label}</option>
                  ))}
                </select>
                <input type="time" value={draftStart} onChange={(e) => setDraftStart(e.target.value)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input type="number" min={5} max={360} value={draftDur} onChange={(e) => setDraftDur(Number(e.target.value) || 60)} placeholder="Duration min" />
                <input type="number" min={0} max={100} value={draftIntensity} onChange={(e) => setDraftIntensity(Number(e.target.value) || 80)} placeholder="Intensity %" />
              </div>
              <button
                onClick={addSession}
                style={{
                  marginTop: 6,
                  height: 46,
                  borderRadius: 14,
                  border: "1px solid rgba(59,130,246,.65)",
                  background: "linear-gradient(180deg,#2563eb,#1d4ed8)",
                  color: "white",
                  fontWeight: 700,
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                + New Session
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
