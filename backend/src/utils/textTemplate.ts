import Handlebars from "handlebars";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toHandlebarsContext(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [rawKey, value] of Object.entries(vars ?? {})) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;

    const segments = key.split(".").filter(Boolean);
    if (segments.length <= 1) {
      out[key] = value;
      continue;
    }

    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (i === segments.length - 1) {
        cursor[seg] = value;
        break;
      }

      const existing = cursor[seg];
      if (!isPlainObject(existing)) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
  }

  return out;
}

export function renderTextTemplate(template: string, vars: Record<string, unknown>): string {
  const source = typeof template === "string" ? template : "";
  const context = toHandlebarsContext(vars);

  try {
    const compiled = Handlebars.compile(source, { noEscape: true });
    return compiled(context);
  } catch {
    return source;
  }
}

export function normalizeTemplateText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}
