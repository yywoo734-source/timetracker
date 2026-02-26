import { prismaNewApp } from "@/lib/prisma-new-app";

const globalForNewAppSchema = globalThis as unknown as {
  newAppSchemaEnsured?: boolean;
};

export async function ensureNewAppSchema() {
  if (globalForNewAppSchema.newAppSchemaEnsured) return;

  await prismaNewApp.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ActionPlanStatus') THEN
        CREATE TYPE "ActionPlanStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CheckinResult') THEN
        CREATE TYPE "CheckinResult" AS ENUM ('DONE', 'PARTIAL', 'MISSED');
      END IF;
    END
    $$;
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "pain_logs" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "user_id" UUID NOT NULL,
      "occurred_at" TIMESTAMP(3) NOT NULL,
      "intensity" INTEGER NOT NULL,
      "emotion" TEXT NOT NULL,
      "situation" TEXT NOT NULL,
      "trigger_text" TEXT NOT NULL,
      "body_signal" TEXT NOT NULL,
      "auto_note" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "pain_logs_pkey" PRIMARY KEY ("id")
    );
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "reflections" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "pain_log_id" UUID NOT NULL,
      "thought_raw" TEXT NOT NULL,
      "fact_check" TEXT NOT NULL,
      "controllable_focus" TEXT NOT NULL,
      "reframe" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "reflections_pkey" PRIMARY KEY ("id")
    );
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "action_plans" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "pain_log_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "if_then_plan" TEXT NOT NULL,
      "due_date" DATE,
      "status" "ActionPlanStatus" NOT NULL DEFAULT 'PENDING',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "action_plans_pkey" PRIMARY KEY ("id")
    );
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "action_checkins" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "action_plan_id" UUID NOT NULL,
      "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "result" "CheckinResult" NOT NULL,
      "memo" TEXT,
      CONSTRAINT "action_checkins_pkey" PRIMARY KEY ("id")
    );
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "weekly_reviews" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "user_id" UUID NOT NULL,
      "week_start" DATE NOT NULL,
      "top_triggers" JSONB NOT NULL,
      "avg_intensity" DECIMAL(4,2) NOT NULL,
      "action_success_rate" DECIMAL(5,2) NOT NULL,
      "summary" TEXT NOT NULL,
      "next_focus" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "weekly_reviews_pkey" PRIMARY KEY ("id")
    );
  `);

  await prismaNewApp.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "reflections_pain_log_id_key"
      ON "reflections"("pain_log_id");
    CREATE INDEX IF NOT EXISTS "pain_logs_user_id_occurred_at_idx"
      ON "pain_logs"("user_id", "occurred_at" DESC);
    CREATE INDEX IF NOT EXISTS "action_plans_pain_log_id_status_idx"
      ON "action_plans"("pain_log_id", "status");
    CREATE INDEX IF NOT EXISTS "action_checkins_action_plan_id_checked_at_idx"
      ON "action_checkins"("action_plan_id", "checked_at" DESC);
    CREATE INDEX IF NOT EXISTS "weekly_reviews_user_id_week_start_idx"
      ON "weekly_reviews"("user_id", "week_start");
    CREATE UNIQUE INDEX IF NOT EXISTS "weekly_reviews_user_id_week_start_key"
      ON "weekly_reviews"("user_id", "week_start");
  `);

  await prismaNewApp.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pain_logs_user_id_fkey') THEN
        ALTER TABLE "pain_logs"
          ADD CONSTRAINT "pain_logs_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reflections_pain_log_id_fkey') THEN
        ALTER TABLE "reflections"
          ADD CONSTRAINT "reflections_pain_log_id_fkey"
          FOREIGN KEY ("pain_log_id") REFERENCES "pain_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_pain_log_id_fkey') THEN
        ALTER TABLE "action_plans"
          ADD CONSTRAINT "action_plans_pain_log_id_fkey"
          FOREIGN KEY ("pain_log_id") REFERENCES "pain_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_checkins_action_plan_id_fkey') THEN
        ALTER TABLE "action_checkins"
          ADD CONSTRAINT "action_checkins_action_plan_id_fkey"
          FOREIGN KEY ("action_plan_id") REFERENCES "action_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weekly_reviews_user_id_fkey') THEN
        ALTER TABLE "weekly_reviews"
          ADD CONSTRAINT "weekly_reviews_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END
    $$;
  `);

  globalForNewAppSchema.newAppSchemaEnsured = true;
}
