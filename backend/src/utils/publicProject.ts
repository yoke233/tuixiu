export type PublicProject<T> = Omit<
  T,
  | "gitlabAccessToken"
  | "gitlabWebhookSecret"
  | "githubAccessToken"
  | "scmConfig"
> & {
  hasRunGitCredential?: boolean;
  hasScmAdminCredential?: boolean;
  gitlabProjectId?: number | null;
  githubPollingEnabled?: boolean;
  githubPollingCursor?: Date | null;
};

export function toPublicProject<T extends Record<string, unknown>>(
  project: T,
): PublicProject<T> {
  const runGitCredentialId = (project as any)?.runGitCredentialId ?? null;
  const scmAdminCredentialId = (project as any)?.scmAdminCredentialId ?? null;
  const scmConfig = (project as any)?.scmConfig ?? null;

  const hasRunGitCredential = !!String(runGitCredentialId ?? "").trim();
  const hasScmAdminCredential = !!String(scmAdminCredentialId ?? "").trim();

  const clone = {
    ...(project as any),
    hasRunGitCredential,
    hasScmAdminCredential,
    gitlabProjectId: scmConfig?.gitlabProjectId ?? null,
    githubPollingEnabled: scmConfig?.githubPollingEnabled ?? false,
    githubPollingCursor: scmConfig?.githubPollingCursor ?? null,
  };
  delete clone.gitlabAccessToken;
  delete clone.gitlabWebhookSecret;
  delete clone.githubAccessToken;
  delete clone.scmConfig;
  return clone as any;
}
