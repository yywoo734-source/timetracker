import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let profile = await prisma.user.findUnique({
    where: { id: user.id },
  });

  // Some signups can exist in Supabase auth without a profile row yet.
  // Auto-create on first authenticated /api/me call so admin pending list can see them.
  if (!profile) {
    const email = user.email ?? "";
    const name =
      typeof user.user_metadata?.name === "string" ? user.user_metadata.name : null;
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
    const isSuperAdmin = !!superAdminEmail && email.toLowerCase() === superAdminEmail;

    profile = await prisma.user.create({
      data: {
        id: user.id,
        email,
        name,
        role: isSuperAdmin ? "SUPER_ADMIN" : "STUDENT",
        status: isSuperAdmin ? "APPROVED" : "PENDING",
      },
    });
  }

  return NextResponse.json({
    user: profile,
  });
}
