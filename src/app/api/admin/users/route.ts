import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({ where: { id: user.id } });
  if (!me || me.role !== "SUPER_ADMIN" || me.status !== "APPROVED") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  const role = searchParams.get("role") ?? undefined;

  // Some signups can exist in auth.users without a public profile row yet.
  // Sync them when super admin opens pending list.
  if (status === "PENDING") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();

    if (url && serviceRoleKey) {
      const supabaseAdmin = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const candidates: Array<{
        id: string;
        email: string;
        name: string | null;
        role: "STUDENT" | "SUPER_ADMIN";
        status: "PENDING" | "APPROVED";
      }> = [];

      let page = 1;
      const perPage = 200;
      while (true) {
        const { data, error: listError } = await supabaseAdmin.auth.admin.listUsers({
          page,
          perPage,
        });
        if (listError || !data?.users?.length) break;

        for (const u of data.users) {
          if (!u.id || !u.email) continue;
          const email = String(u.email);
          const name =
            typeof u.user_metadata?.name === "string" ? u.user_metadata.name : null;
          const isSuperAdmin =
            !!superAdminEmail && email.toLowerCase() === superAdminEmail;

          candidates.push({
            id: u.id,
            email,
            name,
            role: isSuperAdmin ? "SUPER_ADMIN" : "STUDENT",
            status: isSuperAdmin ? "APPROVED" : "PENDING",
          });
        }

        if (data.users.length < perPage) break;
        page += 1;
      }

      if (candidates.length > 0) {
        const existing = await prisma.user.findMany({
          where: { id: { in: candidates.map((c) => c.id) } },
          select: { id: true },
        });
        const existingIds = new Set(existing.map((x) => x.id));
        const toCreate = candidates.filter((c) => !existingIds.has(c.id));

        if (toCreate.length > 0) {
          await prisma.user.createMany({
            data: toCreate,
            skipDuplicates: true,
          });
        }
      }
    }
  }

  const users = await prisma.user.findMany({
    where: {
      status: status as any,
      role: role as any,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return NextResponse.json({ users });
}
