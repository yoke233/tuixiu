-- Allow platform-scoped shared credentials/roles by making projectId nullable
-- and adding scope discriminator columns.

ALTER TABLE "GitCredential"
  ALTER COLUMN "projectId" DROP NOT NULL,
  ADD COLUMN "scope" VARCHAR(20) NOT NULL DEFAULT 'project';

ALTER TABLE "RoleTemplate"
  ALTER COLUMN "projectId" DROP NOT NULL,
  ADD COLUMN "scope" VARCHAR(20) NOT NULL DEFAULT 'project';

UPDATE "GitCredential" SET "scope" = 'project' WHERE "scope" IS NULL;
UPDATE "RoleTemplate" SET "scope" = 'project' WHERE "scope" IS NULL;

CREATE INDEX "GitCredential_scope_idx" ON "GitCredential"("scope");
CREATE INDEX "RoleTemplate_scope_idx" ON "RoleTemplate"("scope");
