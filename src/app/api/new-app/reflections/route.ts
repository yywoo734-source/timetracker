import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { ensureNewAppUser } from "@/lib/new-app-user";
import { ensureNewAppSchema } from "@/lib/new-app-schema";
import { prismaNewApp } from "@/lib/prisma-new-app";

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureNewAppSchema();
  await ensureNewAppUser(user);

  const { searchParams } = new URL(request.url);
  const painLogId = String(searchParams.get("painLogId") ?? "").trim();
  if (!painLogId) {
    return NextResponse.json({ error: "painLogId required" }, { status: 400 });
  }

  const row = await prismaNewApp.reflection.findFirst({
    where: {
      painLogId,
      painLog: {
        userId: user.id,
      },
    },
  });

  return NextResponse.json({ reflection: row });
}

export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureNewAppSchema();
  await ensureNewAppUser(user);

  const body = (await request.json()) as {
    painLogId?: unknown;
    thoughtRaw?: unknown;
    factCheck?: unknown;
    controllableFocus?: unknown;
    reframe?: unknown;
  };

  const painLogId = String(body.painLogId ?? "").trim();
  const thoughtRaw = String(body.thoughtRaw ?? "").trim();
  const factCheck = String(body.factCheck ?? "").trim();
  const controllableFocus = String(body.controllableFocus ?? "").trim();
  const reframe = String(body.reframe ?? "").trim();

  if (!painLogId) {
    return NextResponse.json({ error: "painLogId required" }, { status: 400 });
  }
  if (!thoughtRaw || !factCheck || !controllableFocus) {
    return NextResponse.json(
      { error: "thoughtRaw, factCheck, controllableFocus are required" },
      { status: 400 }
    );
  }

  const ownedLog = await prismaNewApp.painLog.findFirst({
    where: {
      id: painLogId,
      userId: user.id,
    },
    select: { id: true },
  });
  if (!ownedLog) {
    return NextResponse.json({ error: "Pain log not found" }, { status: 404 });
  }

  const reflection = await prismaNewApp.reflection.upsert({
    where: { painLogId },
    update: {
      thoughtRaw,
      factCheck,
      controllableFocus,
      reframe: reframe || null,
    },
    create: {
      painLogId,
      thoughtRaw,
      factCheck,
      controllableFocus,
      reframe: reframe || null,
    },
  });

  return NextResponse.json({ reflection });
}
