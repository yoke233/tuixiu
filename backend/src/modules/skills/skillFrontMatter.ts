type SkillFrontMatter = {
  name?: string;
  description?: string;
  tags?: string[];
  [k: string]: unknown;
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function takeIndentedBlock(lines: string[], startIdx: number): { value: string; nextIdx: number } {
  const buf: string[] = [];
  let i = startIdx;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("  ") && !line.startsWith("\t")) break;
    buf.push(line.replace(/^\s+/, ""));
  }
  return { value: buf.join("\n").trimEnd(), nextIdx: i };
}

function parseYamlLikeFrontMatter(yamlText: string): SkillFrontMatter {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const out: SkillFrontMatter = {};

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    i += 1;

    if (!trimmed || trimmed.startsWith("#")) continue;

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;

    const key = kv[1] ?? "";
    const rest = (kv[2] ?? "").trim();

    if (rest === "|" || rest === ">") {
      const block = takeIndentedBlock(lines, i);
      i = block.nextIdx;
      out[key] = block.value;
      continue;
    }

    if (!rest) {
      // Possibly a list value:
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i] ?? "";
        const t = l.trim();
        if (!t) continue;
        if (!t.startsWith("-")) break;
        items.push(stripQuotes(t.replace(/^-+\s*/, "")));
      }
      if (items.length) out[key] = items;
      continue;
    }

    // Inline values
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      if (!inner) {
        out[key] = [];
      } else {
        out[key] = inner
          .split(",")
          .map((s) => stripQuotes(s))
          .map((s) => s.trim())
          .filter(Boolean);
      }
      continue;
    }

    out[key] = stripQuotes(rest);
  }

  return out;
}

export function parseSkillFrontMatter(markdown: string): {
  frontMatter: SkillFrontMatter | null;
  body: string;
  rawFrontMatter: string | null;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { frontMatter: null, body: markdown, rawFrontMatter: null };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { frontMatter: null, body: markdown, rawFrontMatter: null };

  const afterEndIdx = normalized.indexOf("\n", end + 1);
  if (afterEndIdx < 0) return { frontMatter: null, body: markdown, rawFrontMatter: null };

  const raw = normalized.slice(4, end).trimEnd();
  const body = normalized.slice(afterEndIdx + 1);
  const frontMatter = parseYamlLikeFrontMatter(raw);
  return { frontMatter, body, rawFrontMatter: raw };
}

export function sanitizeSkillText(input: unknown, maxLen: number): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.replaceAll("\0", "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const tags = input
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter(Boolean)
    .slice(0, 50);
  return Array.from(new Set(tags));
}
