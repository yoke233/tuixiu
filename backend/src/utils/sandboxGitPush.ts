import { buildGitRuntimeEnv, type GitCredentialAuthInput } from "./gitCredentialRuntime.js";

export function buildSandboxGitPushEnv(opts: {
  project: { repoUrl: string; scmType?: string | null };
  credential: GitCredentialAuthInput;
}): Record<string, string> {
  return {
    TUIXIU_REPO_URL: String(opts.project.repoUrl ?? ""),
    ...buildGitRuntimeEnv({
      project: { repoUrl: String(opts.project.repoUrl ?? ""), scmType: opts.project.scmType ?? null },
      credential: opts.credential,
    }),
  };
}

