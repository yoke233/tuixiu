export type PublicProject<T> = Omit<
  T,
  "gitlabAccessToken" | "gitlabWebhookSecret" | "githubAccessToken"
>;

export function toPublicProject<T extends Record<string, unknown>>(
  project: T,
): PublicProject<T> {
  const clone = { ...(project as any) };
  delete clone.gitlabAccessToken;
  delete clone.gitlabWebhookSecret;
  delete clone.githubAccessToken;
  return clone as any;
}

