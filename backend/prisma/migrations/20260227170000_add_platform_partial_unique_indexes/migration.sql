-- Enforce platform-scope uniqueness at DB level (projectId is nullable).
-- Note: if existing duplicated platform keys exist, this migration will fail and require cleanup first.

CREATE UNIQUE INDEX IF NOT EXISTS "GitCredential_platform_key_unique"
  ON "GitCredential"("key")
  WHERE "scope" = 'platform' AND "projectId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "RoleTemplate_platform_key_unique"
  ON "RoleTemplate"("key")
  WHERE "scope" = 'platform' AND "projectId" IS NULL;
