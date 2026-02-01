-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "bundleSource" JSONB;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "bundleSource" JSONB;
