-- Rename ArtifactType value "mr" -> "pr" by recreating the enum.
-- This avoids relying on Postgres enum value rename support/version.

CREATE TYPE "ArtifactType_new" AS ENUM ('branch', 'pr', 'patch', 'report', 'ci_result');

ALTER TABLE "Artifact"
  ALTER COLUMN "type" TYPE "ArtifactType_new"
  USING (
    CASE
      WHEN "type"::text = 'mr' THEN 'pr'
      ELSE "type"::text
    END
  )::"ArtifactType_new";

DROP TYPE "ArtifactType";
ALTER TYPE "ArtifactType_new" RENAME TO "ArtifactType";
