"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type PainLog = {
  id: string;
  occurredAt: string;
  intensity: number;
  emotion: string;
  situation: string;
  triggerText: string;
  bodySignal: string;
  autoNote: string | null;
};

type FormState = {
  occurredAt: string;
  intensity: number;
  emotion: string;
  situation: string;
  triggerText: string;
  bodySignal: string;
  autoNote: string;
};

const LOCAL_LOGS_KEY = "paintracker_local_logs_v1";

function nowLocalValue() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function loadLocalLogs(): PainLog[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(LOCAL_LOGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PainLog[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveLocalLogs(logs: PainLog[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_LOGS_KEY, JSON.stringify(logs.slice(0, 100)));
}

export default function NewAppPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<PainLog[]>([]);
  const [form, setForm] = useState<FormState>({
    occurredAt: nowLocalValue(),
    intensity: 5,
    emotion: "",
    situation: "",
    triggerText: "",
    bodySignal: "",
    autoNote: "",
  });

  async function fetchLogs(accessToken: string) {
    const res = await fetch("/api/new-app/pain-logs?limit=20", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("기록을 불러오지 못했습니다.");
    const body = (await res.json()) as { logs?: PainLog[] };
    setLogs(Array.isArray(body.logs) ? body.logs : []);
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        const { data } = await supabase.auth.getUser();
        if (!data.user) {
          router.replace("/login");
          return;
        }
        const session = await supabase.auth.getSession();
        const accessToken = session.data.session?.access_token ?? null;
        if (!accessToken) {
          router.replace("/login");
          return;
        }
        if (!cancelled) {
          setToken(accessToken);
          try {
            await fetchLogs(accessToken);
          } catch (err) {
            const local = loadLocalLogs();
            setLogs(local);
            setNotice("서버 기록 조회에 실패해 로컬 기록을 표시 중입니다.");
            throw err;
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "초기화 중 오류가 발생했습니다.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);

    const localFallbackSave = () => {
      const localLog: PainLog = {
        id: globalThis.crypto?.randomUUID?.() ?? `local_${Date.now()}`,
        occurredAt: new Date(form.occurredAt).toISOString(),
        intensity: form.intensity,
        emotion: form.emotion.trim(),
        situation: form.situation.trim(),
        triggerText: form.triggerText.trim(),
        bodySignal: form.bodySignal.trim(),
        autoNote: form.autoNote.trim() || null,
      };
      const local = [localLog, ...loadLocalLogs()];
      saveLocalLogs(local);
      setLogs(local);
      setNotice("서버 저장 실패로 로컬에 임시 저장했습니다.");
      setForm({
        occurredAt: nowLocalValue(),
        intensity: 5,
        emotion: "",
        situation: "",
        triggerText: "",
        bodySignal: "",
        autoNote: "",
      });
    };

    try {
      const payload = {
        occurredAt: new Date(form.occurredAt).toISOString(),
        intensity: form.intensity,
        emotion: form.emotion.trim(),
        situation: form.situation.trim(),
        triggerText: form.triggerText.trim(),
        bodySignal: form.bodySignal.trim(),
        autoNote: form.autoNote.trim(),
      };
      if (!token) {
        localFallbackSave();
        return;
      }
      const res = await fetch("/api/new-app/pain-logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        const message = [body?.error, body?.detail].filter(Boolean).join(" | ");
        throw new Error(message || "저장에 실패했습니다.");
      }
      await fetchLogs(token);
      setForm({
        occurredAt: nowLocalValue(),
        intensity: 5,
        emotion: "",
        situation: "",
        triggerText: "",
        bodySignal: "",
        autoNote: "",
      });
    } catch (err) {
      localFallbackSave();
      setError(err instanceof Error ? err.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function syncLocalToServer() {
    if (!token) {
      setError("로그인 세션이 없어 동기화할 수 없습니다.");
      return;
    }
    const local = loadLocalLogs();
    if (local.length === 0) {
      setNotice("동기화할 로컬 기록이 없습니다.");
      return;
    }

    setSyncing(true);
    setError(null);
    setNotice(null);
    let success = 0;
    let failed = 0;

    try {
      for (const item of [...local].reverse()) {
        const res = await fetch("/api/new-app/pain-logs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            occurredAt: item.occurredAt,
            intensity: item.intensity,
            emotion: item.emotion,
            situation: item.situation,
            triggerText: item.triggerText,
            bodySignal: item.bodySignal,
            autoNote: item.autoNote ?? "",
          }),
        });
        if (res.ok) success += 1;
        else failed += 1;
      }

      if (failed === 0) {
        saveLocalLogs([]);
        await fetchLogs(token);
        setNotice(`로컬 기록 ${success}건을 서버에 동기화했습니다.`);
      } else {
        setNotice(`동기화 완료: 성공 ${success}건, 실패 ${failed}건`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "동기화 중 오류가 발생했습니다.");
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return <div style={{ maxWidth: 920, margin: "40px auto", padding: 20 }}>로딩 중...</div>;
  }

  return (
    <div style={{ maxWidth: 920, margin: "40px auto", padding: 20, display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0 }}>고통 기록</h1>
      <p style={{ margin: 0, color: "#555" }}>
        지금 느끼는 고통을 기록하고, 다음 단계 성찰/행동으로 연결하세요.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={syncLocalToServer}
          disabled={syncing}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid #0f172a",
            background: "#fff",
            color: "#0f172a",
            cursor: "pointer",
          }}
        >
          {syncing ? "동기화 중..." : `로컬 기록 동기화 (${loadLocalLogs().length})`}
        </button>
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 16,
          display: "grid",
          gap: 10,
          background: "#fff",
        }}
      >
        <label style={{ display: "grid", gap: 6 }}>
          <span>시각</span>
          <input
            type="datetime-local"
            value={form.occurredAt}
            onChange={(e) => setForm((p) => ({ ...p, occurredAt: e.target.value }))}
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>강도 (1~10)</span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={form.intensity}
            onChange={(e) => setForm((p) => ({ ...p, intensity: Number(e.target.value) }))}
          />
          <strong>{form.intensity}</strong>
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>감정</span>
          <input
            value={form.emotion}
            onChange={(e) => setForm((p) => ({ ...p, emotion: e.target.value }))}
            placeholder="예: 불안, 분노, 수치심"
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>상황</span>
          <textarea
            value={form.situation}
            onChange={(e) => setForm((p) => ({ ...p, situation: e.target.value }))}
            rows={3}
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>트리거</span>
          <textarea
            value={form.triggerText}
            onChange={(e) => setForm((p) => ({ ...p, triggerText: e.target.value }))}
            rows={2}
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>몸 반응</span>
          <textarea
            value={form.bodySignal}
            onChange={(e) => setForm((p) => ({ ...p, bodySignal: e.target.value }))}
            rows={2}
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>추가 메모 (선택)</span>
          <textarea
            value={form.autoNote}
            onChange={(e) => setForm((p) => ({ ...p, autoNote: e.target.value }))}
            rows={2}
          />
        </label>

        {error && <div style={{ color: "#b91c1c" }}>{error}</div>}
        {notice && <div style={{ color: "#0f766e" }}>{notice}</div>}

        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #111827",
            background: "#111827",
            color: "#fff",
            cursor: "pointer",
            width: 160,
          }}
        >
          {saving ? "저장 중..." : "고통 기록 저장"}
        </button>
      </form>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h2 style={{ marginTop: 0, marginBottom: 10, fontSize: 18 }}>최근 기록</h2>
        {logs.length === 0 && <p style={{ margin: 0, color: "#666" }}>아직 기록이 없습니다.</p>}
        <div style={{ display: "grid", gap: 10 }}>
          {logs.map((log) => (
            <article
              key={log.id}
              style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, display: "grid", gap: 6 }}
            >
              <div style={{ fontSize: 13, color: "#666" }}>
                {new Date(log.occurredAt).toLocaleString()} · 강도 {log.intensity}
              </div>
              <div>
                <strong>감정:</strong> {log.emotion}
              </div>
              <div>
                <strong>상황:</strong> {log.situation}
              </div>
              <div>
                <strong>트리거:</strong> {log.triggerText}
              </div>
              <div>
                <strong>몸 반응:</strong> {log.bodySignal}
              </div>
              {log.autoNote && (
                <div>
                  <strong>메모:</strong> {log.autoNote}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
