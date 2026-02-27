import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";
import { toPublicProject } from "../utils/publicProject.js";

const workspaceModeSchema = z.enum(["worktree", "clone"]);
const workspacePolicySchema = z.enum(["git", "mount", "empty", "bundle"]);

const createProjectBodySchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  scmType: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  workspaceMode: workspaceModeSchema.optional(),
  workspacePolicy: workspacePolicySchema.optional(),
  defaultRoleKey: z.string().min(1).max(100).optional(),
  executionProfileId: z.string().uuid().optional(),
  agentWorkspaceNoticeTemplate: z.string().optional(),
  enableRuntimeSkillsMounting: z.boolean().optional(),
});

export function makeProjectRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async () => {
      const projects = await deps.prisma.project.findMany({ orderBy: { createdAt: "desc" } });

      if (projects.length === 0) {
        return { success: true, data: { projects: [] } };
      }

      const scmConfigs = await deps.prisma.projectScmConfig.findMany({
        where: { projectId: { in: projects.map((p: any) => p.id) } },
      });
      const scmConfigByProjectId = new Map(scmConfigs.map((c: any) => [c.projectId, c]));

      return {
        success: true,
        data: {
          projects: projects.map((p: any) =>
            toPublicProject({ ...p, scmConfig: scmConfigByProjectId.get(p.id) ?? null }),
          ),
        },
      };
    });

    server.post("/", async (request) => {
      const body = createProjectBodySchema.parse(request.body);
      const project = await deps.prisma.project.create({
        data: {
          id: uuidv7(),
          name: body.name,
          repoUrl: body.repoUrl,
          scmType: body.scmType ?? "gitlab",
          defaultBranch: body.defaultBranch ?? "main",
          workspaceMode: body.workspaceMode ?? "worktree",
          workspacePolicy: body.workspacePolicy ?? "git",
          defaultRoleKey: body.defaultRoleKey,
          executionProfileId: body.executionProfileId,
          agentWorkspaceNoticeTemplate: body.agentWorkspaceNoticeTemplate,
          enableRuntimeSkillsMounting: body.enableRuntimeSkillsMounting ?? false,
        }
      });
      return { success: true, data: { project: toPublicProject(project as any) } };
    });

    server.patch("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        name: z.string().min(1).optional(),
        repoUrl: z.string().min(1).optional(),
        scmType: z.string().min(1).optional(),
        defaultBranch: z.string().min(1).optional(),
        workspaceMode: workspaceModeSchema.nullable().optional(),
        workspacePolicy: workspacePolicySchema.nullable().optional(),
        defaultRoleKey: z.string().min(1).max(100).nullable().optional(),
        executionProfileId: z.string().uuid().nullable().optional(),
        agentWorkspaceNoticeTemplate: z.string().nullable().optional(),
        enableRuntimeSkillsMounting: z.boolean().optional(),
      });

      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const exists = await deps.prisma.project.findUnique({ where: { id } });
      if (!exists) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }

      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.repoUrl !== undefined) data.repoUrl = body.repoUrl;
      if (body.scmType !== undefined) data.scmType = body.scmType;
      if (body.defaultBranch !== undefined) data.defaultBranch = body.defaultBranch;
      if (body.workspaceMode !== undefined) data.workspaceMode = body.workspaceMode;
      if (body.workspacePolicy !== undefined) data.workspacePolicy = body.workspacePolicy;
      if (body.defaultRoleKey !== undefined) data.defaultRoleKey = body.defaultRoleKey;
      if (body.executionProfileId !== undefined) data.executionProfileId = body.executionProfileId;
      if (body.agentWorkspaceNoticeTemplate !== undefined) data.agentWorkspaceNoticeTemplate = body.agentWorkspaceNoticeTemplate;
      if (body.enableRuntimeSkillsMounting !== undefined) data.enableRuntimeSkillsMounting = body.enableRuntimeSkillsMounting;

      const project = await deps.prisma.project.update({
        where: { id },
        data: data as any
      });

      const scmConfig =
        typeof (deps.prisma as any)?.projectScmConfig?.findUnique === "function"
          ? await deps.prisma.projectScmConfig.findUnique({ where: { projectId: id } as any }).catch(() => null)
          : null;

      return {
        success: true,
        data: { project: toPublicProject({ ...(project as any), scmConfig: scmConfig ?? null }) },
      };
    });
  };
}
