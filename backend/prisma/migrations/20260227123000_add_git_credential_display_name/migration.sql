ALTER TABLE "GitCredential"
  ADD COLUMN "displayName" VARCHAR(255);

UPDATE "GitCredential"
SET "displayName" = "key"
WHERE "displayName" IS NULL;

ALTER TABLE "GitCredential"
  ALTER COLUMN "displayName" SET NOT NULL;
