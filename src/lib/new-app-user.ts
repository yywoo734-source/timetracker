import type { User } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

export async function ensureNewAppUser(user: User) {
  const email = user.email ?? "";
  const name =
    typeof user.user_metadata?.name === "string" ? user.user_metadata.name : null;

  return prisma.user.upsert({
    where: { id: user.id },
    update: {
      email,
      name,
    },
    create: {
      id: user.id,
      email,
      name,
    },
  });
}
