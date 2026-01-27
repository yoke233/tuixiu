import { apiPost } from "./client";

export async function publishArtifact(artifactId: string, input?: { path?: string }): Promise<{ path: string; commitSha: string }> {
  const data = await apiPost<{ path: string; commitSha: string }>(`/artifacts/${artifactId}/publish`, input ?? {});
  return data;
}

