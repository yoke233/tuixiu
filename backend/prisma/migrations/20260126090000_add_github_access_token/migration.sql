-- Add GitHub access token storage for GitHub PR automation.
ALTER TABLE "Project" ADD COLUMN "githubAccessToken" TEXT;

