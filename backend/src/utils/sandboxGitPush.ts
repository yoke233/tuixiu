import type { GitAuthProject } from "./gitAuth.js";
import { pickGitAccessToken, resolveGitAuthMode, resolveGitHttpUsername } from "./gitAuth.js";

export function buildSandboxGitPushEnv(project: GitAuthProject): Record<string, string> {
  const env: Record<string, string> = {
    TUIXIU_REPO_URL: String(project.repoUrl ?? ""),
    TUIXIU_GIT_AUTH_MODE: resolveGitAuthMode(project),
  };

  if (project.githubAccessToken) {
    env.GH_TOKEN = String(project.githubAccessToken);
    env.GITHUB_TOKEN = String(project.githubAccessToken);
  }
  if (project.gitlabAccessToken) {
    env.GITLAB_TOKEN = String(project.gitlabAccessToken);
    env.GITLAB_ACCESS_TOKEN = String(project.gitlabAccessToken);
  }

  if (env.TUIXIU_GIT_AUTH_MODE === "https_pat") {
    const token = pickGitAccessToken(project);
    if (!token) {
      throw new Error("gitAuthMode=https_pat 但未配置 accessToken");
    }
    env.TUIXIU_GIT_HTTP_USERNAME = resolveGitHttpUsername(project);
    env.TUIXIU_GIT_HTTP_PASSWORD = token;
  }

  return env;
}
