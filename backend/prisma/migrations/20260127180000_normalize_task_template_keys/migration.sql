-- Normalize legacy Task.templateKey values to canonical keys.
-- Safe to re-run: updates are idempotent.

UPDATE "Task" SET "templateKey" = 'quick.admin.session' WHERE "templateKey" = 'template.admin.session';
UPDATE "Task" SET "templateKey" = 'quick.dev.full' WHERE "templateKey" = 'template.dev.full';
UPDATE "Task" SET "templateKey" = 'planning.prd.only' WHERE "templateKey" = 'template.prd.only';
UPDATE "Task" SET "templateKey" = 'quick.test.only' WHERE "templateKey" = 'template.test.only';

-- Backfill track when missing (best-effort).
UPDATE "Task" SET "track" = 'quick' WHERE "track" IS NULL AND "templateKey" IN ('quick.admin.session', 'quick.dev.full', 'quick.test.only');
UPDATE "Task" SET "track" = 'planning' WHERE "track" IS NULL AND "templateKey" IN ('planning.prd.dev.full', 'planning.prd.only');
UPDATE "Task" SET "track" = 'enterprise' WHERE "track" IS NULL AND "templateKey" IN ('enterprise.dev.full');

