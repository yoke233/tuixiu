import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import { toPublicProject } from "../utils/publicProject.js";
import { uuidv7 } from "../utils/uuid.js";

const gitAuthModeSchema = z.enum(["https_pat", "https_basic", "ssh"]);

function isNonEmptyString(value: unknown): boolean {
  return !!String(value ?? "").trim();
}

function toGitCredentialDto(credential: any) {
  return {
    id: credential.id,
    projectId: credential.projectId,
    key: credential.key,
    purpose: credential.purpose ?? null,
    gitAuthMode: credential.gitAuthMode,
    hasGithubAccessToken: isNonEmptyString(credential.githubAccessToken),
    hasGitlabAccessToken: isNonEmptyString(credential.gitlabAccessToken),
    gitHttpUsername: credential.gitHttpUsername ?? null,
    hasGitHttpPassword: isNonEmptyString(credential.gitHttpPassword),
    hasSshKey: isNonEmptyString(credential.gitSshKey) || isNonEmptyString(credential.gitSshKeyB64),
    updatedAt: credential.updatedAt,
  };
}

export function makeGitCredentialRoutes(deps: { prisma: PrismaDeps; auth: AuthHelpers }): FastifyPluginAsync {
  return async (server) => {
    server.get("/:projectId/git-credentials", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const credentials = await deps.prisma.gitCredential.findMany({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      });
      return { success: true, data: { credentials: credentials.map(toGitCredentialDto) } };
    });

    server.post(
      "/:projectId/git-credentials",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid() });
        const bodySchema = z.object({
          key: z.string().min(1).max(100),
          purpose: z.string().min(1).max(20).optional(),
          gitAuthMode: gitAuthModeSchema.optional(),
          githubAccessToken: z.string().min(1).optional(),
          gitlabAccessToken: z.string().min(1).optional(),
          gitHttpUsername: z.string().min(1).optional(),
          gitHttpPassword: z.string().min(1).optional(),
          gitSshCommand: z.string().min(1).optional(),
          gitSshKey: z.string().min(1).optional(),
          gitSshKeyB64: z.string().min(1).optional(),
        });

        const { projectId } = paramsSchema.parse(request.params);
        const body = bodySchema.parse(request.body ?? {});

        const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
        if (!project) {
          return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
        }

        const credential = await deps.prisma.gitCredential.create({
          data: {
            id: uuidv7(),
            projectId,
            key: body.key,
            purpose: body.purpose ?? null,
            gitAuthMode: body.gitAuthMode ?? "https_pat",
            githubAccessToken: body.githubAccessToken ?? null,
            gitlabAccessToken: body.gitlabAccessToken ?? null,
            gitHttpUsername: body.gitHttpUsername ?? null,
            gitHttpPassword: body.gitHttpPassword ?? null,
            gitSshCommand: body.gitSshCommand ?? null,
            gitSshKey: body.gitSshKey ?? null,
            gitSshKeyB64: body.gitSshKeyB64 ?? null,
          } as any,
        });

        return { success: true, data: { credential: toGitCredentialDto(credential) } };
      },
    );

    server.patch(
      "/:projectId/git-credentials/:credentialId",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid(), credentialId: z.string().uuid() });
        const bodySchema = z.object({
          key: z.string().min(1).max(100).optional(),
          purpose: z.string().min(1).max(20).nullable().optional(),
          gitAuthMode: gitAuthModeSchema.optional(),
          githubAccessToken: z.string().min(1).nullable().optional(),
          gitlabAccessToken: z.string().min(1).nullable().optional(),
          gitHttpUsername: z.string().min(1).nullable().optional(),
          gitHttpPassword: z.string().min(1).nullable().optional(),
          gitSshCommand: z.string().min(1).nullable().optional(),
          gitSshKey: z.string().min(1).nullable().optional(),
          gitSshKeyB64: z.string().min(1).nullable().optional(),
        });

        const { projectId, credentialId } = paramsSchema.parse(request.params);
        const body = bodySchema.parse(request.body ?? {});

        const existing = await deps.prisma.gitCredential.findFirst({
          where: { id: credentialId, projectId },
        });
        if (!existing) {
          return { success: false, error: { code: "NOT_FOUND", message: "GitCredential 不存在" } };
        }

        const data: Record<string, unknown> = {};
        if (body.key !== undefined) data.key = body.key;
        if (body.purpose !== undefined) data.purpose = body.purpose;
        if (body.gitAuthMode !== undefined) data.gitAuthMode = body.gitAuthMode;
        if (body.githubAccessToken !== undefined) data.githubAccessToken = body.githubAccessToken;
        if (body.gitlabAccessToken !== undefined) data.gitlabAccessToken = body.gitlabAccessToken;
        if (body.gitHttpUsername !== undefined) data.gitHttpUsername = body.gitHttpUsername;
        if (body.gitHttpPassword !== undefined) data.gitHttpPassword = body.gitHttpPassword;
        if (body.gitSshCommand !== undefined) data.gitSshCommand = body.gitSshCommand;
        if (body.gitSshKey !== undefined) data.gitSshKey = body.gitSshKey;
        if (body.gitSshKeyB64 !== undefined) data.gitSshKeyB64 = body.gitSshKeyB64;

        const credential = await deps.prisma.gitCredential.update({
          where: { id: credentialId },
          data: data as any,
        });

        return { success: true, data: { credential: toGitCredentialDto(credential) } };
      },
    );

    server.delete(
      "/:projectId/git-credentials/:credentialId",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid(), credentialId: z.string().uuid() });
        const { projectId, credentialId } = paramsSchema.parse(request.params);

        const existing = await deps.prisma.gitCredential.findFirst({
          where: { id: credentialId, projectId },
        });
        if (!existing) {
          return { success: false, error: { code: "NOT_FOUND", message: "GitCredential 不存在" } };
        }

        const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
        if (project && (project.runGitCredentialId === credentialId || project.scmAdminCredentialId === credentialId)) {
          return {
            success: false,
            error: { code: "BAD_INPUT", message: "该 GitCredential 已被设为默认，无法删除" },
          };
        }

        await deps.prisma.gitCredential.delete({ where: { id: credentialId } });

        return { success: true, data: { credentialId } };
      },
    );

    server.patch(
      "/:projectId/git-credentials-defaults",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid() });
        const bodySchema = z.object({
          runGitCredentialId: z.string().uuid().nullable().optional(),
          scmAdminCredentialId: z.string().uuid().nullable().optional(),
        });

        const { projectId } = paramsSchema.parse(request.params);
        const body = bodySchema.parse(request.body ?? {});

        const existingProject = await deps.prisma.project.findUnique({ where: { id: projectId } });
        if (!existingProject) {
          return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
        }

        if (body.runGitCredentialId) {
          const cred = await deps.prisma.gitCredential.findFirst({
            where: { id: body.runGitCredentialId, projectId },
          });
          if (!cred) {
            return { success: false, error: { code: "BAD_INPUT", message: "runGitCredentialId 不存在或不属于该 Project" } };
          }
        }
        if (body.scmAdminCredentialId) {
          const cred = await deps.prisma.gitCredential.findFirst({
            where: { id: body.scmAdminCredentialId, projectId },
          });
          if (!cred) {
            return { success: false, error: { code: "BAD_INPUT", message: "scmAdminCredentialId 不存在或不属于该 Project" } };
          }
        }

        const data: Record<string, unknown> = {};
        if (body.runGitCredentialId !== undefined) data.runGitCredentialId = body.runGitCredentialId;
        if (body.scmAdminCredentialId !== undefined) data.scmAdminCredentialId = body.scmAdminCredentialId;

        const project = await deps.prisma.project.update({
          where: { id: projectId },
          data: data as any,
        });

        return { success: true, data: { project: toPublicProject(project as any) } };
      },
    );
  };
}
