"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "signup") {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { name },
          },
        });
        if (signUpError) throw signUpError;

        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        const bootstrapRes = await fetch("/api/bootstrap", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!bootstrapRes.ok) {
          throw new Error("프로필 생성에 실패했어요. 다시 시도해 주세요.");
        }

        router.replace("/pending");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;

        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        const meRes = await fetch("/api/me", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (meRes.ok) {
          const body = await meRes.json();
          if (body.user?.status === "APPROVED") {
            router.replace("/day");
            return;
          }
        }
        router.replace("/pending");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했어요.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "64px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>
        {mode === "signup" ? "회원가입" : "로그인"}
      </h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        {mode === "signup"
          ? "가입 신청 후 관리자가 승인하면 사용할 수 있어요."
          : "승인된 계정으로 로그인하세요."}
      </p>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        {mode === "signup" && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="이름"
            autoComplete="name"
            required
            style={{ padding: 10 }}
          />
        )}
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="이메일"
          type="email"
          autoComplete="email"
          required
          style={{ padding: 10 }}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          style={{ padding: 10 }}
        />

        {error && <div style={{ color: "#c00" }}>{error}</div>}

        <button
          type="submit"
          disabled={loading}
          style={{ padding: 12, fontWeight: 600 }}
        >
          {loading ? "처리 중..." : mode === "signup" ? "가입 신청" : "로그인"}
        </button>
      </form>

      <button
        onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
        style={{
          marginTop: 16,
          background: "transparent",
          border: "none",
          color: "#555",
          cursor: "pointer",
        }}
      >
        {mode === "signup"
          ? "이미 계정이 있어요"
          : "계정이 없어서 가입하고 싶어요"}
      </button>
    </div>
  );
}
