-- Add RoleTemplate envText (.env format) for injecting sandbox/runtime secrets (e.g. git tokens).

ALTER TABLE "RoleTemplate" ADD COLUMN "envText" TEXT;
