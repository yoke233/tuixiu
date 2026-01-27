export type SensitiveHit = { matchedFiles: string[]; patterns: string[] };

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function globToRegExp(pattern: string): RegExp {
  // Very small glob subset:
  // - `**` matches any chars (including `/`)
  // - `*` matches any chars except `/`
  const raw = toPosixPath(pattern.trim());
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, "§§DOUBLESTAR§§");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const final = withSingleStar.replace(/§§DOUBLESTAR§§/g, ".*");
  return new RegExp(`^${final}$`);
}

function matchAnyGlob(path: string, patterns: string[]): string[] {
  const p = toPosixPath(path);
  const matched: string[] = [];
  for (const raw of patterns) {
    const pat = String(raw ?? "").trim();
    if (!pat) continue;
    const re = globToRegExp(pat);
    if (re.test(p)) matched.push(pat);
  }
  return matched;
}

export function computeSensitiveHitFromPaths(paths: string[], patterns: string[]): SensitiveHit | null {
  const pats = Array.isArray(patterns) ? patterns : [];
  if (!pats.length) return null;

  const matchedFiles: string[] = [];
  const matchedPatterns = new Set<string>();

  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const p = String(rawPath ?? "").trim();
    if (!p) continue;
    const matched = matchAnyGlob(p, pats);
    if (!matched.length) continue;
    matchedFiles.push(p);
    for (const m of matched) matchedPatterns.add(m);
  }

  if (!matchedFiles.length) return null;
  return { matchedFiles, patterns: [...matchedPatterns] };
}

export function computeSensitiveHitFromFiles(files: Array<{ path: string }>, patterns: string[]): SensitiveHit | null {
  const paths = (Array.isArray(files) ? files : []).map((f) => String(f?.path ?? "")).filter(Boolean);
  return computeSensitiveHitFromPaths(paths, patterns);
}

