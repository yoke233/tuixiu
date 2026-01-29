import { z } from "zod";

import type { PrismaDeps } from "../../deps.js";
import { callPmLlmJson, isPmLlmEnabled } from "./pmLlm.js";
import { renderTextTemplateFromDb } from "../../services/textTemplates.js";

export const pmRiskSchema = z.enum(["low", "medium", "high"]);

export const pmTrackSchema = z.enum(["quick", "planning", "enterprise"]);

export const pmAnalysisSchema = z.object({
  summary: z.string().min(1),
  risk: pmRiskSchema,
  questions: z.array(z.string()).default([]),
  recommendedRoleKey: z.string().min(1).nullable().optional(),
  recommendedAgentId: z.string().min(1).nullable().optional(),
  recommendedTrack: pmTrackSchema.nullable().optional(),
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

function sanitizeTrack(track: unknown): z.infer<typeof pmTrackSchema> | null {
  const raw = typeof track === "string" ? track.trim().toLowerCase() : "";
  if (!raw) return null;
  if (raw === "quick" || raw === "planning" || raw === "enterprise") return raw;
  return null;
}

function inferTrackFromIssue(issue: any): z.infer<typeof pmTrackSchema> {
  const title = String(issue?.title ?? "").toLowerCase();
  const desc = String(issue?.description ?? "").toLowerCase();
  const acceptanceCriteria = normalizeList(issue?.acceptanceCriteria, 30).join(" | ").toLowerCase();
  const constraints = normalizeList(issue?.constraints, 30).join(" | ").toLowerCase();
  const labels = [...normalizeList(issue?.labels, 30), ...normalizeList(issue?.externalLabels, 30)].join(" | ").toLowerCase();
  const text = `${title}\n${desc}\n${acceptanceCriteria}\n${constraints}\n${labels}`;

  const enterpriseHints = [
    "enterprise",
    "compliance",
    "audit",
    "soc2",
    "sox",
    "gdpr",
    "pci",
    "hipaa",
    "iso",
    "合规",
    "审计",
    "法务",
    "监管",
    "隐私",
    "等保",
  ];

  for (const hint of enterpriseHints) {
    if (text.includes(hint)) return "enterprise";
  }

  const planningHints = [
    "prd",
    "design",
    "architecture",
    "workflow",
    "adr",
    "epic",
    "roadmap",
    "milestone",
    "release",
    "migration",
    "migrate",
    "prisma",
    "database",
    "schema",
    "auth",
    "jwt",
    "token",
    "permission",
    "rbac",
    "security",
    "webhook",
    "ci",
    "pipeline",
    "policy",
    "gate",
    "dod",
    "refactor",
    "breaking",
    "方案",
    "设计",
    "架构",
    "重构",
    "迁移",
    "数据库",
    "权限",
    "鉴权",
    "安全",
    "门禁",
    "策略",
    "流水线",
    "发布",
    "里程碑",
  ];

  for (const hint of planningHints) {
    if (text.includes(hint)) return "planning";
  }

  const quickHints = [
    "typo",
    "docs",
    "readme",
    "chore",
    "minor",
    "small",
    "copy",
    "text",
    "文档",
    "错别字",
    "小改",
    "微调",
  ];

  for (const hint of quickHints) {
    if (text.includes(hint)) return "quick";
  }

  const descLen = typeof issue?.description === "string" ? issue.description.length : 0;
  if (descLen >= 1800) return "planning";
  if (normalizeList(issue?.acceptanceCriteria, 50).length >= 8) return "planning";
  if (normalizeList(issue?.constraints, 50).length >= 8) return "planning";

  return "quick";
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
    recommendedTrack: inferTrackFromIssue(issue),
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

  const systemContent = await renderTextTemplateFromDb(
    { prisma: opts.prisma },
    { key: "pm.analyzeIssue.system", projectId: (issue as any).projectId, vars: {} },
  );
  const userContent = await renderTextTemplateFromDb(
    { prisma: opts.prisma },
    {
      key: "pm.analyzeIssue.user",
      projectId: (issue as any).projectId,
      vars: {
        title: String((issue as any).title ?? ""),
        description: String((issue as any).description ?? ""),
        labels: normalizeList((issue as any).labels, 20).join(" | "),
        externalLabels: normalizeList((issue as any).externalLabels, 20).join(" | "),
        acceptanceCriteria: normalizeList((issue as any).acceptanceCriteria, 10).join(" | "),
        constraints: normalizeList((issue as any).constraints, 10).join(" | "),
        testRequirements: String((issue as any).testRequirements ?? ""),
        roleLines,
        agentLines,
      },
    },
  );

  const messages = [
    {
      role: "system" as const,
      content: systemContent,
    },
    {
      role: "user" as const,
      content: userContent,
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
    recommendedTrack: sanitizeTrack((analysis as any).recommendedTrack) ?? fallback.recommendedTrack,
  };

  return { ok: true, analysis: normalized, meta: { source: "llm", model: res.model } };
}
