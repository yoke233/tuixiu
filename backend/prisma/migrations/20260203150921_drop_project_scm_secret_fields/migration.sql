/*
  Warnings:

  - You are about to drop the column `gitAuthMode` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `githubAccessToken` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `githubPollingCursor` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `githubPollingEnabled` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `gitlabAccessToken` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `gitlabProjectId` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `gitlabWebhookSecret` on the `Project` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Project_githubPollingEnabled_idx";

-- DropIndex
DROP INDEX "Project_gitlabProjectId_idx";

-- DropIndex
DROP INDEX "Project_gitlabProjectId_key";

-- AlterTable
ALTER TABLE "Project" DROP COLUMN "gitAuthMode",
DROP COLUMN "githubAccessToken",
DROP COLUMN "githubPollingCursor",
DROP COLUMN "githubPollingEnabled",
DROP COLUMN "gitlabAccessToken",
DROP COLUMN "gitlabProjectId",
DROP COLUMN "gitlabWebhookSecret";
