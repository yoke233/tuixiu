import { z } from "zod";
import type { Annotations, ContentBlock, EmbeddedResourceResource } from "@agentclientprotocol/sdk";

export type AcpEmbeddedResourceResource = EmbeddedResourceResource;
export type AcpContentBlock = ContentBlock;

const metaSchema = z.record(z.unknown()).optional();

const annotationsObjectSchema: z.ZodType<Annotations> = z
  .object({
    _meta: metaSchema,
    audience: z.array(z.enum(["assistant", "user"])).nullable().optional(),
    lastModified: z.string().nullable().optional(),
    priority: z.number().nullable().optional(),
  })
  .passthrough();

const annotationsSchema = annotationsObjectSchema.nullable().optional();

const embeddedTextResourceSchema = z
  .object({
    uri: z.string().min(1),
    text: z.string(),
    mimeType: z.string().nullable().optional(),
    _meta: metaSchema,
  })
  .passthrough();

const embeddedBlobResourceSchema = z
  .object({
    uri: z.string().min(1),
    blob: z.string(),
    mimeType: z.string().nullable().optional(),
    _meta: metaSchema,
  })
  .passthrough();

export const acpEmbeddedResourceResourceSchema = z.union([embeddedTextResourceSchema, embeddedBlobResourceSchema]) satisfies z.ZodType<AcpEmbeddedResourceResource>;

export const acpContentBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.string().min(1),
      data: z.string().min(1),
      uri: z.string().nullable().optional(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("audio"),
      mimeType: z.string().min(1),
      data: z.string().min(1),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource"),
      resource: acpEmbeddedResourceResourceSchema,
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource_link"),
      uri: z.string().min(1),
      name: z.string().min(1),
      mimeType: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      size: z.number().int().nonnegative().nullable().optional(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
]) satisfies z.ZodType<AcpContentBlock>;

export const acpContentBlocksSchema = z.array(acpContentBlockSchema);
export const acpPromptSchema = acpContentBlocksSchema.min(1);

export type ClientAcpContentBlock =
  | { type: "text"; text: string; annotations?: Annotations | null; _meta?: Record<string, unknown> }
  | {
      type: "image";
      mimeType: string;
      data?: string;
      uri?: string | null;
      annotations?: Annotations | null;
      _meta?: Record<string, unknown>;
    }
  | { type: "audio"; mimeType: string; data: string; annotations?: Annotations | null; _meta?: Record<string, unknown> }
  | { type: "resource"; resource: AcpEmbeddedResourceResource; annotations?: Annotations | null; _meta?: Record<string, unknown> }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string | null;
      title?: string | null;
      description?: string | null;
      size?: number | null;
      annotations?: Annotations | null;
      _meta?: Record<string, unknown>;
    };

export const clientAcpContentBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.string().min(1),
      data: z.string().min(1).optional(),
      uri: z.string().nullable().optional(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("audio"),
      mimeType: z.string().min(1),
      data: z.string().min(1),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource"),
      resource: acpEmbeddedResourceResourceSchema,
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource_link"),
      uri: z.string().min(1),
      name: z.string().min(1),
      mimeType: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      size: z.number().int().nonnegative().nullable().optional(),
      annotations: annotationsSchema,
      _meta: metaSchema,
    })
    .passthrough(),
]) satisfies z.ZodType<ClientAcpContentBlock>;

export const clientAcpPromptSchema = z.array(clientAcpContentBlockSchema).min(1);

export function tryParseAcpContentBlocks(value: unknown): AcpContentBlock[] | null {
  const parsed = acpContentBlocksSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function summarizeAcpContentBlocks(blocks: readonly AcpContentBlock[], opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 2000;
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push(`[image ${block.mimeType}${block.uri ? ` ${block.uri}` : ""}]`);
        break;
      case "audio":
        parts.push(`[audio ${block.mimeType}]`);
        break;
      case "resource_link":
        parts.push(`[resource_link ${block.name} ${block.uri}]`);
        break;
      case "resource": {
        const res = block.resource as any;
        const uri = typeof res?.uri === "string" ? res.uri : "";
        const mimeType = typeof res?.mimeType === "string" ? res.mimeType : "";
        if (res && typeof res === "object" && "text" in res && typeof res.text === "string") {
          const text = res.text.trim();
          const snippet = text.length > 240 ? `${text.slice(0, 240)}…` : text;
          parts.push(`[resource ${uri}${mimeType ? ` ${mimeType}` : ""}]\n${snippet}`);
        } else {
          parts.push(`[resource ${uri}${mimeType ? ` ${mimeType}` : ""} <blob>]`);
        }
        break;
      }
      default:
        parts.push(`[unknown ${(block as any).type ?? "unknown"}]`);
        break;
    }
  }

  const out = parts.join("\n").trim();
  if (!out) return "";
  if (maxChars <= 0) return "";
  if (out.length <= maxChars) return out;
  return `${out.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function compactAcpPromptForEvent(prompt: readonly AcpContentBlock[]): AcpContentBlock[] {
  return prompt.map((b) => {
    if (b.type === "image") return { ...b, data: "<omitted>" };
    if (b.type === "audio") return { ...b, data: "<omitted>" };
    if (b.type === "resource") {
      const r: any = b.resource;
      if (r && typeof r === "object" && "blob" in r) return { ...b, resource: { ...r, blob: "<omitted>" } };
      return b;
    }
    return b;
  });
}
