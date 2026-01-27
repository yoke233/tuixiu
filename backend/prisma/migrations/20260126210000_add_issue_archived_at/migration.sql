-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Issue_archivedAt_idx" ON "Issue"("archivedAt");
