import { z } from "zod";

import type { PrismaDeps } from "../../db.js";

const approvalActionSchema = z.enum(["merge_pr", "create_pr", "publish_artifact"]);

const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

export const pmPolicyV1Schema = z
  .object({
    version: z.literal(1).default(1),
    automation: z
      .object({
        autoStartIssue: z.boolean().default(true),
        autoReview: z.boolean().default(true),
        autoCreatePr: z.boolean().default(true),
        autoRequestMergeApproval: z.boolean().default(true),
        autoMerge: z.boolean().default(false),
        mergeMethod: mergeMethodSchema.default("squash"),
        ciGate: z.boolean().default(true),
      })
      .default({
        autoStartIssue: true,
        autoReview: true,
        autoCreatePr: true,
        autoRequestMergeApproval: true,
        autoMerge: false,
        mergeMethod: "squash",
        ciGate: true,
      }),
    approvals: z
      .object({
        requireForActions: z.array(approvalActionSchema).default(["merge_pr"]),
        escalateOnSensitivePaths: z.array(approvalActionSchema).default(["create_pr", "publish_artifact"]),
      })
      .default({ requireForActions: ["merge_pr"], escalateOnSensitivePaths: ["create_pr", "publish_artifact"] }),
    sensitivePaths: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PmPolicy = z.infer<typeof pmPolicyV1Schema>;

const DEFAULT_PM_POLICY: PmPolicy = pmPolicyV1Schema.parse({ version: 1 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getPmPolicyFromBranchProtection(branchProtection: unknown): { policy: PmPolicy; source: "project" | "default" } {
  if (!isRecord(branchProtection)) return { policy: DEFAULT_PM_POLICY, source: "default" };
  const candidate = (branchProtection as any).pmPolicy;
  const parsed = pmPolicyV1Schema.safeParse(candidate);
  if (!parsed.success) return { policy: DEFAULT_PM_POLICY, source: "default" };
  return { policy: parsed.data, source: "project" };
}

export async function getPmPolicyForProject(deps: { prisma: PrismaDeps }, projectId: string): Promise<
  | { success: true; data: { projectId: string; policy: PmPolicy; source: "project" | "default" } }
  | { success: false; error: { code: string; message: string } }
> {
  const project = await deps.prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, branchProtection: true },
  });
  if (!project) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

  const { policy, source } = getPmPolicyFromBranchProtection((project as any).branchProtection);
  return { success: true, data: { projectId: project.id, policy, source } };
}

export async function setPmPolicyForProject(deps: { prisma: PrismaDeps }, opts: {
  projectId: string;
  policy: unknown;
}): Promise<
  | { success: true; data: { projectId: string; policy: PmPolicy } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const validated = pmPolicyV1Schema.safeParse(opts.policy);
  if (!validated.success) {
    return { success: false, error: { code: "BAD_POLICY", message: "Policy 校验失败", details: validated.error.message } };
  }

  const project = await deps.prisma.project.findUnique({
    where: { id: opts.projectId },
    select: { id: true, branchProtection: true },
  });
  if (!project) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

  const existing = (project as any).branchProtection;
  const nextBranchProtection = isRecord(existing) ? { ...existing, pmPolicy: validated.data } : { pmPolicy: validated.data };

  await deps.prisma.project.update({
    where: { id: opts.projectId },
    data: { branchProtection: nextBranchProtection as any },
  });

  return { success: true, data: { projectId: project.id, policy: validated.data } };
}
