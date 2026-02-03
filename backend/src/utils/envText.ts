export function parseEnvText(text: string | null | undefined): Record<string, string> {
  const raw = typeof text === "string" ? text : "";
  const out: Record<string, string> = {};

  for (const rawLine of raw.split(/\r?\n/g)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

export function isForbiddenGitEnvKey(key: string): boolean {
  const upper = String(key ?? "").trim().toUpperCase();
  if (!upper) return false;
  if (upper.startsWith("TUIXIU_GIT_")) return true;
  return upper === "GH_TOKEN" || upper === "GITHUB_TOKEN" || upper === "GITLAB_TOKEN" || upper === "GITLAB_ACCESS_TOKEN";
}

export function listForbiddenGitEnvKeys(text: string | null | undefined): string[] {
  return listEnvKeys(text).filter(isForbiddenGitEnvKey);
}

export function stripForbiddenGitEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (isForbiddenGitEnvKey(key)) delete out[key];
  }
  return out;
}

export function listEnvKeys(text: string | null | undefined): string[] {
  return Object.keys(parseEnvText(text))
    .map((k) => k.trim())
    .filter(Boolean)
    .sort();
}
