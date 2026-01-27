const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GitHub classic token", re: /\bghp_[a-zA-Z0-9]{20,}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g },
  { name: "GitLab token", re: /\bglpat-[a-zA-Z0-9_-]{10,}\b/g },
  { name: "OpenAI key", re: /\bsk-[a-zA-Z0-9]{20,}\b/g },
];

export function redactText(input: string): string {
  let text = String(input ?? "");
  for (const { re } of SECRET_PATTERNS) {
    text = text.replace(re, (m) => `${m.slice(0, 6)}…REDACTED…${m.slice(-4)}`);
  }
  return text;
}

export function scanForSecrets(input: string): { ok: boolean; matches: { name: string; sample: string }[] } {
  const text = String(input ?? "");
  const matches: { name: string; sample: string }[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m || !m.length) continue;
    matches.push({ name, sample: m[0] });
  }
  return { ok: matches.length === 0, matches };
}

