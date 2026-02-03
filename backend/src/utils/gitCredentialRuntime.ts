import { GitAuthEnvError, pickGitAccessToken, resolveGitAuthMode, resolveGitHttpUsername, type GitAuthProject } from "./gitAuth.js";

export type GitCredentialAuthInput = {
  gitAuthMode?: string | null;
  githubAccessToken?: string | null;
  gitlabAccessToken?: string | null;
  gitSshCommand?: string | null;
  gitSshKey?: string | null;
  gitSshKeyB64?: string | null;
};

export function mergeGitAuthInput(
  project: { repoUrl: string; scmType?: string | null },
  credential: GitCredentialAuthInput,
): GitAuthProject {
  return {
    repoUrl: project.repoUrl,
    scmType: project.scmType ?? null,
    gitAuthMode: credential.gitAuthMode ?? null,
    githubAccessToken: credential.githubAccessToken ?? null,
    gitlabAccessToken: credential.gitlabAccessToken ?? null,
  };
}

export function buildGitRuntimeEnv(opts: {
  project: { repoUrl: string; scmType?: string | null };
  credential: GitCredentialAuthInput;
}): Record<string, string> {
  const input = mergeGitAuthInput(opts.project, opts.credential);
  const gitAuthMode = resolveGitAuthMode(input);

  const env: Record<string, string> = {
    TUIXIU_GIT_AUTH_MODE: gitAuthMode,
  };

  const githubToken = String(opts.credential.githubAccessToken ?? "").trim();
  if (githubToken) {
    env.GH_TOKEN = githubToken;
    env.GITHUB_TOKEN = githubToken;
  }
  const gitlabToken = String(opts.credential.gitlabAccessToken ?? "").trim();
  if (gitlabToken) {
    env.GITLAB_TOKEN = gitlabToken;
    env.GITLAB_ACCESS_TOKEN = gitlabToken;
  }

  if (gitAuthMode === "https_pat") {
    const token = pickGitAccessToken(input);
    if (!token) {
      throw new GitAuthEnvError(
        "GIT_CREDENTIAL_HTTPS_TOKEN_MISSING",
        "GitCredential HTTPS 认证缺失：请配置 githubAccessToken 或 gitlabAccessToken",
      );
    }
    env.TUIXIU_GIT_HTTP_USERNAME = resolveGitHttpUsername(input);
    env.TUIXIU_GIT_HTTP_PASSWORD = token;
    return env;
  }

  const sshCommand = String(opts.credential.gitSshCommand ?? "").trim();
  const sshKeyB64 = String(opts.credential.gitSshKeyB64 ?? "").trim();
  const sshKey = String(opts.credential.gitSshKey ?? "").trim();

  if (sshCommand) env.TUIXIU_GIT_SSH_COMMAND = sshCommand;
  if (sshKeyB64) env.TUIXIU_GIT_SSH_KEY_B64 = sshKeyB64;
  else if (sshKey) env.TUIXIU_GIT_SSH_KEY = sshKey;

  const hasSsh = !!sshCommand || !!sshKeyB64 || !!sshKey;
  if (!hasSsh) {
    throw new GitAuthEnvError(
      "GIT_CREDENTIAL_SSH_AUTH_MISSING",
      "GitCredential SSH 认证缺失：请配置 gitSshCommand 或 gitSshKey(_B64)",
    );
  }

  return env;
}

