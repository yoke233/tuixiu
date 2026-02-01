# Rollback Strategy

- This migration adds nullable JSONB columns on Run and Task.
- To roll back, mark the migration as rolled back and apply a corrective migration if needed:
  - `pnpm -C backend prisma migrate resolve --rolled-back 20260201025009_add_bundle_source_fields`
