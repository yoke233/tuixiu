import { z } from "zod";

import type { PrismaDeps } from "../../deps.js";
import { callPmLlmJson, isPmLlmEnabled } from "./pmLlm.js";

export const pmRiskSchema = z.enum(["low", "medium", "high"]);

export const pmAnalysisSchema = z.object({
  summary: z.string().min(1),
  risk: pmRiskSchema,
  questions: z.array(z.string()).default([]),
  recommendedRoleKey: z.string().min(1).nullable().optional(),
  recommendedAgentId: z.string().min(1).nullable().optional(),
});

export type PmAnalysis = z.infer<typeof pmAnalysisSchema>;

function normalizeList(items: unknown, maxItems: number): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    const s = String(item ?? "").trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeRoleKey(roleKey: unknown, allowed: Set<string>): string | null {
  const raw = typeof roleKey === "string" ? roleKey.trim() : "";
  if (!raw) return null;
  return allowed.has(raw) ? raw : null;
}

function sanitizeAgentId(agentId: unknown, allowed: Set<string>): string | null {
  const raw = typeof agentId === "string" ? agentId.trim() : "";
  if (!raw) return null;
  return allowed.has(raw) ? raw : null;
}

export async function analyzeIssueForPm(opts: {
  prisma: PrismaDeps;
  issueId: string;
}): Promise<
  | { ok: true; analysis: PmAnalysis; meta: { source: "llm" | "fallback"; model?: string } }
  | { ok: false; error: { code: string; message: string; details?: string } }
> {
  const issue = await opts.prisma.issue.findUnique({
    where: { id: opts.issueId },
    include: { project: true },
  });
  if (!issue) {
    return { ok: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
  }

  const roles = await opts.prisma.roleTemplate.findMany({
    where: { projectId: (issue as any).projectId },
    orderBy: { createdAt: "asc" },
    select: { key: true, displayName: true, description: true },
  });

  const agents = await opts.prisma.agent.findMany({
    where: { status: "online" },
    orderBy: [{ currentLoad: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, currentLoad: true, maxConcurrentRuns: true, capabilities: true },
  });

  const roleKeys = new Set<string>(roles.map((role: any) => String(role?.key ?? "")).filter(Boolean));
  const idleAgents = (agents as any[]).filter((agent: any) => (agent?.currentLoad ?? 0) < (agent?.maxConcurrentRuns ?? 0));
  const agentIds = new Set<string>(idleAgents.map((agent: any) => String(agent?.id ?? "")).filter(Boolean));

  const fallbackRoleKey = String(((issue as any).project as any)?.defaultRoleKey ?? "").trim() || null;
  const fallback: PmAnalysis = {
    summary: String((issue as any).title ?? "").trim() || "（无标题）",
    risk: "medium",
    questions: [],
    recommendedRoleKey: fallbackRoleKey,
    recommendedAgentId: null,
  };

  if (!isPmLlmEnabled()) {
    return { ok: true, analysis: fallback, meta: { source: "fallback" } };
  }

  const roleLines = roles.length
    ? roles
        .slice(0, 30)
        .map((r: any) => `- ${r.key}${r.displayName ? ` (${r.displayName})` : ""}${r.description ? `: ${r.description}` : ""}`)
        .join("\n")
    : "- （无）";

  const agentLines = idleAgents.length
    ? idleAgents
        .slice(0, 20)
        .map((a: any) => `- ${a.id}: ${a.name} (load ${a.currentLoad}/${a.maxConcurrentRuns})`)
        .join("\n")
    : "- （无可用在线 Agent）";

  const messages = [
    {
      role: "system" as const,
      content: [
        "你是一个软件项目的项目管理员（PM）。",
        "你必须只输出严格的 JSON（不要 Markdown/代码块/解释）。",
        "目标：根据任务内容，从可选 roleKey/Agent 中做出最合适的推荐，并给出风险等级与需要澄清的问题。",
        "",
        "输出 JSON Schema：",
        "{",
        '  "summary": string,',
        '  "risk": "low" | "medium" | "high",',
        '  "questions": string[],',
        '  "recommendedRoleKey": string | null,',
        '  "recommendedAgentId": string | null',
        "}",
        "",
        "规则：",
        "- recommendedRoleKey 必须是给定列表中的一个，否则返回 null。",
        "- recommendedAgentId 必须是给定列表中的一个，否则返回 null。",
        "- questions 用于向提问者补齐信息，尽量少且关键（0-5 条）。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        "【任务】",
        `title: ${String((issue as any).title ?? "")}`,
        `description: ${String((issue as any).description ?? "")}`,
        `acceptanceCriteria: ${normalizeList((issue as any).acceptanceCriteria, 10).join(" | ")}`,
        `constraints: ${normalizeList((issue as any).constraints, 10).join(" | ")}`,
        `testRequirements: ${String((issue as any).testRequirements ?? "")}`,
        "",
        "【可选角色 roleKey】",
        roleLines,
        "",
        "【可用 Agent】",
        agentLines,
      ].join("\n"),
    },
  ];

  const res = await callPmLlmJson({ schema: pmAnalysisSchema, messages, temperature: 0.2, maxTokens: 400 });
  if (!res.ok) {
    return { ok: true, analysis: fallback, meta: { source: "fallback" } };
  }

  const analysis = res.value;
  const normalized: PmAnalysis = {
    summary: String((analysis as any).summary ?? fallback.summary).trim() || fallback.summary,
    risk: (analysis as any).risk,
    questions: normalizeList((analysis as any).questions, 8),
    recommendedRoleKey: sanitizeRoleKey((analysis as any).recommendedRoleKey, roleKeys),
    recommendedAgentId: sanitizeAgentId((analysis as any).recommendedAgentId, agentIds),
  };

  return { ok: true, analysis: normalized, meta: { source: "llm", model: res.model } };
}
