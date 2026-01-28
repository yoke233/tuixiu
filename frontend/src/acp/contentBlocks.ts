export type ContentBlock =
  | { type: "text"; text: string; annotations?: unknown; _meta?: Record<string, unknown> }
  | {
      type: "image";
      mimeType: string;
      data?: string;
      uri?: string | null;
      annotations?: unknown;
      _meta?: Record<string, unknown>;
    }
  | { type: "audio"; mimeType: string; data: string; annotations?: unknown; _meta?: Record<string, unknown> }
  | {
      type: "resource";
      resource:
        | { uri: string; text: string; mimeType?: string | null; _meta?: Record<string, unknown> }
        | { uri: string; blob: string; mimeType?: string | null; _meta?: Record<string, unknown> };
      annotations?: unknown;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string | null;
      title?: string | null;
      description?: string | null;
      size?: number | null;
      annotations?: unknown;
      _meta?: Record<string, unknown>;
    };

export function tryParseContentBlocks(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const type = (item as any).type;
    if (typeof type !== "string") return null;
    out.push(item as any);
  }
  return out;
}

export function summarizeContentBlocks(blocks: readonly ContentBlock[], opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 2000;
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(String(b.text ?? ""));
    else if (b.type === "image") parts.push(`[image ${b.mimeType}${b.uri ? ` ${b.uri}` : ""}]`);
    else if (b.type === "audio") parts.push(`[audio ${b.mimeType}]`);
    else if (b.type === "resource_link") parts.push(`[resource_link ${b.name} ${b.uri}]`);
    else if (b.type === "resource") parts.push(`[resource ${(b as any)?.resource?.uri ?? ""}]`);
    else parts.push(`[unknown ${(b as any).type}]`);
  }
  const s = parts.join("\n").trim();
  if (!s) return "";
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

