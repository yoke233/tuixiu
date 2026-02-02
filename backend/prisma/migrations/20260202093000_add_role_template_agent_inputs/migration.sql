-- Add RoleTemplate agentInputs (manifest v1) for injecting per-run inputs (USER_HOME/WORKSPACE).

ALTER TABLE "RoleTemplate" ADD COLUMN "agentInputs" JSONB;
