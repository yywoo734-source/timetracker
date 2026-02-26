import { NextResponse, type NextRequest } from "next/server";
import { ActionPlanStatus } from "@/generated/prisma-new-app/client";
import { getUserFromRequest } from "@/lib/supabase/server-auth";
import { ensureNewAppUser } from "@/lib/new-app-user";
import { ensureNewAppSchema } from "@/lib/new-app-schema";
import { prismaNewApp } from "@/lib/prisma-new-app";

function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseStatus(value: unknown): ActionPlanStatus | null {
  if (typeof value !== "string") return null;
  if (value === "PENDING" || value === "DONE" || value === "SKIPPED") return value;
  return null;
}

export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureNewAppSchema();
  await ensureNewAppUser(user);

  const { searchParams } = new URL(request.url);
  const painLogId = String(searchParams.get("painLogId") ?? "").trim();

  const plans = await prismaNewApp.actionPlan.findMany({
    where: {
      painLog: {
        userId: user.id,
      },
      ...(painLogId ? { painLogId } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    include: {
      checkins: {
        orderBy: [{ checkedAt: "desc" }],
      },
    },
  });

  return NextResponse.json({ plans });
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
    title?: unknown;
    ifThenPlan?: unknown;
    dueDate?: unknown;
    status?: unknown;
  };

  const painLogId = String(body.painLogId ?? "").trim();
  const title = String(body.title ?? "").trim();
  const ifThenPlan = String(body.ifThenPlan ?? "").trim();
  const dueDate = parseDate(body.dueDate);
  const status = parseStatus(body.status) ?? ActionPlanStatus.PENDING;

  if (!painLogId || !title || !ifThenPlan) {
    return NextResponse.json(
      { error: "painLogId, title, ifThenPlan are required" },
      { status: 400 }
    );
  }

  const ownedLog = await prismaNewApp.painLog.findFirst({
    where: { id: painLogId, userId: user.id },
    select: { id: true },
  });
  if (!ownedLog) {
    return NextResponse.json({ error: "Pain log not found" }, { status: 404 });
  }

  const plan = await prismaNewApp.actionPlan.create({
    data: {
      painLogId,
      title,
      ifThenPlan,
      dueDate,
      status,
    },
  });

  return NextResponse.json({ plan }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await ensureNewAppSchema();
  await ensureNewAppUser(user);

  const body = (await request.json()) as {
    id?: unknown;
    status?: unknown;
  };

  const id = String(body.id ?? "").trim();
  const status = parseStatus(body.status);

  if (!id || !status) {
    return NextResponse.json({ error: "id and valid status are required" }, { status: 400 });
  }

  const plan = await prismaNewApp.actionPlan.findFirst({
    where: { id, painLog: { userId: user.id } },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Action plan not found" }, { status: 404 });
  }

  const updated = await prismaNewApp.actionPlan.update({
    where: { id },
    data: { status },
  });

  return NextResponse.json({ plan: updated });
}
