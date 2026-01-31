-- Add deletedAt/orphanedAt to sandbox inventory table.

ALTER TABLE "SandboxInstance"
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "orphanedAt" TIMESTAMP(3);

