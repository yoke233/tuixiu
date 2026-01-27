export type PublicProject<T> = Omit<
  T,
  "gitlabAccessToken" | "gitlabWebhookSecret" | "githubAccessToken"
> & {
  hasGitlabAccessToken?: boolean;
  hasGithubAccessToken?: boolean;
};

export function toPublicProject<T extends Record<string, unknown>>(
  project: T,
): PublicProject<T> {
  const hasGitlabAccessToken = !!String((project as any)?.gitlabAccessToken ?? "").trim();
  const hasGithubAccessToken = !!String((project as any)?.githubAccessToken ?? "").trim();

  const clone = { ...(project as any), hasGitlabAccessToken, hasGithubAccessToken };
  delete clone.gitlabAccessToken;
  delete clone.gitlabWebhookSecret;
  delete clone.githubAccessToken;
  return clone as any;
}

