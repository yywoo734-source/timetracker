-- CreateTable
CREATE TABLE "CategoryOverride" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "studentId" UUID NOT NULL,
    "categoryId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryOverride_studentId_idx" ON "CategoryOverride"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryOverride_studentId_categoryId_key" ON "CategoryOverride"("studentId", "categoryId");

-- AddForeignKey
ALTER TABLE "CategoryOverride" ADD CONSTRAINT "CategoryOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
