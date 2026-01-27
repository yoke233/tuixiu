import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

type StepKind = string;

type ContextDoc = {
  relPath: string;
  title: string;
  maxChars: number;
};

const contextManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    docs: z
      .record(
        z.object({
          path: z.string().min(1),
          title: z.string().min(1).optional(),
          maxChars: z.number().int().positive().optional(),
        }),
      )
      .default({}),
    defaults: z.array(z.string().min(1)).default([]),
    stepKinds: z.record(z.array(z.string().min(1))).default({}),
  })
  .passthrough();

type ContextManifest = z.infer<typeof contextManifestSchema>;

function uniqueInOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function truncateHead(text: string, maxChars: number): { text: string; truncated: boolean } {
  const src = String(text ?? "");
  if (src.length <= maxChars) return { text: src, truncated: false };
  return { text: `${src.slice(0, maxChars)}\n\n…（已截断，原始长度 ${src.length} 字符）`, truncated: true };
}

function defaultManifest(): ContextManifest {
  return {
    version: 1,
    docs: {
      projectContext: { path: "docs/project-context.md", title: "项目上下文（硬约束）", maxChars: 9000 },
      dod: { path: "docs/dod.md", title: "DoD（完成定义）", maxChars: 9000 },
    },
    defaults: ["projectContext"],
    stepKinds: {
      "code.review": ["dod"],
      "prd.review": ["dod"],
      "pr.create": ["dod"],
      "pr.merge": ["dod"],
      "ci.gate": ["dod"],
      "report.publish": ["dod"],
    },
  };
}

async function loadManifest(workspacePath: string): Promise<ContextManifest> {
  const candidates = ["docs/context-manifest.json"];
  for (const rel of candidates) {
    const fullPath = path.join(workspacePath, rel);
    let raw = "";
    try {
      raw = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const validated = contextManifestSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // ignore
    }
  }

  return defaultManifest();
}

function resolveDocsForStep(kind: StepKind, manifest: ContextManifest): ContextDoc[] {
  const stepKind = String(kind ?? "").trim();
  const defaults = Array.isArray(manifest.defaults) ? manifest.defaults : [];
  const extras = manifest.stepKinds && stepKind && Array.isArray(manifest.stepKinds[stepKind]) ? manifest.stepKinds[stepKind] : [];
  const docKeys = uniqueInOrder([...defaults, ...extras].filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()));

  const docs: ContextDoc[] = [];
  for (const key of docKeys) {
    const def = manifest.docs ? (manifest.docs as any)[key] : null;
    if (!def || typeof def !== "object") continue;

    const relPath = typeof (def as any).path === "string" ? String((def as any).path).trim() : "";
    if (!relPath) continue;
    const title = typeof (def as any).title === "string" && String((def as any).title).trim() ? String((def as any).title).trim() : relPath;
    const maxChars = typeof (def as any).maxChars === "number" && Number.isFinite((def as any).maxChars) ? Number((def as any).maxChars) : 9000;

    docs.push({ relPath, title, maxChars });
  }

  return docs;
}

export async function buildContextPackPrompt(opts: {
  workspacePath: string;
  stepKind: StepKind;
  totalMaxChars?: number;
}): Promise<string> {
  const workspacePath = String(opts.workspacePath ?? "").trim();
  if (!workspacePath) return "";

  const manifest = await loadManifest(workspacePath);
  const docs = resolveDocsForStep(opts.stepKind, manifest);
  const totalMaxChars = typeof opts.totalMaxChars === "number" && opts.totalMaxChars > 1000 ? opts.totalMaxChars : 14000;

  const blocks: string[] = [];
  let used = 0;

  for (const doc of docs) {
    const fullPath = path.join(workspacePath, doc.relPath);
    let raw = "";
    try {
      raw = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const { text } = truncateHead(raw.replace(/\r\n/g, "\n"), doc.maxChars);
    const header = `【Context Pack】${doc.title}\n（来源：${doc.relPath}）`;
    const block = `${header}\n\n${text}`.trim();

    const remaining = totalMaxChars - used;
    if (remaining <= 0) break;

    const { text: clipped, truncated } = truncateHead(block, remaining);
    blocks.push(truncated ? clipped : block);
    used += Math.min(block.length, remaining);
  }

  const uniqueBlocks = uniqueInOrder(blocks);
  if (!uniqueBlocks.length) return "";

  return uniqueBlocks.join("\n\n---\n\n");
}
