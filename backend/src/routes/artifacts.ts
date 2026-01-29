import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { planArtifactPublish, publishArtifact } from "../modules/artifacts/artifactPublish.js";
import { requestPublishArtifactApproval } from "../modules/approvals/approvalRequests.js";
import { getPmPolicyFromBranchProtection } from "../modules/pm/pmPolicy.js";
import { computeSensitiveHitFromPaths } from "../modules/pm/pmSensitivePaths.js";

export function makeArtifactRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.post("/artifacts/:id/publish", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ path: z.string().min(1).max(300).optional() });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const artifact = await deps.prisma.artifact.findUnique({
        where: { id },
        include: { run: { include: { issue: { include: { project: true } } } } } as any,
      });
      if (!artifact) return { success: false, error: { code: "NOT_FOUND", message: "Artifact 不存在" } };

      const project = (artifact as any)?.run?.issue?.project;
      if (!project) return { success: false, error: { code: "BAD_ARTIFACT", message: "Artifact 缺少 project" } };

      const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);
      const sensitivePatterns = Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [];
      const needSensitiveCheck =
        sensitivePatterns.length > 0 && policy.approvals.escalateOnSensitivePaths.includes("publish_artifact");

      const plan = await planArtifactPublish({ prisma: deps.prisma }, id, body);
      if (!plan.success) return plan;

      const sensitive = needSensitiveCheck ? computeSensitiveHitFromPaths([plan.data.path], sensitivePatterns) : null;
      const requireApproval =
        policy.approvals.requireForActions.includes("publish_artifact") ||
        (needSensitiveCheck && sensitive !== null);

      if (requireApproval) {
        const req = await requestPublishArtifactApproval({
          prisma: deps.prisma,
          artifactId: id,
          requestedBy: "api_publish_artifact",
          payload: {
            path: plan.data.path,
            sensitive: sensitive
              ? { patterns: sensitive.patterns.slice(0, 20), matchedFiles: sensitive.matchedFiles.slice(0, 60) }
              : undefined,
          },
        });
        if (!req.success) return req;

        return {
          success: false,
          error: {
            code: "APPROVAL_REQUIRED",
            message: "发布交付物属于受控动作，需要审批。已创建审批请求，请在 /api/approvals 中批准后执行。",
          },
          data: req.data,
        };
      }

      return await publishArtifact({ prisma: deps.prisma }, id, body);
    });
  };
}

