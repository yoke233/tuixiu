-- Add GitHub polling switch + cursor to Project
ALTER TABLE "Project" ADD COLUMN "githubPollingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "githubPollingCursor" TIMESTAMP(3);

CREATE INDEX "Project_githubPollingEnabled_idx" ON "Project"("githubPollingEnabled");
