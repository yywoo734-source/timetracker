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

type Assignment = {
  id: string;
  admin: User;
  student: User;
};

export default function AdminPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<User | null>(null);
  const [pending, setPending] = useState<User[]>([]);
  const [admins, setAdmins] = useState<User[]>([]);
  const [students, setStudents] = useState<User[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [adminId, setAdminId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function authHeaders(token: string | undefined) {
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  async function loadAll(token: string | undefined) {
    setError(null);
    const [pendingRes, adminsRes, studentsRes, assignmentsRes] = await Promise.all([
      fetch("/api/admin/users?status=PENDING", { headers: authHeaders(token) }),
      fetch("/api/admin/users?role=ADMIN&status=APPROVED", { headers: authHeaders(token) }),
      fetch("/api/admin/users?role=STUDENT&status=APPROVED", { headers: authHeaders(token) }),
      fetch("/api/admin/assignments", { headers: authHeaders(token) }),
    ]);

    if (!pendingRes.ok || !adminsRes.ok || !studentsRes.ok || !assignmentsRes.ok) {
      setError("데이터를 불러오지 못했어요.");
      return;
    }

    const pendingData = await pendingRes.json();
    const adminsData = await adminsRes.json();
    const studentsData = await studentsRes.json();
    const assignmentsData = await assignmentsRes.json();

    setPending(pendingData.users ?? []);
    setAdmins(adminsData.users ?? []);
    setStudents(studentsData.users ?? []);
    setAssignments(assignmentsData.assignments ?? []);
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

      const meRes = await fetch("/api/me", {
        headers: authHeaders(token),
      });
      if (!meRes.ok) {
        router.replace("/login");
        return;
      }
      const body = await meRes.json();
      if (body.user?.role !== "SUPER_ADMIN") {
        setMe(body.user ?? null);
        setLoading(false);
        return;
      }
      if (!cancelled) {
        setMe(body.user);
        await loadAll(token);
        setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function approveUser(userId: string, role: "STUDENT" | "ADMIN") {
    setError(null);
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    const res = await fetch("/api/admin/users/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ userId, status: "APPROVED", role }),
    });
    if (!res.ok) {
      setError("승인 실패");
      return;
    }
    await loadAll(token);
  }

  async function rejectUser(userId: string) {
    setError(null);
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    const res = await fetch("/api/admin/users/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ userId, status: "REJECTED", role: "STUDENT" }),
    });
    if (!res.ok) {
      setError("거절 실패");
      return;
    }
    await loadAll(token);
  }

  async function assignStudent() {
    if (!adminId || !studentId) return;
    setError(null);
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    const res = await fetch("/api/admin/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ adminId, studentId }),
    });
    if (!res.ok) {
      setError("할당 실패");
      return;
    }
    setAdminId("");
    setStudentId("");
    await loadAll(token);
  }

  if (loading) {
    return <div style={{ padding: 24 }}>로딩 중...</div>;
  }

  if (!me || me.role !== "SUPER_ADMIN") {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>권한 없음</h1>
        <p style={{ marginTop: 8, color: "#666" }}>
          관리자 승인 화면은 최종 관리자만 접근할 수 있어요.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "32px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>관리자 승인</h1>
      {error && <div style={{ color: "#c00", marginTop: 8 }}>{error}</div>}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>가입 대기</h2>
        {pending.length === 0 ? (
          <div style={{ color: "#666", marginTop: 8 }}>대기 중인 계정이 없습니다.</div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {pending.map((user) => (
              <div
                key={user.id}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  border: "1px solid #eee",
                  padding: 12,
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{user.name ?? user.email}</div>
                  <div style={{ color: "#666", fontSize: 12 }}>{user.email}</div>
                </div>
                <button onClick={() => approveUser(user.id, "STUDENT")}>학생 승인</button>
                <button onClick={() => approveUser(user.id, "ADMIN")}>관리자 승인</button>
                <button onClick={() => rejectUser(user.id)}>거절</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>학생 할당</h2>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <select value={adminId} onChange={(e) => setAdminId(e.target.value)}>
            <option value="">관리자 선택</option>
            {admins.map((admin) => (
              <option key={admin.id} value={admin.id}>
                {admin.name ?? admin.email}
              </option>
            ))}
          </select>
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            <option value="">학생 선택</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.name ?? student.email}
              </option>
            ))}
          </select>
          <button onClick={assignStudent}>할당</button>
        </div>

        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>현재 할당</h3>
          {assignments.length === 0 ? (
            <div style={{ color: "#666", marginTop: 8 }}>할당된 학생이 없습니다.</div>
          ) : (
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {assignments.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    border: "1px solid #eee",
                    padding: 12,
                    borderRadius: 8,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      관리자: {a.admin.name ?? a.admin.email}
                    </div>
                    <div style={{ color: "#666", fontSize: 12 }}>
                      학생: {a.student.name ?? a.student.email}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
