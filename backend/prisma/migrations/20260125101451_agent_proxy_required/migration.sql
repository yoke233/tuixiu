/*
  Warnings:

  - Made the column `proxyId` on table `Agent` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Agent" ALTER COLUMN "proxyId" SET NOT NULL;
