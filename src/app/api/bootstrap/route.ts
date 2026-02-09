import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = user.email ?? "";
  const name =
    typeof user.user_metadata?.name === "string" ? user.user_metadata.name : null;

  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
  const isSuperAdmin =
    !!superAdminEmail && email.toLowerCase() === superAdminEmail;

  await prisma.user.upsert({
    where: { id: user.id },
    update: {
      email,
      name,
    },
    create: {
      id: user.id,
      email,
      name,
      role: isSuperAdmin ? "SUPER_ADMIN" : "STUDENT",
      status: isSuperAdmin ? "APPROVED" : "PENDING",
    },
  });

  return NextResponse.json({ ok: true });
}
