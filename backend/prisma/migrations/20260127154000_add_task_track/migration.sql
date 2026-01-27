-- CreateEnum
CREATE TYPE "TaskTrack" AS ENUM ('quick', 'planning', 'enterprise');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "track" "TaskTrack";

