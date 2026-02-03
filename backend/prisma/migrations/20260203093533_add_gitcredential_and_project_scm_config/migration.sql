-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "runGitCredentialId" UUID,
ADD COLUMN     "scmAdminCredentialId" UUID;

-- CreateTable
CREATE TABLE "GitCredential" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "purpose" VARCHAR(20),
    "gitAuthMode" VARCHAR(20) NOT NULL DEFAULT 'https_pat',
    "githubAccessToken" TEXT,
    "gitlabAccessToken" TEXT,
    "gitSshCommand" TEXT,
    "gitSshKey" TEXT,
    "gitSshKeyB64" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectScmConfig" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "gitlabProjectId" INTEGER,
    "gitlabWebhookSecret" VARCHAR(255),
    "githubPollingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "githubPollingCursor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectScmConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitCredential_projectId_idx" ON "GitCredential"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GitCredential_projectId_key_key" ON "GitCredential"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScmConfig_projectId_key" ON "ProjectScmConfig"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScmConfig_gitlabProjectId_key" ON "ProjectScmConfig"("gitlabProjectId");

-- CreateIndex
CREATE INDEX "ProjectScmConfig_gitlabProjectId_idx" ON "ProjectScmConfig"("gitlabProjectId");

-- CreateIndex
CREATE INDEX "ProjectScmConfig_githubPollingEnabled_idx" ON "ProjectScmConfig"("githubPollingEnabled");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_runGitCredentialId_fkey" FOREIGN KEY ("runGitCredentialId") REFERENCES "GitCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_scmAdminCredentialId_fkey" FOREIGN KEY ("scmAdminCredentialId") REFERENCES "GitCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitCredential" ADD CONSTRAINT "GitCredential_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScmConfig" ADD CONSTRAINT "ProjectScmConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration
-- 1) 为每个 project 创建两条 credential（run + scm_admin），先把旧 token 原样迁过去（后续再由管理员降权）
INSERT INTO "GitCredential" ("id","projectId","key","purpose","gitAuthMode","githubAccessToken","gitlabAccessToken","createdAt","updatedAt")
SELECT
  md5(p."id"::text || ':run-default')::uuid,
  p."id",
  'run-default',
  'run',
  p."gitAuthMode",
  p."githubAccessToken",
  p."gitlabAccessToken",
  now(),
  now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "GitCredential" gc WHERE gc."projectId" = p."id" AND gc."key" = 'run-default'
);

INSERT INTO "GitCredential" ("id","projectId","key","purpose","gitAuthMode","githubAccessToken","gitlabAccessToken","createdAt","updatedAt")
SELECT
  md5(p."id"::text || ':scm-admin')::uuid,
  p."id",
  'scm-admin',
  'scm_admin',
  p."gitAuthMode",
  p."githubAccessToken",
  p."gitlabAccessToken",
  now(),
  now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "GitCredential" gc WHERE gc."projectId" = p."id" AND gc."key" = 'scm-admin'
);

-- 2) 回填 Project 的默认 credential 引用
UPDATE "Project" p
SET "runGitCredentialId" = gc."id"
FROM "GitCredential" gc
WHERE gc."projectId" = p."id" AND gc."key" = 'run-default' AND p."runGitCredentialId" IS NULL;

UPDATE "Project" p
SET "scmAdminCredentialId" = gc."id"
FROM "GitCredential" gc
WHERE gc."projectId" = p."id" AND gc."key" = 'scm-admin' AND p."scmAdminCredentialId" IS NULL;

-- 3) SCM config 回填（gitlabProjectId/webhookSecret + github polling）
INSERT INTO "ProjectScmConfig" ("id","projectId","gitlabProjectId","gitlabWebhookSecret","githubPollingEnabled","githubPollingCursor","createdAt","updatedAt")
SELECT
  md5(p."id"::text || ':scm-config')::uuid,
  p."id",
  p."gitlabProjectId",
  p."gitlabWebhookSecret",
  p."githubPollingEnabled",
  p."githubPollingCursor",
  now(),
  now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "ProjectScmConfig" c WHERE c."projectId" = p."id"
);
