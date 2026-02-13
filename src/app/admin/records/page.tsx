"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

type User = {
  id: string;
  email: string;
  name?: string | null;
  role: "STUDENT" | "ADMIN" | "SUPER_ADMIN";
  status: "PENDING" | "APPROVED" | "REJECTED";
};

type RecordPayload = {
  blocks?: Array<{ id?: string; start: number; dur: number; categoryId: string }>;
  notes?: unknown;
  categories?:
    | Array<{ id: string; label: string; color: string }>
    | { list?: Array<{ id: string; label: string; color: string }>; secondsByCategory?: Record<string, number> };
};

type Override = { categoryId: string; label: string; color?: string | null };
type SlotSeg = { start: number; end: number; color: string };

const COLS = 12;
const ROWS = 24;
const CELL = 20;
const GRID_W = COLS * CELL;
const GRID_H = ROWS * CELL;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function labelFromIndex03(idxMin: number) {
  const START_OFFSET_MIN = 180;
  const roundedSec = Math.max(0, Math.round(idxMin * 60));
  const baseSec = roundedSec + START_OFFSET_MIN * 60;
  const daySec = 24 * 60 * 60;
  const realSec = ((baseSec % daySec) + daySec) % daySec;
  const h = Math.floor(realSec / 3600);
  const m = Math.floor((realSec % 3600) / 60);
  const s = realSec % 60;
  const isNextDay = baseSec >= daySec;
  return `${isNextDay ? "다음날 " : ""}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function labelHourFromIndex03(idxMin: number) {
  const START_OFFSET_MIN = 180;
  const m = Math.floor(idxMin);
  const realMin = (m + START_OFFSET_MIN) % 1440;
  const h = Math.floor(realMin / 60);
  const mm = realMin % 60;
  const isNextDay = m + START_OFFSET_MIN >= 1440;
  return `${isNextDay ? "다음날 " : ""}${pad2(h)}:${pad2(mm)}`;
}

function fmtDur(min: number) {
  const sec = Math.max(0, Math.round(min * 60));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h === 0 && m === 0) return `${s}초`;
  if (h === 0) return `${m}분 ${s}초`;
  return `${h}시간 ${m}분 ${s}초`;
}

function buildSlotGradient(segments: SlotSeg[], baseColor: string) {
  if (segments.length === 0) return "transparent";
  const sorted = [...segments]
    .map((s) => ({ start: Math.max(0, Math.min(5, s.start)), end: Math.max(0, Math.min(5, s.end)), color: s.color }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return "transparent";

  const stops: string[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    const s = (seg.start / 5) * 100;
    const e = (seg.end / 5) * 100;
    if (s > cursor) {
      stops.push(`${baseColor} ${cursor}%`, `${baseColor} ${s}%`);
    }
    stops.push(`${seg.color} ${s}%`, `${seg.color} ${e}%`);
    cursor = e;
  }
  if (cursor < 100) {
    stops.push(`${baseColor} ${cursor}%`, `${baseColor} 100%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export default function AdminRecordsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<User | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [studentId, setStudentId] = useState("");
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [record, setRecord] = useState<RecordPayload | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [savingOverrides, setSavingOverrides] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDayPreview, setShowDayPreview] = useState(false);

  function authHeaders(token: string | undefined) {
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        router.replace("/login");
        return;
      }

      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      const meRes = await fetch("/api/me", { headers: authHeaders(token) });
      if (!meRes.ok) {
        router.replace("/login");
        return;
      }
      const meBody = await meRes.json();
      setMe(meBody.user ?? null);

      const studentsRes = await fetch("/api/admin/students", {
        headers: authHeaders(token),
      });
      if (!studentsRes.ok) {
        setError("학생 목록을 불러오지 못했어요.");
        setLoading(false);
        return;
      }
      const studentsBody = await studentsRes.json();
      if (!cancelled) {
        setStudents(studentsBody.students ?? []);
        setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function loadRecord() {
    setError(null);
    setRecord(null);
    setOverrides({});
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!studentId) return;

    const res = await fetch(`/api/admin/records?studentId=${studentId}&day=${day}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) {
      setError("기록을 불러오지 못했어요.");
      return;
    }
    const body = await res.json();
    setRecord(body.record ?? null);
    setShowDayPreview(true);

    const overridesRes = await fetch(`/api/admin/category-mapping?studentId=${studentId}`, {
      headers: authHeaders(token),
    });
    if (overridesRes.ok) {
      const data = await overridesRes.json();
      const map: Record<string, Override> = {};
      for (const o of data.overrides ?? []) {
        map[o.categoryId] = {
          categoryId: o.categoryId,
          label: o.label,
          color: o.color ?? null,
        };
      }
      setOverrides(map);
    }
  }

  function setOverride(id: string, patch: Partial<Override>) {
    setOverrides((prev) => ({
      ...prev,
      [id]: { categoryId: id, label: prev[id]?.label ?? "", color: prev[id]?.color ?? null, ...patch },
    }));
  }

  async function saveOverrides(categoryIds: string[]) {
    setSavingOverrides(true);
    setError(null);
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    const payload = categoryIds
      .map((id) => overrides[id])
      .filter((o) => o && o.label.trim().length > 0);

    const res = await fetch("/api/admin/category-mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ studentId, overrides: payload }),
    });
    if (!res.ok) {
      setError("카테고리 매핑 저장 실패");
    }
    setSavingOverrides(false);
  }

  if (loading) return <div style={{ padding: 24 }}>로딩 중...</div>;

  if (!me || (me.role !== "ADMIN" && me.role !== "SUPER_ADMIN")) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>권한 없음</h1>
        <p style={{ marginTop: 8, color: "#666" }}>
          관리자만 학생 기록을 볼 수 있어요.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "32px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>학생 기록 보기</h1>
      {error && <div style={{ color: "#c00", marginTop: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
          <option value="">학생 선택</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.email}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <button onClick={loadRecord}>불러오기</button>
      </div>

      <div style={{ marginTop: 24 }}>
        {!record ? (
          <div style={{ color: "#666" }}>선택한 학생/날짜의 기록이 없습니다.</div>
        ) : (
          (() => {
            const blocks = record.blocks ?? [];
            const rawNotes =
              record.notes && typeof record.notes === "object" && !Array.isArray(record.notes)
                ? (record.notes as Record<string, unknown>)
                : {};
            const notesByCategory =
              rawNotes.byCategory && typeof rawNotes.byCategory === "object" && !Array.isArray(rawNotes.byCategory)
                ? (rawNotes.byCategory as Record<string, string>)
                : ((record.notes as Record<string, string>) ?? {});
            const notesByBlock =
              rawNotes.byBlock && typeof rawNotes.byBlock === "object" && !Array.isArray(rawNotes.byBlock)
                ? (rawNotes.byBlock as Record<string, string>)
                : {};
            const totals: Record<string, number> = {};
            for (const b of blocks) totals[b.categoryId] = (totals[b.categoryId] ?? 0) + b.dur;
            const totalMin = Object.values(totals).reduce((a, b) => a + b, 0);
            const categories = Array.isArray(record.categories)
              ? record.categories
              : record.categories?.list ?? [];
            const categoryMap = new Map(categories.map((c) => [c.id, c]));
            const hasCategoryMeta = categories.length > 0;
            const categoryIds = Array.from(
              new Set([
                ...blocks.map((b) => b.categoryId),
                ...Object.keys(notesByCategory ?? {}),
                ...categories.map((c) => c.id),
              ])
            );

            function displayCategory(id: string) {
              const override = overrides[id];
              const c = categoryMap.get(id);
              return {
                label: override?.label || c?.label || id,
                color: override?.color || c?.color || "#e5e7eb",
              };
            }

            return (
              <div style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                  <button
                    onClick={() => setShowDayPreview((v) => !v)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      background: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    {showDayPreview ? "학생 /day 숨기기" : "학생 /day 보기"}
                  </button>
                  <div style={{ fontWeight: 600 }}>총합</div>
                  <div>{fmtDur(totalMin)}</div>
                  {!hasCategoryMeta && (
                    <div style={{ color: "#b45309", fontSize: 12 }}>
                      카테고리 색/이름 정보가 없어요. 학생이 오늘 기록을 한 번 더 저장하면 표시됩니다.
                    </div>
                  )}
                </div>

                {showDayPreview && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>학생 /day 미리보기</div>
                    {(() => {
                      const slotSegments: SlotSeg[][] = Array.from({ length: COLS * ROWS }, () => []);
                      for (const b of blocks) {
                        const c = displayCategory(b.categoryId);
                        const blockStart = b.start;
                        const blockEnd = b.start + b.dur;
                        const slotStart = Math.floor(blockStart / 5);
                        const slotEnd = Math.ceil(blockEnd / 5);
                        for (let i = slotStart; i < slotEnd && i < COLS * ROWS; i++) {
                          const s0 = i * 5;
                          const s1 = s0 + 5;
                          const overlapStart = Math.max(s0, blockStart);
                          const overlapEnd = Math.min(s1, blockEnd);
                          if (overlapEnd > overlapStart) {
                            slotSegments[i].push({
                              start: overlapStart - s0,
                              end: overlapEnd - s0,
                              color: c.color,
                            });
                          }
                        }
                      }

                      return (
                        <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
                          <div style={{ width: 78, fontSize: 11, color: "#666" }}>
                            <div style={{ height: 8 }} />
                            {Array.from({ length: ROWS }).map((_, r) => (
                              <div key={r} style={{ height: CELL, display: "flex", alignItems: "center" }}>
                                {labelHourFromIndex03(r * 60)}
                              </div>
                            ))}
                          </div>
                          <div
                            style={{
                              width: GRID_W,
                              minWidth: GRID_W,
                              height: GRID_H,
                              border: "1px solid #e5e7eb",
                              borderRadius: 10,
                              overflow: "hidden",
                              background: "#fff",
                              display: "grid",
                              gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
                              gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`,
                            }}
                          >
                            {slotSegments.map((segments, i) => {
                              const col = i % COLS;
                              const isHalfHourLine = col === 5;
                              return (
                                <div
                                  key={i}
                                  title={labelFromIndex03(i * 5)}
                                  style={{
                                    width: CELL,
                                    height: CELL,
                                    boxSizing: "border-box",
                                    borderRight: isHalfHourLine ? "2px solid #d1d5db" : "1px solid #f1f5f9",
                                    borderBottom: "1px solid #f1f5f9",
                                    background: buildSlotGradient(segments, "#ffffff"),
                                  }}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>블록 목록</div>
                  {blocks.length === 0 ? (
                    <div style={{ color: "#666" }}>기록 없음</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", fontSize: 13, color: "#555" }}>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>시작</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>끝</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>시간</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>카테고리</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>타임로그 메모</th>
                        </tr>
                      </thead>
                      <tbody>
                        {blocks.map((b) => (
                          <tr key={b.id ?? `${b.categoryId}-${b.start}-${b.dur}`}>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>
                              {labelFromIndex03(b.start)}
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>
                              {labelFromIndex03(b.start + b.dur)}
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>
                              {fmtDur(b.dur)}
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1", fontFamily: "monospace" }}>
                              {(() => {
                                const c = displayCategory(b.categoryId);
                                return (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                    <span
                                      style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: 999,
                                        background: c.color,
                                        border: "1px solid #ddd",
                                      }}
                                    />
                                    {c.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>
                              {(b.id ? notesByBlock[b.id] : "") || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>카테고리 합계</div>
                  {Object.keys(totals).length === 0 ? (
                    <div style={{ color: "#666" }}>합계 없음</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", fontSize: 13, color: "#555" }}>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>카테고리</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>시간</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(totals).map(([id, mins]) => {
                          const c = displayCategory(id);
                          return (
                          <tr key={id}>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1", fontFamily: "monospace" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <span
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 999,
                                    background: c.color,
                                    border: "1px solid #ddd",
                                  }}
                                />
                                {c.label}
                              </span>
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>
                              {fmtDur(mins)}
                            </td>
                          </tr>
                        );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>메모</div>
                  {Object.keys(notesByCategory).length === 0 ? (
                    <div style={{ color: "#666" }}>메모 없음</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", fontSize: 13, color: "#555" }}>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>카테고리</th>
                          <th style={{ padding: "8px 6px", borderBottom: "1px solid #eee" }}>메모</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(notesByCategory).map(([id, note]) => {
                          const c = displayCategory(id);
                          return (
                          <tr key={id}>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1", fontFamily: "monospace" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <span
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 999,
                                    background: c.color,
                                    border: "1px solid #ddd",
                                  }}
                                />
                                {c.label}
                              </span>
                            </td>
                            <td style={{ padding: "6px", borderBottom: "1px solid #f1f1f1" }}>{note || "-"}</td>
                          </tr>
                        );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>카테고리 이름/색상 매핑</div>
                  {categoryIds.length === 0 ? (
                    <div style={{ color: "#666" }}>매핑할 카테고리가 없습니다.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {categoryIds.map((id) => {
                        const base = categoryMap.get(id);
                        const override = overrides[id];
                        return (
                          <div
                            key={id}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1.5fr 1fr 120px",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{id}</div>
                            <input
                              value={override?.label ?? base?.label ?? ""}
                              onChange={(e) => setOverride(id, { label: e.target.value })}
                              placeholder="표시 이름"
                            />
                            <input
                              type="color"
                              value={override?.color ?? base?.color ?? "#e5e7eb"}
                              onChange={(e) => setOverride(id, { color: e.target.value })}
                            />
                          </div>
                        );
                      })}
                      <div>
                        <button onClick={() => saveOverrides(categoryIds)} disabled={savingOverrides}>
                          {savingOverrides ? "저장 중..." : "매핑 저장"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
