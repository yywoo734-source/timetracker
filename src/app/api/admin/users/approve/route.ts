import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.role !== "SUPER_ADMIN" || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as {
    userId: string;
    status?: "PENDING" | "APPROVED" | "REJECTED";
    role?: "STUDENT" | "ADMIN";
  };

  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // When approving a user, also confirm their auth email in Supabase so login works immediately.
  if ((body.status ?? "APPROVED") === "APPROVED") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Missing Supabase admin env vars on server." },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(
      body.userId,
      { email_confirm: true }
    );

    if (confirmError) {
      return NextResponse.json(
        { error: `Email confirm failed: ${confirmError.message}` },
        { status: 500 }
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id: body.userId },
    data: {
      status: body.status ?? "APPROVED",
      role: body.role ?? "STUDENT",
    },
  });

  return NextResponse.json({ user: updated });
}
