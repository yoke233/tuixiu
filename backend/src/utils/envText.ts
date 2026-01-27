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

export function listEnvKeys(text: string | null | undefined): string[] {
  return Object.keys(parseEnvText(text))
    .map((k) => k.trim())
    .filter(Boolean)
    .sort();
}

