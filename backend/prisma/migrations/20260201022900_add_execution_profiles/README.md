# Rollback Strategy

- This migration only adds nullable columns and new tables.
- To roll back, mark the migration as rolled back and apply the previous state:
  - `pnpm -C backend prisma migrate resolve --rolled-back 20260201022900_add_execution_profiles`
  - Then remove the new tables/columns via a corrective migration if needed.
