import fs from "node:fs/promises";
import path from "node:path";

type StepKind = string;

type ContextDoc = {
  relPath: string;
  title: string;
  maxChars: number;
};

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

function resolveDocsForStep(kind: StepKind): ContextDoc[] {
  const k = String(kind ?? "").trim();
  const docs: ContextDoc[] = [];

  // 通用：任何步骤都需要了解仓库硬约束
  docs.push({ relPath: "docs/project-context.md", title: "项目上下文（硬约束）", maxChars: 9000 });

  // 评审/合并/交付相关：引入 DoD
  const needsDod = [
    "code.review",
    "prd.review",
    "pr.create",
    "pr.merge",
    "ci.gate",
    "report.publish",
  ].includes(k);
  if (needsDod) docs.push({ relPath: "docs/dod.md", title: "DoD（完成定义）", maxChars: 9000 });

  return docs;
}

export async function buildContextPackPrompt(opts: {
  workspacePath: string;
  stepKind: StepKind;
  totalMaxChars?: number;
}): Promise<string> {
  const workspacePath = String(opts.workspacePath ?? "").trim();
  if (!workspacePath) return "";

  const docs = resolveDocsForStep(opts.stepKind);
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

