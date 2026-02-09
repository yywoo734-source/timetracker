"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Category = { id: string; label: string; color: string };

const CATEGORIES_KEY = "timetracker_categories_v1";

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `id_${Math.random().toString(16).slice(2)}`;
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

function saveCategories(categories: Category[]) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
}

export default function SetupPage() {
  const router = useRouter();

  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const existing = loadCategories();
    if (existing.length > 0) {
      setCategories(existing);
    } else {
      // 첫 진입 기본값(원하면 지워도 됨)
      setCategories([
        { id: uuid(), label: "공부", color: "#4f46e5" },
        { id: uuid(), label: "일", color: "#0284c7" },
        { id: uuid(), label: "운동", color: "#16a34a" },
        { id: uuid(), label: "휴식", color: "#f59e0b" },
        { id: uuid(), label: "이동", color: "#6b7280" },
      ]);
    }
    setLoaded(true);
  }, []);

  const canSave = useMemo(() => {
    if (!loaded) return false;
    if (categories.length === 0) return false;
    // 라벨 비어있으면 저장 막기
    return categories.every((c) => c.label.trim().length > 0);
  }, [categories, loaded]);

  function addCategory() {
    setCategories((prev) => [
      ...prev,
      { id: uuid(), label: `항목 ${prev.length + 1}`, color: "#111827" },
    ]);
  }

  function removeCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  }

  function updateCategory(id: string, patch: Partial<Category>) {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function onSave() {
    const cleaned = categories.map((c) => ({
      ...c,
      label: c.label.trim(),
    }));
    saveCategories(cleaned);
    router.push("/day");
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>TimeTracker 설정</h1>
      <p style={{ marginTop: 6, opacity: 0.7 }}>
        항목(카테고리) 이름과 색을 원하는 만큼 추가하세요.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={addCategory} style={btn()}>
          + 항목 추가
        </button>
        <button
          onClick={onSave}
          disabled={!canSave}
          style={btn(canSave ? "primary" : "disabled")}
        >
          저장하고 시작하기
        </button>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #eee", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 80px", padding: 10, background: "#fafafa", fontSize: 13, fontWeight: 700 }}>
          <div>이름</div>
          <div>색</div>
          <div />
        </div>

        {categories.map((c) => (
          <div
            key={c.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px 80px",
              gap: 8,
              padding: 10,
              borderTop: "1px solid #eee",
              alignItems: "center",
            }}
          >
            <input
              value={c.label}
              onChange={(e) => updateCategory(c.id, { label: e.target.value })}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                outline: "none",
              }}
            />

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="color"
                value={c.color}
                onChange={(e) => updateCategory(c.id, { color: e.target.value })}
                style={{ width: 44, height: 32, padding: 0, border: "none", background: "transparent" }}
              />
              <div style={{ fontSize: 12, opacity: 0.7 }}>{c.color}</div>
            </div>

            <button onClick={() => removeCategory(c.id)} style={btn("danger")}>
              삭제
            </button>
          </div>
        ))}
      </div>

      {!canSave && (
        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.7 }}>
          저장하려면 모든 항목 이름이 비어있지 않아야 해.
        </div>
      )}
    </div>
  );
}

function btn(kind: "primary" | "danger" | "disabled" | "default" = "default") {
  const base: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#ddd",
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
  };
  if (kind === "primary") return { ...base, background: "#111827", color: "#fff", borderColor: "#111827" };
  if (kind === "danger") return { ...base, background: "#fff", color: "#b91c1c", borderColor: "#f1c4c4" };
  if (kind === "disabled") return { ...base, background: "#f3f4f6", color: "#9ca3af", cursor: "not-allowed" };
  return base;
}
