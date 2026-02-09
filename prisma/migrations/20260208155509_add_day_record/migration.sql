-- CreateTable
CREATE TABLE "DayRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "blocks" JSONB NOT NULL,
    "notes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayRecord_userId_day_idx" ON "DayRecord"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DayRecord_userId_day_key" ON "DayRecord"("userId", "day");

-- AddForeignKey
ALTER TABLE "DayRecord" ADD CONSTRAINT "DayRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
