"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  countQueuedRecordWrites,
  getQueuedRecordWrites,
  queueRecordWrite,
  removeQueuedRecordWrite,
  type RecordWritePayload,
} from "@/lib/offline-record-queue";

const START_OFFSET_MIN = 180; // 03:00
const MIN_PER_SLOT = 5;
const SLOTS = 288;

// GRID: 12칸(=1시간) x 24줄(=24시간)
const COLS = 12;
const ROWS = 24;
const CELL = 22;
const GRID_W = COLS * CELL;
const GRID_H = ROWS * CELL;
const TIME_LABEL_W = 64;
const GRID_LABEL_GAP = 4;
const AUTO_TRACK_MIN_SAVE_SEC = 10;
const AUTO_TRACK_RESUME_GAP_SEC = 10;

type Category = { id: string; label: string; color: string };
type SlotSegment = { start: number; end: number; color: string };

// ✅ 앞으로 기록은 categoryId로 저장 (라벨 변경해도 기록 유지)
type Block = {
  id: string;
  start: number; // 0..1435 (03 기준)
  dur: number; // 분 단위 (수동 입력은 5분 단위, 자동 기록은 초단위 분수 가능)
  categoryId: string;
};

const CATEGORIES_KEY = "timetracker_categories_v1";
const AUTO_TRACK_KEY_PREFIX = "timetracker_auto_track_v1";

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `id_${Math.random().toString(16).slice(2)}`;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function labelFromIndex03(idxMin: number) {
  const roundedMin = Math.floor(idxMin);
  const realMin = (roundedMin + START_OFFSET_MIN) % 1440;
  const h = Math.floor(realMin / 60);
  const m = realMin % 60;
  const isNextDay = roundedMin + START_OFFSET_MIN >= 1440;
  return `${isNextDay ? "다음날 " : ""}${pad2(h)}:${pad2(m)}`;
}

function labelFromIndex03Compact(idxMin: number) {
  const roundedMin = Math.floor(idxMin);
  const realMin = (roundedMin + START_OFFSET_MIN) % 1440;
  const h = Math.floor(realMin / 60);
  const m = realMin % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function labelFromIndex03Sec(idxMin: number) {
  const roundedSec = Math.max(0, Math.round(idxMin * 60));
  const realSecBase = roundedSec + START_OFFSET_MIN * 60;
  const daySec = 24 * 60 * 60;
  const realSec = ((realSecBase % daySec) + daySec) % daySec;
  const h = Math.floor(realSec / 3600);
  const m = Math.floor((realSec % 3600) / 60);
  const s = realSec % 60;
  const isNextDay = realSecBase >= daySec;
  return `${isNextDay ? "다음날 " : ""}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeRange(a: number, b: number) {
  const s = Math.min(a, b);
  const e = Math.max(a, b);
  const start = clamp(Math.round(s / 5) * 5, 0, 1435);
  const end = clamp(Math.round(e / 5) * 5, 0, 1440);
  const dur = Math.max(5, end - start);
  return { start, dur };
}

function currentMin03FromMs(ms: number) {
  const d = new Date(ms);
  const mins =
    d.getHours() * 60 +
    d.getMinutes() +
    d.getSeconds() / 60 +
    d.getMilliseconds() / 60000;
  return (mins - START_OFFSET_MIN + 1440) % 1440;
}

function applyBlock(blocks: Block[], incoming: Omit<Block, "id"> & { id?: string }) {
  const EPS = 1e-6;
  const newBlock: Block = { id: incoming.id ?? uuid(), ...incoming };

  const a0 = newBlock.start;
  const a1 = newBlock.start + newBlock.dur;

  const next: Block[] = [];
  for (const b of blocks) {
    const b0 = b.start;
    const b1 = b.start + b.dur;

    if (b1 <= a0 || a1 <= b0) {
      next.push(b);
      continue;
    }

    if (b0 < a0)
      next.push({
        ...b,
        id: uuid(),
        dur: a0 - b0,
      });
    if (a1 < b1)
      next.push({
        ...b,
        id: uuid(),
        start: a1,
        dur: b1 - a1,
      });
  }

  next.push(newBlock);
  next.sort((x, y) => x.start - y.start);

  // 같은 카테고리면 붙여서 merge
  const merged: Block[] = [];
  for (const b of next) {
    const last = merged[merged.length - 1];
    if (last && last.categoryId === b.categoryId && Math.abs(last.start + last.dur - b.start) < EPS) {
      last.dur += b.dur;
    } else {
      merged.push({ ...b });
    }
  }

  return merged.filter((b) => b.dur > EPS);
}

function mergeSameCategoryNearBlocks(blocks: Block[], maxGapMin: number) {
  const EPS = 1e-6;
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const merged: Block[] = [];

  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...b });
      continue;
    }

    const lastEnd = last.start + last.dur;
    const gap = b.start - lastEnd;
    if (last.categoryId === b.categoryId && gap <= maxGapMin + EPS) {
      const end = Math.max(lastEnd, b.start + b.dur);
      last.dur = end - last.start;
    } else {
      merged.push({ ...b });
    }
  }

  return merged.filter((b) => b.dur > EPS);
}

function applyTimerBlock(blocks: Block[], timerBlock: Block) {
  const withBlock = applyBlock(blocks, timerBlock);
  return mergeSameCategoryNearBlocks(withBlock, AUTO_TRACK_RESUME_GAP_SEC / 60);
}

function snapIndexFromPoint(clientY: number, clientX: number, top: number, left: number) {
  const y = clientY - top;
  const x = clientX - left;

  const col = clamp(Math.round(x / CELL), 0, COLS);
  const row = clamp(Math.round(y / CELL), 0, ROWS);

  const slot = row * COLS + col; // 0..288
  const clampedSlot = clamp(slot, 0, SLOTS);
  return clampedSlot * MIN_PER_SLOT;
}

function timeLabelForRow(row: number) {
  const idxMin = row * 60;
  return labelFromIndex03Compact(idxMin);
}

function loadCategories(): Category[] {
  const raw = localStorage.getItem(CATEGORIES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Category[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c?.id && c?.label && c?.color);
  } catch {
    return [];
  }
}

function addDays(isoDate: string, diff: number) {
  const d = parseLocalDate(isoDate);
  d.setDate(d.getDate() + diff);
  return formatLocalDate(d);
}

function isoDayKey03(date = new Date()) {
  const d = new Date(date);
  // 03:00 기준으로 하루를 끊기 위해 3시간을 빼서 날짜 키를 만든다
  d.setHours(d.getHours() - 3);
  return formatLocalDate(d);
}

function formatLocalDate(d: Date) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function parseLocalDate(isoDate: string) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function mondayStart(isoDate: string) {
  const d = parseLocalDate(isoDate);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatLocalDate(d);
}

function min03FromMsForDay(dayIso: string, ms: number) {
  const dayStart = parseLocalDate(dayIso);
  dayStart.setHours(3, 0, 0, 0);
  return (ms - dayStart.getTime()) / 60000;
}

function buildSlotGradient(segments: SlotSegment[], baseColor: string) {
  if (segments.length === 0) return baseColor;

  const sorted = [...segments]
    .map((seg) => ({
      start: clamp(seg.start, 0, 5),
      end: clamp(seg.end, 0, 5),
      color: seg.color,
    }))
    .filter((seg) => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) return baseColor;

  const stops: string[] = [];
  let cursor = 0;

  for (const seg of sorted) {
    const startPct = (seg.start / 5) * 100;
    const endPct = (seg.end / 5) * 100;

    if (startPct > cursor) {
      stops.push(`${baseColor} ${cursor}%`, `${baseColor} ${startPct}%`);
    }

    stops.push(`${seg.color} ${startPct}%`, `${seg.color} ${endPct}%`);
    cursor = endPct;
  }

  if (cursor < 100) {
    stops.push(`${baseColor} ${cursor}%`, `${baseColor} 100%`);
  }

  return `linear-gradient(to right, ${stops.join(", ")})`;
}

type DayRecord = {
  blocks: Block[];
  notesByCategory: Record<string, string>;
  notesByBlock: Record<string, string>;
  secondsByCategory: Record<string, number>;
};
type ThemeMode = "light" | "dark";

const EMPTY_RECORD: DayRecord = { blocks: [], notesByCategory: {}, notesByBlock: {}, secondsByCategory: {} };
const THEME_KEY = "timetracker_theme_mode_v1";

function fmtDayLabel(isoDate: string) {
  // MM/DD
  return `${isoDate.slice(5, 7)}/${isoDate.slice(8, 10)}`;
}

export default function DayPage() {
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<number | null>(null);
  const isErasingRef = useRef(false);
  const isPinchingRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [recordsByDay, setRecordsByDay] = useState<Record<string, DayRecord>>({});
  const [secondsByDay, setSecondsByDay] = useState<Record<string, Record<string, number>>>({});
  const [showAdminLinks, setShowAdminLinks] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserName, setCurrentUserName] = useState<string>("");
  const [currentUserEmail, setCurrentUserEmail] = useState<string>("");

  // ✅ Step 1: 03시 기준 날짜
  const [day, setDay] = useState(() => isoDayKey03());

  // ✅ categories는 setup에서 로드
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesReady, setCategoriesReady] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState<string>("");

  // ✅ 날짜별 기록
  const [actualBlocks, setActualBlocks] = useState<Block[]>([]);
  // ✅ 과목별 한 줄 메모 (최대 50자)
  const [notesByCategory, setNotesByCategory] = useState<Record<string, string>>({});
  const [notesByBlock, setNotesByBlock] = useState<Record<string, string>>({});
  const [openBlockMemoId, setOpenBlockMemoId] = useState<string | null>(null);
  const [showTodayMemoBoard, setShowTodayMemoBoard] = useState(false);
  const [showNotes, setShowNotes] = useState<boolean>(true);
  const [showAllNotes, setShowAllNotes] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isNarrow, setIsNarrow] = useState(false);
  const [dayReadyForSave, setDayReadyForSave] = useState(false);
  const [autoTrackCategoryId, setAutoTrackCategoryId] = useState<string | null>(null);
  const [autoTrackDay, setAutoTrackDay] = useState<string | null>(null);
  const autoTrackStartedAtMsRef = useRef<number | null>(null);
  const [autoTrackStartedAtMs, setAutoTrackStartedAtMs] = useState<number | null>(null);
  const [autoTrackNowMs, setAutoTrackNowMs] = useState<number>(Date.now());
  const autoTrackHydratedKeyRef = useRef<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  // ✅ Undo용 히스토리
  const [history, setHistory] = useState<Block[][]>([]);
  const [future, setFuture] = useState<Block[][]>([]);
  const hydratedDayRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.auth.getUser();
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setCurrentUserEmail(data.user.email ?? "");

        const session = await supabase.auth.getSession();
        let token = session.data.session?.access_token ?? null;
        if (!token) {
          const refreshed = await supabase.auth.refreshSession();
          token = refreshed.data.session?.access_token ?? null;
        }
        setAccessToken(token ?? null);
        const res = await fetch("/api/me", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.ok) {
          const body = await res.json();
          if (body.user?.status !== "APPROVED") {
            router.replace("/pending");
            return;
          }
          setCurrentUserId(String(body.user?.id ?? ""));
          setCurrentUserName(String(body.user?.name ?? ""));
          setCurrentUserEmail(String(body.user?.email ?? data.user.email ?? ""));
          const email = String(body.user?.email ?? "").toLowerCase();
          setShowAdminLinks(email === "yywoo7@naver.com");
        }

        const { data: authListener } = supabase.auth.onAuthStateChange(
          (_event: AuthChangeEvent, sessionNow: Session | null) => {
          setAccessToken(sessionNow?.access_token ?? null);
          }
        );

        if (!cancelled) setAuthReady(true);
        return () => {
          authListener.subscription.unsubscribe();
        };
      } catch {
        if (!cancelled) router.replace("/login");
      }
    }

    let unsub: undefined | (() => void);
    checkAuth().then((cleanup) => {
      unsub = cleanup;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [router]);

  const autoTrackStorageKey = useMemo(() => {
    if (!currentUserId) return null;
    return `${AUTO_TRACK_KEY_PREFIX}:${currentUserId}`;
  }, [currentUserId]);

  const refreshPendingSyncCount = useCallback(async () => {
    if (!currentUserId) {
      setPendingSyncCount(0);
      return;
    }
    try {
      const count = await countQueuedRecordWrites(currentUserId);
      setPendingSyncCount(count);
    } catch {
      // noop
    }
  }, [currentUserId]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const flushOfflineQueue = useCallback(async () => {
    if (!currentUserId || !accessToken || !isOnline) return;
    try {
      const queued = await getQueuedRecordWrites(currentUserId);
      if (queued.length === 0) {
        setPendingSyncCount(0);
        return;
      }

      for (const item of queued) {
        const res = await fetch("/api/records", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(item.payload),
        });
        if (!res.ok) break;
        await removeQueuedRecordWrite(currentUserId, item.day);
      }

      await refreshPendingSyncCount();
    } catch {
      // noop
    }
  }, [currentUserId, accessToken, isOnline, refreshPendingSyncCount]);

  useEffect(() => {
    if (!autoTrackStorageKey) return;
    if (autoTrackHydratedKeyRef.current === autoTrackStorageKey) return;
    autoTrackHydratedKeyRef.current = autoTrackStorageKey;
    if (autoTrackCategoryId) return;

    const raw = localStorage.getItem(autoTrackStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        categoryId?: string;
        day?: string;
        startedAtMs?: number;
      };
      if (!parsed.categoryId || !parsed.day || typeof parsed.startedAtMs !== "number") {
        localStorage.removeItem(autoTrackStorageKey);
        return;
      }

      // 새벽 경계 기준으로 "오늘" 데이터에서만 자동기록 복원
      if (parsed.day !== isoDayKey03()) {
        localStorage.removeItem(autoTrackStorageKey);
        return;
      }

      setAutoTrackCategoryId(parsed.categoryId);
      setAutoTrackDay(parsed.day);
      autoTrackStartedAtMsRef.current = parsed.startedAtMs;
      setAutoTrackStartedAtMs(parsed.startedAtMs);
      setAutoTrackNowMs(Date.now());
    } catch {
      localStorage.removeItem(autoTrackStorageKey);
    }
  }, [autoTrackStorageKey, autoTrackCategoryId]);

  useEffect(() => {
    if (!autoTrackStorageKey) return;
    if (autoTrackCategoryId && autoTrackStartedAtMs != null) {
      localStorage.setItem(
        autoTrackStorageKey,
        JSON.stringify({
          categoryId: autoTrackCategoryId,
          day: autoTrackDay ?? day,
          startedAtMs: autoTrackStartedAtMs,
        })
      );
      return;
    }
    localStorage.removeItem(autoTrackStorageKey);
  }, [autoTrackStorageKey, autoTrackCategoryId, autoTrackDay, autoTrackStartedAtMs, day]);

  useEffect(() => {
    refreshPendingSyncCount();
  }, [refreshPendingSyncCount]);

  useEffect(() => {
    flushOfflineQueue();
  }, [flushOfflineQueue]);

  const clearAllRecords = useCallback(async () => {
    if (!confirm("모든 날짜의 기록을 정말 삭제할까?")) return;

    if (!accessToken) {
      alert("로그인 토큰이 없어 삭제할 수 없어요. 다시 로그인해 주세요.");
      return;
    }

    setSaveStatus("saving");
    try {
      const res = await fetch("/api/records?all=1", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        alert("전체 삭제에 실패했어요. 잠시 후 다시 시도해 주세요.");
        setSaveStatus("saved");
        return;
      }

      setActualBlocks([]);
      setNotesByCategory({});
      setNotesByBlock({});
      setRecordsByDay({});
      setSecondsByDay({});
      setAutoTrackCategoryId(null);
      setAutoTrackDay(null);
      setAutoTrackStartedAtMs(null);
      setHistory([]);
      setFuture([]);
      setSaveStatus("saved");
      alert("모든 기록이 삭제됐어요");
    } catch {
      setSaveStatus("saved");
      alert("전체 삭제 중 오류가 발생했어요.");
    }
  }, [accessToken]);

  const clearCurrentDayRecords = useCallback(async () => {
    if (!confirm(`${day} 날짜 기록을 정말 삭제할까?`)) return;

    if (!accessToken) {
      alert("로그인 토큰이 없어 삭제할 수 없어요. 다시 로그인해 주세요.");
      return;
    }

    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/records?day=${day}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        alert("해당 날짜 삭제에 실패했어요.");
        setSaveStatus("saved");
        return;
      }

      setActualBlocks([]);
      setNotesByCategory({});
      setNotesByBlock({});
      setRecordsByDay((prev) => ({ ...prev, [day]: EMPTY_RECORD }));
      setSecondsByDay((prev) => ({ ...prev, [day]: {} }));
      setAutoTrackCategoryId(null);
      setAutoTrackDay(null);
      setAutoTrackStartedAtMs(null);
      setHistory([]);
      setFuture([]);
      setSaveStatus("saved");
      alert(`${day} 기록이 삭제됐어요`);
    } catch {
      setSaveStatus("saved");
      alert("날짜 삭제 중 오류가 발생했어요.");
    }
  }, [accessToken, day]);

  const isToday = day === isoDayKey03();

  // 현재 시간 (03 기준)
  const [nowMin, setNowMin] = useState<number | null>(null);

  const nowPos = useMemo(() => {
    if (nowMin == null) return null;
    const slot = Math.floor(nowMin / MIN_PER_SLOT);
    const row = Math.floor(slot / COLS);
    const col = slot % COLS;
    return { top: row * CELL, left: col * CELL };
  }, [nowMin]);

  const nowRow = useMemo(() => {
    if (nowMin == null) return null;
    const slot = Math.floor(nowMin / MIN_PER_SLOT);
    return Math.floor(slot / COLS);
  }, [nowMin]);

  function getCurrentMin03() {
    const now = new Date();
    const mins =
      now.getHours() * 60 +
      now.getMinutes() +
      now.getSeconds() / 60 +
      now.getMilliseconds() / 60000;
    return (mins - START_OFFSET_MIN + 1440) % 1440;
  }

  function clampInputMinToNow(idxMin: number) {
    return idxMin;
  }

  // ✅ 1분마다 현재시간 갱신
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const idx = (mins - START_OFFSET_MIN + 1440) % 1440;
      setNowMin(idx);
    };
    tick();
    const id = setInterval(tick, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Desktop(laptop) fixed layout / Mobile+Tablet compact layout
    const mq = window.matchMedia("(max-width: 1100px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      setThemeMode(saved);
      return;
    }

    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setThemeMode(prefersDark ? "dark" : "light");
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themeMode);
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    // Theme switch during interaction can leave transient selection paint artifacts.
    setDragStart(null);
    setDragEnd(null);
    dragStartRef.current = null;
    isDraggingRef.current = false;
    isErasingRef.current = false;
    isPinchingRef.current = false;
  }, [themeMode]);

  useEffect(() => {
    if (!showTodayMemoBoard) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowTodayMemoBoard(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showTodayMemoBoard]);

  useEffect(() => {
    if (!autoTrackCategoryId) return;
    setAutoTrackNowMs(Date.now());
    const id = window.setInterval(() => setAutoTrackNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [autoTrackCategoryId]);

  // ✅ 카테고리 로드 (서버 우선, 로컬 fallback)
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const local = loadCategories();

      if (!accessToken) {
        if (!cancelled) {
          setCategories(local);
          setActiveCategoryId((prev) => prev || local[0]?.id || "");
          setCategoriesReady(true);
        }
        return;
      }

      try {
        if (!cancelled) setCategoriesReady(false);
        const res = await fetch("/api/categories", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = res.ok ? await res.json() : null;
        const remote = Array.isArray(body?.categories)
          ? (body.categories as Category[]).filter((c) => c?.id && c?.label && c?.color)
          : [];

        const resolved = remote.length > 0 ? remote : local;
        if (!cancelled) {
          setCategories(resolved);
          setActiveCategoryId((prev) => prev || resolved[0]?.id || "");
          setCategoriesReady(true);
        }

        if (remote.length === 0 && local.length > 0) {
          await fetch("/api/categories", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ categories: local }),
          });
        }
      } catch {
        if (!cancelled) {
          setCategories(local);
          setActiveCategoryId((prev) => prev || local[0]?.id || "");
          setCategoriesReady(true);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  }, [categories]);

  useEffect(() => {
    if (categories.length === 0) {
      setActiveCategoryId("");
      return;
    }
    if (!categories.some((c) => c.id === activeCategoryId)) {
      setActiveCategoryId(categories[0].id);
    }
  }, [categories, activeCategoryId]);
  // Undo/Redo 안정성: refs + stable callbacks
  const actualBlocksRef = useRef<Block[]>([]);
  useEffect(() => {
    actualBlocksRef.current = actualBlocks;
  }, [actualBlocks]);

  const pushHistory = useCallback((snapshot: Block[]) => {
    setHistory((prev) => {
      const next = [...prev, snapshot];
      if (next.length > 50) next.shift();
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;

      const last = prev[prev.length - 1];
      setFuture((f) => [structuredClone(actualBlocksRef.current), ...f]);
      setActualBlocks(last);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;

      const next = prev[0];
      setHistory((h) => [...h, structuredClone(actualBlocksRef.current)]);
      setActualBlocks(next);
      return prev.slice(1);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      if (modifier && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }

      if (
        modifier &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  // ✅ 날짜 이동
  function moveDay(diff: number) {
    setDay((prev) => addDays(prev, diff));
  }

  // ✅ 날짜 전환 시 현재 day 로딩 상태 초기화
  useEffect(() => {
    hydratedDayRef.current = null;
    setDayReadyForSave(false);
  }, [day]);

  // ✅ 날짜별 기록 불러오기 (현재 day는 최초 1회만 반영해서 깜빡임 방지)
  useEffect(() => {
    if (hydratedDayRef.current === day) return;
    const rec = recordsByDay[day];
    if (!rec) return;
    setActualBlocks(rec.blocks);
    setNotesByCategory(rec.notesByCategory ?? {});
    setNotesByBlock(rec.notesByBlock ?? {});
    setSecondsByDay((prev) => ({ ...prev, [day]: rec.secondsByCategory ?? {} }));
    setSaveStatus("saved");
    hydratedDayRef.current = day;
    setDayReadyForSave(true);
  }, [day, recordsByDay]);

  // ✅ 날짜별 기록 저장
  useEffect(() => {
    if (!dayReadyForSave || !currentUserId) return;
    setSaveStatus("saving");
    const t = window.setTimeout(async () => {
      const payload: RecordWritePayload = {
        day,
        blocks: actualBlocks,
        notes: {
          byCategory: notesByCategory,
          byBlock: notesByBlock,
        },
        categories: {
          list: categories,
          secondsByCategory: secondsByDay[day] ?? {},
        },
      };

      const syncLocalState = () => {
        setSaveStatus("saved");
        setRecordsByDay((prev) => ({
          ...prev,
          [day]: {
            blocks: actualBlocks,
            notesByCategory,
            notesByBlock,
            secondsByCategory: secondsByDay[day] ?? {},
          },
        }));
      };

      try {
        if (!isOnline || !accessToken) {
          await queueRecordWrite(currentUserId, payload);
          await refreshPendingSyncCount();
          syncLocalState();
          return;
        }

        const res = await fetch("/api/records", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          await removeQueuedRecordWrite(currentUserId, day);
          await refreshPendingSyncCount();
          syncLocalState();
        } else {
          await queueRecordWrite(currentUserId, payload);
          await refreshPendingSyncCount();
          syncLocalState();
        }
      } catch {
        await queueRecordWrite(currentUserId, payload);
        await refreshPendingSyncCount();
        setSaveStatus("saved");
      }
    }, 200);

    return () => window.clearTimeout(t);
  }, [
    accessToken,
    currentUserId,
    dayReadyForSave,
    actualBlocks,
    notesByCategory,
    notesByBlock,
    categories,
    secondsByDay,
    day,
    isOnline,
    refreshPendingSyncCount,
  ]);
  // 카테고리가 바뀌어도 기존 메모는 유지하되, 값은 문자열로 정리
  useEffect(() => {
    setNotesByCategory((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const c of categories) {
        if (typeof next[c.id] !== "string") next[c.id] = "";
      }
      return next;
    });
  }, [categories]);

  useEffect(() => {
    const validIds = new Set(actualBlocks.map((b) => b.id));
    setNotesByBlock((prev) => {
      const next: Record<string, string> = {};
      for (const [id, note] of Object.entries(prev)) {
        if (validIds.has(id)) next[id] = note;
      }
      return next;
    });
  }, [actualBlocks]);

  // ✅ 최근 N일 변화 추이(7/14/30) + 범례 토글 + hover 툴팁
  const [trendDays, setTrendDays] = useState<7 | 14 | 30>(7);
  const [totalTrendMode, setTotalTrendMode] = useState<"total" | "selected">("total");
  const [investRange, setInvestRange] = useState<"day" | "week" | "month">("day");
  const [studyIncludedCategoryIds, setStudyIncludedCategoryIds] = useState<Record<string, boolean>>({});
  const [hiddenCategoryIds, setHiddenCategoryIds] = useState<Record<string, boolean>>({});
  const [hiddenTotal, setHiddenTotal] = useState<boolean>(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [totalHoverIndex, setTotalHoverIndex] = useState<number | null>(null);

  const trendDates = useMemo(() => {
    // 현재 보고 있는 day를 기준으로 과거 (trendDays-1)일 + 오늘(총 trendDays)
    return Array.from({ length: trendDays }).map((_, i) => addDays(day, i - (trendDays - 1)));
  }, [day, trendDays]);

  const investDates = useMemo(() => {
    if (investRange === "day") return [day];
    if (investRange === "week") {
      const start = mondayStart(day);
      return Array.from({ length: 7 }).map((_, i) => addDays(start, i));
    }
    const d = parseLocalDate(day);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const days = last.getDate();
    const startIso = formatLocalDate(first);
    return Array.from({ length: days }).map((_, i) => addDays(startIso, i));
  }, [day, investRange]);

  const daysToLoad = useMemo(() => {
    const set = new Set<string>([...trendDates, ...investDates, day]);
    return Array.from(set);
  }, [trendDates, investDates, day]);

  // ✅ 선택 범위
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  const selection = useMemo(() => {
    if (dragStart == null || dragEnd == null) return null;
    return normalizeRange(dragStart, dragEnd);
  }, [dragStart, dragEnd]);

  // ✅ filled(격자 칸 색)
  const colorById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of categories) map[c.id] = c.color;
    return map;
  }, [categories]);

  const slotSegments = useMemo(() => {
    const arr: SlotSegment[][] = Array.from({ length: SLOTS }, () => []);
    for (const b of actualBlocks) {
      const color = colorById[b.categoryId] ?? "#111827";
      const blockStart = b.start;
      const blockEnd = b.start + b.dur;
      const slotStart = Math.floor(blockStart / 5);
      const slotEnd = Math.ceil(blockEnd / 5);

      for (let i = slotStart; i < slotEnd && i < SLOTS; i++) {
        const s0 = i * 5;
        const s1 = s0 + 5;
        const overlapStart = Math.max(s0, blockStart);
        const overlapEnd = Math.min(s1, blockEnd);
        if (overlapEnd > overlapStart) {
          arr[i].push({
            start: overlapStart - s0,
            end: overlapEnd - s0,
            color,
          });
        }
      }
    }
    return arr;
  }, [actualBlocks, colorById]);

  const liveTrackVisual = useMemo(() => {
    if (!autoTrackCategoryId || autoTrackStartedAtMs == null || !isToday) return null;

    const startMin = currentMin03FromMs(autoTrackStartedAtMs);
    const nowMinPrecise = currentMin03FromMs(autoTrackNowMs);

    // day 경계 넘어가면 자동중지가 우선이므로 여기서는 같은 날짜 범위만 시각화
    const safeStart = clamp(startMin, 0, 1439);
    const safeNow = clamp(nowMinPrecise, safeStart, 1439);

    const startSlot = Math.floor(safeStart / 5);
    const endSlot = Math.max(startSlot + 1, Math.ceil(safeNow / 5));
    const color = colorById[autoTrackCategoryId] ?? "#2563eb";

    return { startSlot, endSlot, startMin: safeStart, nowMin: safeNow, color };
  }, [autoTrackCategoryId, autoTrackStartedAtMs, autoTrackNowMs, isToday, colorById]);

  const selSlots = useMemo(() => {
    if (!selection) return null;
    const s = Math.floor(selection.start / 5);
    const e = Math.floor((selection.start + selection.dur) / 5);
    return { s, e };
  }, [selection]);

function fmtMin(min: number) {
  const rounded = Math.max(0, Math.round(min));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function fmtDurSec(min: number) {
    const sec = Math.max(0, Math.round(min * 60));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function fmtElapsed(sec: number) {
    const wholeSec = Math.max(0, Math.round(sec));
    const s = wholeSec % 60;
    const totalMin = Math.floor(wholeSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  const runningElapsedSec = useMemo(() => {
    if (!autoTrackCategoryId || autoTrackStartedAtMs == null) return 0;
    return Math.max(0, Math.floor((autoTrackNowMs - autoTrackStartedAtMs) / 1000));
  }, [autoTrackCategoryId, autoTrackStartedAtMs, autoTrackNowMs]);

  useEffect(() => {
    setStudyIncludedCategoryIds((prev) => {
      const next: Record<string, boolean> = {};
      for (const c of categories) next[c.id] = prev[c.id] ?? true;
      return next;
    });
  }, [categories]);

  const isStudyIncluded = useCallback(
    (categoryId: string) => studyIncludedCategoryIds[categoryId] !== false,
    [studyIncludedCategoryIds]
  );

  // ✅ 요약(카테고리별)
  const summary = useMemo(() => {
    const totals: Record<string, number> = {};
    const daySeconds = secondsByDay[day] ?? {};
    for (const c of categories) totals[c.id] = (daySeconds[c.id] ?? 0) / 60;
    for (const b of actualBlocks) totals[b.categoryId] = (totals[b.categoryId] ?? 0) + b.dur;
    if (autoTrackCategoryId && autoTrackDay === day) {
      totals[autoTrackCategoryId] = (totals[autoTrackCategoryId] ?? 0) + runningElapsedSec / 60;
    }
    const totalMin = Object.entries(totals).reduce(
      (acc, [categoryId, min]) => (isStudyIncluded(categoryId) ? acc + min : acc),
      0
    );
    return { totals, totalMin };
  }, [actualBlocks, categories, secondsByDay, day, autoTrackCategoryId, autoTrackDay, runningElapsedSec, isStudyIncluded]);

  const todayMemoBoard = useMemo(() => {
    const categoryNotes = categories
      .map((c) => ({
        categoryId: c.id,
        label: c.label,
        color: c.color,
        note: (notesByCategory[c.id] ?? "").trim(),
      }))
      .filter((x) => x.note.length > 0);

    const timelineNotes = actualBlocks
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((b) => {
        const cat = categories.find((c) => c.id === b.categoryId);
        const blockNote = (notesByBlock[b.id] ?? "").trim();
        const categoryNote = (notesByCategory[b.categoryId] ?? "").trim();
        return {
          id: b.id,
          label: cat?.label ?? "(알 수 없음)",
          color: cat?.color ?? "#111827",
          range: `${labelFromIndex03Sec(b.start)} ~ ${labelFromIndex03Sec(b.start + b.dur)}`,
          duration: fmtDurSec(b.dur),
          blockNote,
          categoryNote,
        };
      })
      .filter((x) => x.blockNote.length > 0 || x.categoryNote.length > 0);

    return { categoryNotes, timelineNotes };
  }, [categories, notesByCategory, notesByBlock, actualBlocks]);

  const baseSecondsByCategory = useMemo(() => {
    const targetDay = autoTrackDay ?? day;
    const daySeconds = secondsByDay[targetDay] ?? {};
    const blocks = targetDay === day ? actualBlocks : (recordsByDay[targetDay]?.blocks ?? []);
    const fromBlocks: Record<string, number> = {};
    for (const b of blocks) {
      fromBlocks[b.categoryId] = (fromBlocks[b.categoryId] ?? 0) + Math.round(b.dur * 60);
    }

    const merged: Record<string, number> = { ...daySeconds };
    for (const [id, sec] of Object.entries(fromBlocks)) {
      merged[id] = (merged[id] ?? 0) + sec;
    }
    return merged;
  }, [secondsByDay, day, actualBlocks, autoTrackDay, recordsByDay]);

  const autoTrackCumulativeSec = useMemo(() => {
    if (!autoTrackCategoryId) return 0;
    return (baseSecondsByCategory[autoTrackCategoryId] ?? 0) + runningElapsedSec;
  }, [autoTrackCategoryId, baseSecondsByCategory, runningElapsedSec]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    async function loadDays() {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const results = await Promise.all(
        daysToLoad.map(async (d) => {
          const res = await fetch(`/api/records?day=${d}`, { headers });
          if (!res.ok) return null;
          const body = await res.json();
          const rawCategories = body.record?.categories;
          const parsedSeconds =
            rawCategories && !Array.isArray(rawCategories)
              ? ((rawCategories.secondsByCategory as Record<string, number> | undefined) ?? {})
              : {};
          const rawNotes =
            body.record?.notes && typeof body.record.notes === "object" && !Array.isArray(body.record.notes)
              ? (body.record.notes as Record<string, unknown>)
              : {};
          const byCategory =
            rawNotes.byCategory && typeof rawNotes.byCategory === "object" && !Array.isArray(rawNotes.byCategory)
              ? (rawNotes.byCategory as Record<string, string>)
              : ((body.record?.notes as Record<string, string>) ?? {});
          const byBlock =
            rawNotes.byBlock && typeof rawNotes.byBlock === "object" && !Array.isArray(rawNotes.byBlock)
              ? (rawNotes.byBlock as Record<string, string>)
              : {};
          const record = body.record
            ? {
                blocks: (body.record.blocks as Block[]) ?? [],
                notesByCategory: byCategory,
                notesByBlock: byBlock,
                secondsByCategory: parsedSeconds,
              }
            : EMPTY_RECORD;
          return [d, record] as const;
        })
      );

      if (!cancelled) {
        setRecordsByDay((prev) => {
          const next = { ...prev };
          for (const item of results) {
            if (!item) continue;
            const [d, record] = item;
            next[d] = record;
          }
          return next;
        });
        setSecondsByDay((prev) => {
          const next = { ...prev };
          for (const item of results) {
            if (!item) continue;
            const [d, record] = item;
            next[d] = record.secondsByCategory ?? {};
          }
          return next;
        });
      }
    }

    loadDays();
    return () => {
      cancelled = true;
    };
  }, [accessToken, daysToLoad]);

  const trend = useMemo(() => {
    const totalsByDay: Array<{ day: string; totals: Record<string, number>; totalMin: number }> = [];

    for (const d of trendDates) {
      const blocks = d === day ? actualBlocks : (recordsByDay[d]?.blocks ?? []);
      const daySeconds = secondsByDay[d] ?? {};
      const totals: Record<string, number> = {};
      for (const c of categories) totals[c.id] = (daySeconds[c.id] ?? 0) / 60;

      for (const b of blocks) {
        totals[b.categoryId] = (totals[b.categoryId] ?? 0) + b.dur;
      }
      if (d === autoTrackDay && autoTrackCategoryId) {
        totals[autoTrackCategoryId] = (totals[autoTrackCategoryId] ?? 0) + runningElapsedSec / 60;
      }

      const totalMin = Object.entries(totals).reduce(
        (acc, [categoryId, min]) => (isStudyIncluded(categoryId) ? acc + min : acc),
        0
      );
      totalsByDay.push({ day: d, totals, totalMin });
    }

    // ✅ 표시중(숨김 제외) 카테고리 기준으로 yMax 계산
    const visibleCategories = categories.filter((c) => !hiddenCategoryIds[c.id]);
    const catsForScale = visibleCategories.length ? visibleCategories : categories;

    const yCandidates = totalsByDay.flatMap((x) => catsForScale.map((c) => x.totals[c.id] ?? 0));
    if (!hiddenTotal) {
      for (const x of totalsByDay) yCandidates.push(x.totalMin);
    }

    const maxY = Math.max(1, ...yCandidates);
    return { totalsByDay, maxY };
  }, [
    trendDates,
    day,
    actualBlocks,
    categories,
    recordsByDay,
    secondsByDay,
    autoTrackCategoryId,
    runningElapsedSec,
    autoTrackDay,
    hiddenCategoryIds,
    hiddenTotal,
    isStudyIncluded,
  ]);

  const investSummary = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const c of categories) totals[c.id] = 0;

    for (const d of investDates) {
      const blocks = d === day ? actualBlocks : (recordsByDay[d]?.blocks ?? []);
      const daySeconds = secondsByDay[d] ?? {};

      for (const c of categories) {
        totals[c.id] = (totals[c.id] ?? 0) + (daySeconds[c.id] ?? 0) / 60;
      }
      for (const b of blocks) {
        totals[b.categoryId] = (totals[b.categoryId] ?? 0) + b.dur;
      }
      if (d === autoTrackDay && autoTrackCategoryId) {
        totals[autoTrackCategoryId] = (totals[autoTrackCategoryId] ?? 0) + runningElapsedSec / 60;
      }
    }

    const totalMin = Object.values(totals).reduce((a, b) => a + b, 0);
    const rows = categories
      .map((c) => {
        const min = totals[c.id] ?? 0;
        const pct = totalMin > 0 ? (min / totalMin) * 100 : 0;
        return { ...c, min, pct };
      })
      .filter((r) => r.min > 0)
      .sort((a, b) => b.min - a.min);

    return { totalMin, rows };
  }, [categories, investDates, day, actualBlocks, recordsByDay, secondsByDay, autoTrackCategoryId, autoTrackDay, runningElapsedSec]);

  const theme = useMemo(
    () =>
      themeMode === "dark"
        ? {
            bg: "#121212",
            card: "#171717",
            cardSoft: "#1c1c1c",
            text: "#EAEAEA",
            muted: "#b0b0b0",
            border: "#2e2e2e",
            borderSubtle: "#242424",
            controlBg: "#1f1f1f",
            controlActiveBg: "#0ea5e9",
            controlActiveText: "#ffffff",
            controlText: "#EAEAEA",
            axis: "#9a9a9a",
            grid: "#2a2a2a",
            panelShadow: "0 12px 40px rgba(0,0,0,0.45)",
            buttonShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 20px rgba(0,0,0,0.28)",
            surfaceGlow: "0 0 0 1px rgba(255,255,255,0.02)",
          }
        : {
            bg: "#f7f8fb",
            card: "#ffffff",
            cardSoft: "#fafafa",
            text: "#111827",
            muted: "#6b7280",
            border: "#e5e7eb",
            borderSubtle: "#f1f5f9",
            controlBg: "#ffffff",
            controlActiveBg: "#111827",
            controlActiveText: "#ffffff",
            controlText: "#111827",
            axis: "#6b7280",
            grid: "#f3f4f6",
            panelShadow: "0 8px 24px rgba(15,23,42,0.06)",
            buttonShadow: "none",
            surfaceGlow: "none",
          },
    [themeMode]
  );

  function stopAutoTrack(flush = true) {
    const targetDay = autoTrackDay ?? day;
    const targetCategoryId = autoTrackCategoryId;
    const startedAt = autoTrackStartedAtMsRef.current ?? autoTrackStartedAtMs;
    const endedAt = Date.now();
    const liveElapsedSec =
      startedAt != null
        ? Math.max(0, Math.floor((endedAt - startedAt) / 1000))
        : 0;
    const flushSec = Math.max(runningElapsedSec, liveElapsedSec);

    if (flush && targetCategoryId && flushSec >= AUTO_TRACK_MIN_SAVE_SEC) {
      if (startedAt != null) {
        // Persist timer blocks at 1-second resolution to avoid long float tails.
        const startSec = clamp(Math.round(min03FromMsForDay(targetDay, startedAt) * 60), 0, 24 * 60 * 60 - 1);
        const endSecRaw = clamp(Math.round(min03FromMsForDay(targetDay, endedAt) * 60), 0, 24 * 60 * 60);
        const endSec = Math.max(startSec + 1, endSecRaw);
        const startMin = startSec / 60;
        const dur = (endSec - startSec) / 60;
        const timerBlock: Block = {
          id: uuid(),
          start: startMin,
          dur,
          categoryId: targetCategoryId,
        };

        if (targetDay === day) {
          setActualBlocks((prev) => applyTimerBlock(prev, timerBlock));
        } else {
          setRecordsByDay((prev) => {
            const existing = prev[targetDay] ?? EMPTY_RECORD;
            return {
              ...prev,
              [targetDay]: {
                ...existing,
                blocks: applyTimerBlock(existing.blocks, timerBlock),
                notesByCategory: existing.notesByCategory ?? {},
                notesByBlock: existing.notesByBlock ?? {},
                secondsByCategory: existing.secondsByCategory ?? {},
              },
            };
          });
        }
      }
    }

    setAutoTrackCategoryId(null);
    setAutoTrackDay(null);
    autoTrackStartedAtMsRef.current = null;
    setAutoTrackStartedAtMs(null);
    if (autoTrackStorageKey) {
      localStorage.removeItem(autoTrackStorageKey);
    }
  }

  function toggleCategoryVisible(id: string) {
    setHiddenCategoryIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleAutoTrack(categoryId: string) {
    if (autoTrackCategoryId === categoryId) {
      stopAutoTrack(true);
      return;
    }

    if (!isToday) {
      alert("자동 기록은 오늘 화면에서만 사용할 수 있어요.");
      return;
    }

    if (autoTrackCategoryId && autoTrackCategoryId !== categoryId) {
      // 과목 전환 시 기존 과목은 그 시점까지 즉시 누적 반영
      stopAutoTrack(true);
    }

    setActiveCategoryId(categoryId);
    setAutoTrackCategoryId(categoryId);
    setAutoTrackDay(day);
    const nowMs = Date.now();
    autoTrackStartedAtMsRef.current = nowMs;
    setAutoTrackStartedAtMs(nowMs);
    setAutoTrackNowMs(nowMs);
  }

  function removeBlockAt(min: number) {
    setActualBlocks((prev) => {
      pushHistory(structuredClone(prev));
      setFuture([]);

      const next: Block[] = [];

      for (const b of prev) {
        const bStart = b.start;
        const bEnd = b.start + b.dur;

        // 클릭한 칸이 이 블록과 무관
        if (min < bStart || min >= bEnd) {
          next.push(b);
          continue;
        }

        // 🔥 앞쪽 남는 블록
        if (bStart < min) {
          next.push({
            ...b,
            id: uuid(),
            dur: min - bStart,
          });
        }

        // 🔥 뒤쪽 남는 블록
        const afterStart = min + 5;
        if (afterStart < bEnd) {
          next.push({
            ...b,
            id: uuid(),
            start: afterStart,
            dur: bEnd - afterStart,
          });
        }
      }

      return next;
    });
  }
  function removeSelectionRange(start: number, dur: number) {
    const delStart = start;
    const delEnd = start + dur;

    setActualBlocks((prev) => {
      pushHistory(structuredClone(prev));
      setFuture([]);

      const next: Block[] = [];

      for (const b of prev) {
        const bStart = b.start;
        const bEnd = b.start + b.dur;

        // 1) 겹치지 않으면 그대로 유지
        if (bEnd <= delStart || delEnd <= bStart) {
          next.push(b);
          continue;
        }

        // 2) 삭제 범위 앞쪽이 남으면 잘라서 유지
        if (bStart < delStart) {
          next.push({
            ...b,
            id: uuid(),
            dur: delStart - bStart,
          });
        }

        // 3) 삭제 범위 뒤쪽이 남으면 잘라서 유지
        if (delEnd < bEnd) {
          next.push({
            ...b,
            id: uuid(),
            start: delEnd,
            dur: bEnd - delEnd,
          });
        }
      }

      next.sort((a, b) => a.start - b.start);
      return next.filter((b) => b.dur >= 5);
    });
  }
  function commitSelection() {
    if (!selection) return;

    // ✅ 지우개 모드: 드래그한 범위를 삭제
    // (removeSelectionRange 내부에서 history 저장 + redo 초기화를 이미 처리함)
    if (isErasingRef.current) {
      removeSelectionRange(selection.start, selection.dur);

      setDragStart(null);
      setDragEnd(null);
      isErasingRef.current = false;
      return;
    }

    // ✅ 그리기 모드
    if (!activeCategoryId) return;

    // ✅ 1️⃣ 변경 "직전" 상태를 history에 저장
    pushHistory(structuredClone(actualBlocks));
    setFuture([]); // 새 작업 시작 시 redo 기록 초기화

    // ✅ 2️⃣ 실제 변경
    setActualBlocks((prev) =>
      applyBlock(prev, {
        start: selection.start,
        dur: selection.dur,
        categoryId: activeCategoryId,
      })
    );

    setDragStart(null);
    setDragEnd(null);
    // 항상 모드 리셋되게 해
    isErasingRef.current = false;
  }

  if (!authReady || !categoriesReady) {
    return (
      <div style={{ maxWidth: 520, margin: "64px auto", padding: 24, color: theme.text }}>
        로딩 중...
      </div>
    );
  }

  // ✅ 카테고리 없으면 setup으로 안내
  if (categories.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", background: theme.bg, color: theme.text, minHeight: "100vh" }}>
        <h1 style={{ margin: 0 }}>TimeTracker</h1>
        <p style={{ marginTop: 8, color: theme.muted }}>
          먼저 항목(카테고리)과 색을 설정해야 해.
        </p>
        <button
          onClick={() => router.push("/setup")}
          style={{
            marginTop: 10,
            padding: "10px 14px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlActiveBg,
            color: theme.controlActiveText,
            cursor: "pointer",
          }}
        >
          설정하러 가기
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: isNarrow ? 12 : 24,
        fontFamily: "system-ui",
        maxWidth: isNarrow ? "100%" : 1200,
        margin: "0 auto",
        background: theme.bg,
        color: theme.text,
        minHeight: "100dvh",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: isNarrow ? "wrap" : "nowrap",
          padding: isNarrow ? "10px 10px" : "12px 14px",
          borderRadius: 14,
          border: `1px solid ${theme.border}`,
          background: theme.card,
        }}
      >
        <h1 style={{ margin: 0, fontWeight: 800, letterSpacing: "-0.02em" }}>TimeTracker</h1>
        <div
          style={{
            fontSize: 13,
            color: theme.muted,
            marginRight: 4,
          }}
        >
          {currentUserName ? `${currentUserName} (${currentUserEmail})` : currentUserEmail}
        </div>
        <button
          aria-label={themeMode === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
          onClick={() => setThemeMode((prev) => (prev === "dark" ? "light" : "dark"))}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlBg,
            color: theme.controlText,
            cursor: "pointer",
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          {themeMode === "dark" ? "Light" : "Dark"}
        </button>
        <button
          onClick={clearAllRecords}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${themeMode === "dark" ? "#7f1d1d" : "#fca5a5"}`,
            background: theme.controlBg,
            color: themeMode === "dark" ? "#fca5a5" : "#b91c1c",
            cursor: "pointer",
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          기록 전체 삭제
        </button>
        <button
          onClick={clearCurrentDayRecords}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${themeMode === "dark" ? "#854d0e" : "#fcd34d"}`,
            background: theme.controlBg,
            color: themeMode === "dark" ? "#fde68a" : "#92400e",
            cursor: "pointer",
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          오늘(선택일) 삭제
        </button>
        <div
          style={{
            marginLeft: isNarrow ? 0 : "auto",
            fontSize: 12,
            color: theme.muted,
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 84,
            justifyContent: "flex-end",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: !isOnline ? "#f59e0b" : saveStatus === "saving" ? "#f59e0b" : "#22c55e",
              display: "inline-block",
            }}
          />
          {!isOnline
            ? `오프라인 (${pendingSyncCount}건 대기)`
            : saveStatus === "saving"
              ? "저장 중…"
              : pendingSyncCount > 0
                ? `동기화 대기 ${pendingSyncCount}건`
                : "저장됨"}
        </div>
        <button
          onClick={() => router.push("/setup")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlBg,
            color: theme.controlText,
            cursor: "pointer",
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          설정
        </button>
        <button
          onClick={() => router.push("/weekly")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlBg,
            color: theme.controlText,
            cursor: "pointer",
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          주간 리포트
        </button>
        {showAdminLinks && (
          <>
            <button
              onClick={() => router.push("/admin")}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.border}`,
                background: theme.controlActiveBg,
                color: theme.controlActiveText,
                cursor: "pointer",
                fontSize: 13,
                boxShadow: theme.buttonShadow,
              }}
            >
              관리자 승인/할당
            </button>
            <button
              onClick={() => router.push("/admin/records")}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.border}`,
                background: theme.controlBg,
                color: theme.controlText,
                cursor: "pointer",
                fontSize: 13,
                boxShadow: theme.buttonShadow,
              }}
            >
              학생 기록 보기
            </button>
            <button
              onClick={() => router.push("/admin/weekly")}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.border}`,
                background: theme.controlBg,
                color: theme.controlText,
                cursor: "pointer",
                fontSize: 13,
                boxShadow: theme.buttonShadow,
              }}
            >
              학생 주간 리포트
            </button>
          </>
        )}
      </div>

      <div
        style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: isNarrow ? "wrap" : "nowrap" }}
      >
        <button
          onClick={() => moveDay(-1)}
          style={{
            minWidth: 48,
            minHeight: 44,
            padding: "0 12px",
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            background: theme.controlBg,
            color: theme.controlText,
            fontSize: 18,
            fontWeight: 800,
            cursor: "pointer",
            boxShadow: theme.buttonShadow,
            touchAction: "manipulation",
          }}
          aria-label="이전 날짜"
          title="이전 날짜"
        >
          ◀
        </button>
        <strong style={{ fontSize: 24, lineHeight: 1 }}>{day}</strong>
        <button
          onClick={() => moveDay(1)}
          style={{
            minWidth: 48,
            minHeight: 44,
            padding: "0 12px",
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            background: theme.controlBg,
            color: theme.controlText,
            fontSize: 18,
            fontWeight: 800,
            cursor: "pointer",
            boxShadow: theme.buttonShadow,
            touchAction: "manipulation",
          }}
          aria-label="다음 날짜"
          title="다음 날짜"
        >
          ▶
        </button>
      </div>

      <p style={{ marginTop: 6, color: theme.muted }}>03:00 ~ 다음날 03:00</p>

      {/* 요약 */}
      <div
        style={{
          marginTop: 12,
          padding: 12,
          border: `1px solid ${theme.border}`,
          borderRadius: 12,
          background: theme.cardSoft,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 700 }}>
          합계: {fmtMin(summary.totalMin)}
        </div>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => toggleAutoTrack(c.id)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 999,
              background:
                autoTrackCategoryId === c.id
                  ? c.color
                  : theme.card,
              border: `1px solid ${autoTrackCategoryId === c.id ? c.color : theme.border}`,
              color: autoTrackCategoryId === c.id ? "#fff" : theme.text,
              cursor: "pointer",
              boxShadow: theme.buttonShadow,
              minWidth: isNarrow ? 142 : 156,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
            title={
              autoTrackCategoryId === c.id
                ? "클릭해서 자동 기록 중지"
                : "클릭해서 자동 기록 시작"
            }
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: c.color,
                display: "inline-block",
              }}
            />
            <span style={{ fontSize: 13, fontWeight: 700, opacity: autoTrackCategoryId === c.id ? 1 : 0.92 }}>
              {c.label}
            </span>
            <span style={{ fontSize: 12, opacity: autoTrackCategoryId === c.id ? 1 : 0.78 }}>
              {autoTrackCategoryId === c.id
                ? fmtElapsed(autoTrackCumulativeSec)
                : fmtMin(summary.totals[c.id] ?? 0)}
            </span>
          </button>
        ))}
      </div>

      {/* 카테고리 버튼 */}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategoryId(cat.id)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: `1px solid ${theme.border}`,
              background: activeCategoryId === cat.id ? cat.color : theme.controlBg,
              color: activeCategoryId === cat.id ? "#fff" : theme.controlText,
              cursor: "pointer",
              fontSize: 13,
              boxShadow: theme.buttonShadow,
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          onClick={undo}
          disabled={history.length === 0}
          style={{
            padding: "6px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlBg,
            color: theme.controlText,
            cursor: history.length === 0 ? "not-allowed" : "pointer",
            opacity: history.length === 0 ? 0.5 : 1,
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          이전 (Undo)
        </button>
        <button
          onClick={redo}
          disabled={future.length === 0}
          style={{
            padding: "6px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: theme.controlBg,
            color: theme.controlText,
            cursor: future.length === 0 ? "not-allowed" : "pointer",
            opacity: future.length === 0 ? 0.5 : 1,
            fontSize: 13,
            boxShadow: theme.buttonShadow,
          }}
        >
          다시 (Redo)
        </button>
      </div>

      <div style={{ marginTop: 16, fontSize: 13, color: theme.muted }}>
        격자에서 드래그해서 5분 칸 단위로 체크해봐
      </div>

      <div
        style={{
          marginTop: 12,
          border: `1px solid ${theme.border}`,
          borderRadius: 12,
          background: theme.card,
          padding: 12,
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>과목별 투자 비율</div>
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { key: "day", label: "하루" },
              { key: "week", label: "일주일" },
              { key: "month", label: "한 달" },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => setInvestRange(opt.key as "day" | "week" | "month")}
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: `1px solid ${theme.border}`,
                  background: investRange === opt.key ? theme.controlActiveBg : theme.controlBg,
                  color: investRange === opt.key ? theme.controlActiveText : theme.controlText,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {investSummary.totalMin <= 0 ? (
          <div style={{ fontSize: 12, color: theme.muted }}>선택한 기간에 기록이 없어.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {investSummary.rows.map((row) => (
              <div key={row.id} style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: row.color, display: "inline-block" }} />
                    <span>{row.label}</span>
                  </div>
                  <span>{row.pct.toFixed(1)}% ({fmtMin(row.min)})</span>
                </div>
                <div style={{ width: "100%", height: 8, borderRadius: 999, background: theme.cardSoft, overflow: "hidden" }}>
                  <div style={{ width: `${row.pct}%`, height: "100%", background: row.color }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 분 가늠용 헤더 */}
      <div style={{ display: "flex", gap: GRID_LABEL_GAP, alignItems: "end", marginTop: 8, overflowX: "visible" }}>
        <div style={{ width: TIME_LABEL_W }} />
        <div
          style={{
            width: GRID_W,
            display: "grid",
            gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
            fontSize: 11,
            opacity: 0.6,
            marginBottom: 4,
          }}
        >
          {Array.from({ length: COLS }).map((_, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              {(i + 1) * 5 % 60 === 0 ? 60 : (i + 1) * 5}
            </div>
          ))}
        </div>
      </div>

      {/* LEFT + RIGHT: 타임트래커 / 그래프 */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          gap: 24,
          alignItems: "flex-start",
          flexDirection: isNarrow ? "column" : "row",
          justifyContent: "flex-start",
        }}
      >
        {/* LEFT: 시간 라벨 + 격자 + (아래) 오늘 기록 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            width: isNarrow ? "100%" : "auto",
            flex: isNarrow ? "1 1 auto" : "0 0 auto",
          }}
        >
          {/* 시간 라벨 + 격자 */}
          <div style={{ display: "flex", gap: GRID_LABEL_GAP, overflowX: "visible", paddingBottom: isNarrow ? 4 : 0 }}>
            {/* 시간 라벨 */}
            <div style={{ width: TIME_LABEL_W, fontSize: 11, opacity: 0.75 }}>
              <div style={{ height: 8 }} />
              {Array.from({ length: ROWS }).map((_, r) => {
                const active = nowRow === r;
                return (
                  <div
                    key={r}
                    style={{
                      height: CELL,
                      display: "grid",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      paddingRight: 4,
                      lineHeight: 1,
                      transform: "translateY(-2px)",
                      fontWeight: isToday && active ? 700 : 400,
                      color: isToday && active ? "#ef4444" : "inherit",
                      opacity: active ? 1 : 0.65,
                    }}
                  >
                    {timeLabelForRow(r)}
                  </div>
                );
              })}
            </div>

            {/* 격자 */}
            <div
              style={{
                width: GRID_W,
                height: GRID_H,
                border: `1px solid ${theme.border}`,
                position: "relative",
                borderRadius: 12,
                overflow: "hidden",
                background: theme.card,
                boxShadow: `${theme.panelShadow}, ${theme.surfaceGlow}`,
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                overscrollBehavior: "contain",
                touchAction: "none",
              }}
              onMouseDown={(e) => {
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const idx = clampInputMinToNow(
                  snapIndexFromPoint(e.clientY, e.clientX, rect.top, rect.left)
                );

                const slotIndex = Math.floor(idx / 5);
                isErasingRef.current = (slotSegments[slotIndex]?.length ?? 0) > 0;

                isDraggingRef.current = false;
                dragStartRef.current = idx;
              }}
              onMouseMove={(e) => {
                if (dragStartRef.current == null) return;

                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const idx = clampInputMinToNow(
                  snapIndexFromPoint(e.clientY, e.clientX, rect.top, rect.left)
                );

                if (Math.abs(idx - dragStartRef.current) >= 5) {
                  if (!isDraggingRef.current) {
                    isDraggingRef.current = true;
                    setDragStart(dragStartRef.current);
                  }
                  setDragEnd(idx);
                }
              }}
              onMouseUp={() => {
                if (isDraggingRef.current) {
                  commitSelection();
                } else {
                  setDragStart(null);
                  setDragEnd(null);
                  isErasingRef.current = false;
                }

                dragStartRef.current = null;
                setTimeout(() => {
                  isDraggingRef.current = false;
                }, 0);
              }}
              onMouseLeave={() => {
                if (dragStartRef.current != null && isDraggingRef.current) {
                  commitSelection();
                }

                dragStartRef.current = null;
                isDraggingRef.current = false;
                isErasingRef.current = false;
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                if (e.touches.length > 1) {
                  isPinchingRef.current = true;
                  suppressClickUntilRef.current = Date.now() + 500;
                  dragStartRef.current = null;
                  isDraggingRef.current = false;
                  isErasingRef.current = false;
                  setDragStart(null);
                  setDragEnd(null);
                  return;
                }

                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const t = e.touches[0];
                const idx = clampInputMinToNow(
                  snapIndexFromPoint(t.clientY, t.clientX, rect.top, rect.left)
                );

                const slotIndex = Math.floor(idx / 5);
                isErasingRef.current = (slotSegments[slotIndex]?.length ?? 0) > 0;

                isDraggingRef.current = false;
                dragStartRef.current = idx;
              }}
              onTouchMove={(e) => {
                e.preventDefault();
                if (e.touches.length > 1 || isPinchingRef.current) {
                  isPinchingRef.current = true;
                  suppressClickUntilRef.current = Date.now() + 500;
                  dragStartRef.current = null;
                  isDraggingRef.current = false;
                  isErasingRef.current = false;
                  setDragStart(null);
                  setDragEnd(null);
                  return;
                }

                if (dragStartRef.current == null) return;

                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const t = e.touches[0];
                const idx = clampInputMinToNow(
                  snapIndexFromPoint(t.clientY, t.clientX, rect.top, rect.left)
                );

                if (Math.abs(idx - dragStartRef.current) >= 5) {
                  if (!isDraggingRef.current) {
                    isDraggingRef.current = true;
                    setDragStart(dragStartRef.current);
                  }
                  setDragEnd(idx);
                }
              }}
              onTouchEnd={() => {
                if (isPinchingRef.current) {
                  suppressClickUntilRef.current = Date.now() + 500;
                  dragStartRef.current = null;
                  isDraggingRef.current = false;
                  isErasingRef.current = false;
                  setDragStart(null);
                  setDragEnd(null);
                  isPinchingRef.current = false;
                  return;
                }

                if (isDraggingRef.current) {
                  commitSelection();
                } else {
                  setDragStart(null);
                  setDragEnd(null);
                  isErasingRef.current = false;
                }

                dragStartRef.current = null;
                isDraggingRef.current = false;
              }}
            >
              {/* 오늘만 현재 표시 */}
              {isToday && nowPos && (
                <div
                  style={{
                    position: "absolute",
                    top: nowPos.top,
                    left: 0,
                    width: GRID_W,
                    height: CELL,
                    background: "rgba(239,68,68,0.12)",
                    borderTop: "1px solid rgba(239,68,68,0.45)",
                    borderBottom: "1px solid rgba(239,68,68,0.45)",
                    pointerEvents: "none",
                    zIndex: 6,
                  }}
                />
              )}

              {isToday && nowPos && (
                <div
                  style={{
                    position: "absolute",
                    top: nowPos.top,
                    left: nowPos.left,
                    width: CELL,
                    height: CELL,
                    pointerEvents: "none",
                    zIndex: 7,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: "#ef4444",
                      boxShadow: "0 0 0 3px rgba(239,68,68,0.18)",
                    }}
                  />
                </div>
              )}

              <div
                key={`grid-${themeMode}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
                  gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`,
                }}
              >
                {slotSegments.map((segments, i) => {
                  const isSelected = selSlots ? i >= selSlots.s && i < selSlots.e : false;
                  const col = i % COLS;
                  const isHalfHourLine = col === 5;
                  const isLiveSlot =
                    !!liveTrackVisual && i >= liveTrackVisual.startSlot && i < liveTrackVisual.endSlot;
                  const hasFilled = segments.length > 0;

                  let composedSegments = segments;
                  let background = isSelected
                    ? "rgba(0,0,0,0.12)"
                    : buildSlotGradient(composedSegments, theme.card);
                  if (!isSelected && isLiveSlot) {
                    const slotStartMin = i * 5;
                    const slotEndMin = slotStartMin + 5;
                    const overlapStart = Math.max(slotStartMin, liveTrackVisual?.startMin ?? slotStartMin);
                    const overlapEnd = Math.min(slotEndMin, liveTrackVisual?.nowMin ?? slotStartMin);
                    if (overlapEnd > overlapStart) {
                      composedSegments = [
                        ...segments,
                        {
                          start: overlapStart - slotStartMin,
                          end: overlapEnd - slotStartMin,
                          color: liveTrackVisual?.color ?? "#2563eb",
                        },
                      ];
                      background = buildSlotGradient(composedSegments, theme.card);
                    }
                  }

                  return (
                    <div
                      key={i}
                      style={{
                        width: CELL,
                        height: CELL,
                        boxSizing: "border-box",
                        borderRight: isHalfHourLine
                          ? `2px solid ${theme.border}`
                          : `1px solid ${theme.borderSubtle}`,
                        borderBottom: `1px solid ${theme.borderSubtle}`,
                        background,
                      }}
                      title={labelFromIndex03Compact(i * 5)}
                      onClick={(e) => {
                        if (Date.now() < suppressClickUntilRef.current) return;
                        e.stopPropagation();
                        if (isToday && i * 5 > Math.floor(getCurrentMin03() / 5) * 5) return;

                        if (isDraggingRef.current) {
                          isErasingRef.current = false;
                          return;
                        }

                        if (selection) {
                          removeSelectionRange(selection.start, selection.dur);
                          setDragStart(null);
                          setDragEnd(null);

                          dragStartRef.current = null;
                          isDraggingRef.current = false;
                          return;
                        }

                        if (hasFilled) {
                          removeBlockAt(i * 5);
                          return;
                        }

                        if (!activeCategoryId) return;
                        pushHistory(structuredClone(actualBlocksRef.current));
                        setFuture([]);
                        setActualBlocks((prev) =>
                          applyBlock(prev, {
                            start: i * 5,
                            dur: 5,
                            categoryId: activeCategoryId,
                          })
                        );
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* 아래 카드: 오늘 기록 리스트 */}
          <div
            style={{
              width: "100%",
              maxWidth: isNarrow ? "none" : TIME_LABEL_W + GRID_LABEL_GAP + GRID_W,
              border: `1px solid ${theme.border}`,
              borderRadius: 14,
              background: theme.card,
              padding: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>오늘 기록</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={() => setShowTodayMemoBoard(true)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: `1px solid ${theme.border}`,
                    background: theme.controlBg,
                    color: theme.controlText,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  메모 한눈에 보기
                </button>
                <div style={{ fontSize: 12, opacity: 0.7 }}>총 {fmtMin(summary.totalMin)}</div>
              </div>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {categories
                .slice()
                .sort((a, b) => (summary.totals[b.id] ?? 0) - (summary.totals[a.id] ?? 0))
                .slice(0, 6)
                .map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: `1px solid ${theme.border}`,
                      background: theme.cardSoft,
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: c.color,
                        display: "inline-block",
                      }}
                    />
                    <span style={{ fontWeight: 700 }}>{c.label}</span>
                    <span style={{ opacity: 0.7 }}>{fmtMin(summary.totals[c.id] ?? 0)}</span>
                  </div>
                ))}
            </div>

            {/* 한 줄 메모 */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>과목별 한 줄 메모</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => setShowAllNotes((v) => !v)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: `1px solid ${theme.border}`,
                      background: showAllNotes ? theme.controlActiveBg : theme.controlBg,
                      color: showAllNotes ? theme.controlActiveText : theme.controlText,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {showAllNotes ? "전체보기" : "오늘 한 과목만"}
                  </button>

                  <button
                    onClick={() => setShowNotes((v) => !v)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: `1px solid ${theme.border}`,
                      background: theme.controlBg,
                      color: theme.controlText,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {showNotes ? "접기" : "펼치기"}
                  </button>
                </div>
              </div>

              {showNotes && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {(showAllNotes
                    ? categories
                    : categories.filter((c) => {
                        const hasTime = (summary.totals[c.id] ?? 0) > 0;
                        const hasMemo = (notesByCategory[c.id] ?? "").trim().length > 0;
                        return hasTime || hasMemo;
                      })
                  ).map((c) => (
                    <div
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ width: 120, display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            background: c.color,
                            display: "inline-block",
                          }}
                        />
                        <span style={{ fontSize: 12, fontWeight: 800 }}>{c.label}</span>
                      </div>

                      <input
                        value={(notesByCategory[c.id] ?? "").slice(0, 50)}
                        maxLength={50}
                        placeholder="예: 22번 오답 / 단어 40개"
                        onChange={(e) => {
                          const v = e.target.value;
                          setNotesByCategory((prev) => ({ ...prev, [c.id]: v }));
                        }}
                        style={{
                          flex: 1,
                          minWidth: 180,
                          width: isNarrow ? "100%" : undefined,
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: `1px solid ${theme.border}`,
                          background: theme.cardSoft,
                          color: theme.text,
                          fontSize: 12,
                          outline: "none",
                        }}
                      />

                      <div style={{ width: 52, textAlign: "right", fontSize: 11, opacity: 0.55 }}>
                        {(notesByCategory[c.id] ?? "").length}/50
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div
              style={{
                marginTop: 12,
                borderTop: `1px solid ${theme.borderSubtle}`,
                paddingTop: 10,
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              {actualBlocks.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  아직 기록이 없어. 격자에서 드래그로 입력해봐.
                </div>
              ) : (
                actualBlocks
                  .slice()
                  .sort((a, b) => a.start - b.start)
                  .map((b) => {
                    const cat = categories.find((c) => c.id === b.categoryId);
                    const start = labelFromIndex03Sec(b.start);
                    const end = labelFromIndex03Sec(b.start + b.dur);
                    const blockNote = notesByBlock[b.id] ?? "";
                    return (
                      <div
                        key={b.id}
                        style={{
                          display: "grid",
                          gap: 8,
                          padding: "10px 8px",
                          borderRadius: 10,
                          border: `1px solid ${theme.borderSubtle}`,
                          background: theme.cardSoft,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: 999,
                                background: cat?.color ?? "#111827",
                                display: "inline-block",
                              }}
                            />
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <div style={{ fontSize: 12, fontWeight: 800, color: theme.text }}>
                                {cat?.label ?? "(알 수 없음)"}
                              </div>
                              <div style={{ fontSize: 12, color: theme.muted }}>
                                {start} ~ {end}
                              </div>
                              {(() => {
                                const note = (notesByCategory[b.categoryId] ?? "").trim();
                                if (!note) return null;
                                return (
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                                    <span style={{ fontWeight: 800, opacity: 0.9 }}>과목 메모:</span> {note}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                            <div style={{ fontSize: 12, fontWeight: 800 }}>{fmtDurSec(b.dur)}</div>
                            <button
                              onClick={() => setOpenBlockMemoId((prev) => (prev === b.id ? null : b.id))}
                              style={{
                                padding: "4px 8px",
                                borderRadius: 8,
                                border: `1px solid ${theme.border}`,
                                background: theme.controlBg,
                                color: theme.controlText,
                                cursor: "pointer",
                                fontSize: 11,
                              }}
                            >
                              {openBlockMemoId === b.id ? "메모 닫기" : "메모"}
                            </button>
                          </div>
                        </div>
                        {openBlockMemoId === b.id && (
                          <input
                            value={blockNote}
                            maxLength={120}
                            placeholder="이 타임로그에서 한 내용 메모"
                            onChange={(e) => {
                              const v = e.target.value;
                              setNotesByBlock((prev) => ({ ...prev, [b.id]: v }));
                            }}
                            style={{
                              width: "100%",
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: `1px solid ${theme.border}`,
                              background: theme.card,
                              color: theme.text,
                              fontSize: 12,
                              outline: "none",
                            }}
                          />
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: 그래프 영역 */}
        <div
          style={{
            flex: isNarrow ? "1 1 auto" : "1 1 640px",
            minWidth: isNarrow ? 0 : 360,
            maxWidth: "100%",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 24,
            position: "static",
            alignSelf: "flex-start",
          }}
        >


          {/* =======================
              A. 총 공부시간 추이
             ======================= */}
          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 14,
              background: theme.card,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>
                {totalTrendMode === "selected" && categories.find((c) => c.id === activeCategoryId)
                  ? `${categories.find((c) => c.id === activeCategoryId)?.label} 추이`
                  : "총 공부시간 추이"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setTotalTrendMode("total")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: `1px solid ${theme.border}`,
                    background: totalTrendMode === "total" ? theme.controlActiveBg : theme.controlBg,
                    color: totalTrendMode === "total" ? theme.controlActiveText : theme.controlText,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  전체
                </button>
                <button
                  onClick={() => setTotalTrendMode("selected")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: `1px solid ${theme.border}`,
                    background: totalTrendMode === "selected" ? theme.controlActiveBg : theme.controlBg,
                    color: totalTrendMode === "selected" ? theme.controlActiveText : theme.controlText,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  선택 과목만
                </button>
              </div>
            </div>

            {/* 기간 선택 */}
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  onClick={() => setTrendDays(d as 7 | 14 | 30)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: `1px solid ${theme.border}`,
                    background: trendDays === d ? theme.controlActiveBg : theme.controlBg,
                    color: trendDays === d ? theme.controlActiveText : theme.controlText,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {d}일
                </button>
              ))}
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {categories.map((c) => {
                const included = studyIncludedCategoryIds[c.id] !== false;
                return (
                  <button
                    key={`study-inc-${c.id}`}
                    onClick={() =>
                      setStudyIncludedCategoryIds((prev) => ({
                        ...prev,
                        [c.id]: !(prev[c.id] !== false),
                      }))
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: `1px solid ${theme.border}`,
                      background: included ? theme.controlActiveBg : theme.controlBg,
                      color: included ? theme.controlActiveText : theme.controlText,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                    title={included ? "총 공부시간에 포함됨" : "총 공부시간에서 제외됨"}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: c.color,
                        border: "1px solid rgba(0,0,0,0.18)",
                      }}
                    />
                    {included ? "✓ " : ""}{c.label}
                  </button>
                );
              })}
            </div>

            {(() => {
              const W = 560;
              const H = 320;
              const padL = 50;
              const padR = 20;
              const padT = 20;
              const padB = 40;
              const innerW = W - padL - padR;
              const innerH = H - padT - padB;

              const days = trend.totalsByDay;
              const n = days.length;
              const selectedCategory = categories.find((c) => c.id === activeCategoryId);
              const values = days.map((d) =>
                totalTrendMode === "selected" && selectedCategory
                  ? (d.totals[selectedCategory.id] ?? 0)
                  : d.totalMin
              );
              const yMax = Math.max(1, ...values);

              const xStep = n <= 1 ? 0 : innerW / (n - 1);
              const xAt = (i: number) => padL + i * xStep;
              const y = (v: number) => padT + innerH - (v / yMax) * innerH;

              const points = values.map((v, i) => `${xAt(i)},${y(v)}`).join(" ");

              const tooltip =
                totalHoverIndex == null
                  ? null
                  : {
                      day: days[totalHoverIndex]?.day,
                      value: values[totalHoverIndex] ?? 0,
                      x: xAt(totalHoverIndex),
                    };
              const tooltipLeft = tooltip ? clamp(tooltip.x - 90, 8, W - 180) : 0;

              return (
                <div style={{ marginTop: 16, position: "relative", overflow: "hidden" }}>
                  <svg
                    width="100%"
                    height={H}
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="xMidYMid meet"
                    style={{ display: "block" }}
                    onMouseEnter={() => setHoverIndex(null)}
                    onMouseLeave={() => setTotalHoverIndex(null)}
                    onMouseMove={(e) => {
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const mx = ((e.clientX - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;

                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setTotalHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                    onTouchStart={(e) => {
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const tx = e.touches[0]?.clientX;
                      if (typeof tx !== "number") return;
                      const mx = ((tx - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;
                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setTotalHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                    onTouchMove={(e) => {
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const tx = e.touches[0]?.clientX;
                      if (typeof tx !== "number") return;
                      const mx = ((tx - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;
                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setTotalHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                  >
                  {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
                    const v = yMax * p;
                    const yy = y(v);
                    return (
                      <g key={i}>
                        <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke={theme.grid} />
                        <text x={10} y={yy + 4} fontSize={11} fill={theme.axis}>
                          {fmtMin(Math.round(v))}
                        </text>
                      </g>
                    );
                  })}

                  <polyline points={points} fill="none" stroke={theme.text} strokeWidth={3} />

                  {values.map((v, i) => (
                    <circle key={i} cx={xAt(i)} cy={y(v)} r={4} fill={theme.text} />
                  ))}

                  {/* 총 추이도 날짜 축이 보이도록 축/라벨 고정 */}
                  <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={theme.grid} />
                  {days.map((d, i) => {
                    const show = n <= 9 ? true : i === 0 || i === Math.floor((n - 1) / 2) || i === n - 1;
                    if (!show) return null;
                    return (
                      <text
                        key={d.day}
                        x={xAt(i)}
                        y={H - 16}
                        fontSize={11}
                        fill={theme.axis}
                        textAnchor="middle"
                      >
                        {fmtDayLabel(d.day)}
                      </text>
                    );
                  })}

                  {totalHoverIndex != null && (
                    <g>
                      <line
                        x1={xAt(totalHoverIndex)}
                        x2={xAt(totalHoverIndex)}
                        y1={padT}
                        y2={H - padB}
                        stroke={theme.axis}
                        strokeDasharray="4 4"
                      />
                      <circle
                        cx={xAt(totalHoverIndex)}
                        cy={y(values[totalHoverIndex] ?? 0)}
                        r={5}
                        fill={theme.controlActiveBg}
                      />
                    </g>
                  )}
                  </svg>

                  {tooltip && (
                    <div
                      style={{
                        position: "absolute",
                        top: 6,
                        left: tooltipLeft,
                        width: 180,
                        border: `1px solid ${theme.border}`,
                        background: themeMode === "dark" ? "rgba(17,24,39,0.97)" : "rgba(255,255,255,0.98)",
                        borderRadius: 12,
                        padding: 10,
                        boxShadow: "0 8px 20px rgba(0,0,0,0.08)",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 12 }}>{fmtDayLabel(tooltip.day ?? day)}</div>
                      <div style={{ marginTop: 6, fontSize: 12, color: theme.muted }}>
                        {totalTrendMode === "selected" ? "선택 과목" : "총 공부시간"}
                      </div>
                      <div style={{ marginTop: 4, fontWeight: 800, fontSize: 13 }}>{fmtMin(tooltip.value)}</div>
                    </div>
                  )}
                </div>
              );
            })()}
            {(() => {
              const days = trend.totalsByDay;
              const selectedCategory = categories.find((c) => c.id === activeCategoryId);
              const values = days.map((d) =>
                totalTrendMode === "selected" && selectedCategory
                  ? (d.totals[selectedCategory.id] ?? 0)
                  : d.totalMin
              );
              const idx = totalHoverIndex != null ? totalHoverIndex : Math.max(0, days.length - 1);
              const focusDay = days[idx];
              if (!focusDay) return null;
              return (
                <div style={{ marginTop: 8, fontSize: 12, color: theme.muted }}>
                  {fmtDayLabel(focusDay.day)} · {totalTrendMode === "selected" ? "선택 과목" : "총 공부시간"} {fmtMin(values[idx] ?? 0)}
                </div>
              );
            })()}
          </div>

          {/* =======================
              B. 과목별 공부시간 추이
             ======================= */}
          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 14,
              background: theme.card,
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 16 }}>과목별 공부시간 추이</div>
            <div style={{ marginTop: 8, fontSize: 12, color: theme.muted }}>
              아래 범례를 클릭하면 과목별 라인을 숨기거나 다시 볼 수 있어
            </div>

            {(() => {
              const W = 560;
              const H = 360;
              const padL = 50;
              const padR = 20;
              const padT = 20;
              const padB = 44;
              const innerW = W - padL - padR;
              const innerH = H - padT - padB;

              const days = trend.totalsByDay;
              const n = days.length;

              const visibleCats = categories.filter((c) => !hiddenCategoryIds[c.id]);
              const catsForScale = visibleCats.length ? visibleCats : categories;
              const yCandidates = days.flatMap((d) => catsForScale.map((c) => d.totals[c.id] ?? 0));
              const yMax = Math.max(1, ...yCandidates);

              const xStep = n <= 1 ? 0 : innerW / (n - 1);
              const xAt = (i: number) => padL + i * xStep;
              const y = (v: number) => padT + innerH - (v / yMax) * innerH;

              const tooltip =
                hoverIndex == null
                  ? null
                  : {
                      day: days[hoverIndex]?.day,
                      totals: days[hoverIndex]?.totals ?? {},
                      x: xAt(hoverIndex),
                    };

              const tooltipLeft = tooltip ? clamp(tooltip.x - 120, 8, W - 240) : 0;

              return (
                <div
                  style={{
                    marginTop: 14,
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  {/* 범례(카테고리 칩) */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    {categories.map((c) => {
                      const hidden = !!hiddenCategoryIds[c.id];
                      return (
                        <button
                          key={c.id}
                          onClick={() => toggleCategoryVisible(c.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 10px",
                            borderRadius: 999,
                            border: `1px solid ${theme.border}`,
                            background: hidden ? theme.controlBg : theme.controlActiveBg,
                            color: hidden ? theme.controlText : theme.controlActiveText,
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                          title={hidden ? "표시" : "숨김"}
                        >
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              background: c.color,
                              display: "inline-block",
                              opacity: hidden ? 0.35 : 1,
                            }}
                          />
                          {c.label}
                        </button>
                      );
                    })}
                  </div>

                  <svg
                    width="100%"
                    height={H}
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseEnter={() => setTotalHoverIndex(null)}
                    onMouseLeave={() => setHoverIndex(null)}
                    onMouseMove={(e) => {
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const mx = ((e.clientX - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;

                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                    onTouchStart={(e) => {
                      setTotalHoverIndex(null);
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const tx = e.touches[0]?.clientX;
                      if (typeof tx !== "number") return;
                      const mx = ((tx - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;
                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                    onTouchMove={(e) => {
                      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                      const tx = e.touches[0]?.clientX;
                      if (typeof tx !== "number") return;
                      const mx = ((tx - rect.left) / rect.width) * W;
                      if (mx < padL || mx > W - padR) return;
                      const idx = Math.round((mx - padL) / (xStep || 1));
                      setHoverIndex(Math.max(0, Math.min(idx, n - 1)));
                    }}
                    style={{ display: "block" }}
                  >
                    {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
                      const v = yMax * p;
                      const yy = y(v);
                      return (
                        <g key={i}>
                          <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke={theme.grid} />
                          <text x={10} y={yy + 4} fontSize={11} fill={theme.axis}>
                            {fmtMin(Math.round(v))}
                          </text>
                        </g>
                      );
                    })}

                    {days.map((d, i) => {
                      const show = n <= 7 ? true : i === 0 || i === n - 1 || i % 2 === 0;
                      if (!show) return null;
                      return (
                        <text
                          key={d.day}
                          x={xAt(i)}
                          y={H - 16}
                          fontSize={11}
                          fill={theme.axis}
                          textAnchor="middle"
                        >
                          {fmtDayLabel(d.day)}
                        </text>
                      );
                    })}

                    {categories
                      .filter((c) => !hiddenCategoryIds[c.id])
                      .map((c) => {
                        const pts = days
                          .map((d, i) => {
                            const v = d.totals[c.id] ?? 0;
                            return `${xAt(i)},${y(v)}`;
                          })
                          .join(" ");

                        return (
                          <polyline
                            key={c.id}
                            points={pts}
                            fill="none"
                            stroke={c.color}
                            strokeWidth={3}
                          />
                        );
                      })}

                    {hoverIndex != null && (
                      <g>
                        <line
                          x1={xAt(hoverIndex)}
                          x2={xAt(hoverIndex)}
                          y1={padT}
                          y2={H - padB}
                          stroke={theme.axis}
                          strokeDasharray="4 4"
                        />
                        {categories
                          .filter((c) => !hiddenCategoryIds[c.id])
                          .map((c) => {
                            const v = days[hoverIndex]?.totals[c.id] ?? 0;
                            return (
                              <circle
                                key={c.id}
                                cx={xAt(hoverIndex)}
                                cy={y(v)}
                                r={4}
                                fill={c.color}
                              />
                            );
                          })}
                      </g>
                    )}
                  </svg>

                  {tooltip && (
                    <div
                      style={{
                        position: "absolute",
                        top: 6,
                        left: tooltipLeft,
                        width: 240,
                        border: `1px solid ${theme.border}`,
                        background: themeMode === "dark" ? "rgba(17,24,39,0.97)" : "rgba(255,255,255,0.98)",
                        borderRadius: 12,
                        padding: 10,
                        boxShadow: "0 8px 20px rgba(0,0,0,0.08)",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 8 }}>
                        {fmtDayLabel(tooltip.day)}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {categories.map((c) => {
                          const hidden = !!hiddenCategoryIds[c.id];
                          const v = tooltip.totals[c.id] ?? 0;
                          return (
                            <div
                              key={c.id}
                              style={{
                                display: hidden ? "none" : "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 10,
                                fontSize: 12,
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: 999,
                                    background: c.color,
                                    display: "inline-block",
                                  }}
                                />
                                <span style={{ color: theme.text }}>{c.label}</span>
                              </div>
                              <span style={{ color: theme.text, fontWeight: 700 }}>{fmtMin(v)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {showTodayMemoBoard && (
        <div
          onClick={() => setShowTodayMemoBoard(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 120,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(980px, 100%)",
              maxHeight: "86vh",
              overflow: "auto",
              border: `1px solid ${theme.border}`,
              borderRadius: 16,
              background: theme.card,
              color: theme.text,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>오늘 메모 한눈에 보기</div>
                <div style={{ marginTop: 4, fontSize: 12, color: theme.muted }}>{day}</div>
              </div>
              <button
                onClick={() => setShowTodayMemoBoard(false)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.border}`,
                  background: theme.controlBg,
                  color: theme.controlText,
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                닫기
              </button>
            </div>

            <div style={{ marginTop: 14, fontWeight: 800, fontSize: 13 }}>과목별 한 줄 메모</div>
            {todayMemoBoard.categoryNotes.length === 0 ? (
              <div style={{ marginTop: 8, fontSize: 12, color: theme.muted }}>작성된 과목 메모가 없습니다.</div>
            ) : (
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr", gap: 8 }}>
                {todayMemoBoard.categoryNotes.map((item) => (
                  <div
                    key={item.categoryId}
                    style={{
                      border: `1px solid ${theme.borderSubtle}`,
                      borderRadius: 10,
                      background: theme.cardSoft,
                      padding: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: item.color, display: "inline-block" }} />
                      {item.label}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45 }}>{item.note}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16, fontWeight: 800, fontSize: 13 }}>타임로그 메모</div>
            {todayMemoBoard.timelineNotes.length === 0 ? (
              <div style={{ marginTop: 8, fontSize: 12, color: theme.muted }}>작성된 타임로그 메모가 없습니다.</div>
            ) : (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {todayMemoBoard.timelineNotes.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      border: `1px solid ${theme.borderSubtle}`,
                      borderRadius: 10,
                      background: theme.cardSoft,
                      padding: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 999, background: item.color, display: "inline-block" }} />
                        {item.label}
                      </div>
                      <div style={{ color: theme.muted }}>{item.range} · {item.duration}</div>
                    </div>
                    {item.categoryNote && (
                      <div style={{ marginTop: 6, fontSize: 12, color: theme.muted }}>
                        과목 메모: {item.categoryNote}
                      </div>
                    )}
                    {item.blockNote && (
                      <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.45 }}>{item.blockNote}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => window.location.reload()}
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 50,
          padding: "10px 14px",
          borderRadius: 999,
          border: `1px solid ${theme.border}`,
          background: theme.controlBg,
          color: theme.controlText,
          cursor: "pointer",
          fontSize: 13,
          boxShadow: theme.buttonShadow,
        }}
      >
        새로고침
      </button>
    </div>
  );
}
