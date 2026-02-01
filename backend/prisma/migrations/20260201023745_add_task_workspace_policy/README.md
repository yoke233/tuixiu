# Rollback Strategy

- This migration adds a nullable column on Task.
- To roll back, mark the migration as rolled back and apply a corrective migration if needed:
  - `pnpm -C backend prisma migrate resolve --rolled-back 20260201023745_add_task_workspace_policy`
