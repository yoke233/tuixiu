-- Add minimal SCM state fields to Run (GitHub-first, no Artifact SSOT).

-- CreateEnum
CREATE TYPE "ScmProvider" AS ENUM ('github', 'gitlab');

-- CreateEnum
CREATE TYPE "ScmPrState" AS ENUM ('open', 'closed', 'merged');

-- CreateEnum
CREATE TYPE "ScmCiStatus" AS ENUM ('pending', 'passed', 'failed');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "scmProvider" "ScmProvider",
ADD COLUMN     "scmHeadSha" VARCHAR(64),
ADD COLUMN     "scmPrNumber" INTEGER,
ADD COLUMN     "scmPrUrl" VARCHAR(500),
ADD COLUMN     "scmPrState" "ScmPrState",
ADD COLUMN     "scmCiStatus" "ScmCiStatus",
ADD COLUMN     "scmUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Run_scmProvider_scmPrNumber_idx" ON "Run"("scmProvider", "scmPrNumber");

-- CreateIndex
CREATE INDEX "Run_scmHeadSha_idx" ON "Run"("scmHeadSha");

-- CreateIndex
CREATE INDEX "Run_scmCiStatus_idx" ON "Run"("scmCiStatus");

