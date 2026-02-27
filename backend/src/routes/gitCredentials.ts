import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import { toPublicProject } from "../utils/publicProject.js";
import { isCredentialUsableForProject } from "../utils/projectCredentials.js";
import {
  SHARED_SCOPE_PLATFORM,
  SHARED_SCOPE_PROJECT,
  isPlatformScope,
} from "../utils/sharedScopes.js";
import { uuidv7 } from "../utils/uuid.js";

const gitAuthModeSchema = z.enum(["https_pat", "https_basic", "ssh"]);

const credentialCreateBodySchema = z.object({
  key: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255).optional(),
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

const credentialPatchBodySchema = z.object({
  key: z.string().min(1).max(100).optional(),
  displayName: z.string().min(1).max(255).optional(),
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

function isNonEmptyString(value: unknown): boolean {
  return !!String(value ?? "").trim();
}

function toGitCredentialDto(credential: any) {
  return {
    id: credential.id,
    projectId: credential.projectId ?? null,
    scope: isPlatformScope(credential?.scope) ? SHARED_SCOPE_PLATFORM : SHARED_SCOPE_PROJECT,
    key: credential.key,
    displayName: credential.displayName ?? credential.key,
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

function buildCredentialData(body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (body.key !== undefined) data.key = body.key;
  if (body.displayName !== undefined) data.displayName = body.displayName;
  if (body.purpose !== undefined) data.purpose = body.purpose ?? null;
  if (body.gitAuthMode !== undefined) data.gitAuthMode = body.gitAuthMode;
  if (body.githubAccessToken !== undefined) data.githubAccessToken = body.githubAccessToken;
  if (body.gitlabAccessToken !== undefined) data.gitlabAccessToken = body.gitlabAccessToken;
  if (body.gitHttpUsername !== undefined) data.gitHttpUsername = body.gitHttpUsername;
  if (body.gitHttpPassword !== undefined) data.gitHttpPassword = body.gitHttpPassword;
  if (body.gitSshCommand !== undefined) data.gitSshCommand = body.gitSshCommand;
  if (body.gitSshKey !== undefined) data.gitSshKey = body.gitSshKey;
  if (body.gitSshKeyB64 !== undefined) data.gitSshKeyB64 = body.gitSshKeyB64;
  return data;
}

async function findPlatformCredentialByKey(prisma: PrismaDeps, key: string) {
  return await prisma.gitCredential.findFirst({
    where: { key, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
  });
}

async function ensureProjectExists(prisma: PrismaDeps, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return { ok: false as const, res: { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } } };
  }
  return { ok: true as const, project };
}

export function makeGitCredentialRoutes(deps: {
  prisma: PrismaDeps;
  auth: AuthHelpers;
}): FastifyPluginAsync {
  return async (server) => {
    server.get("/:projectId/git-credentials", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const [projectCredentials, platformCredentials] = await Promise.all([
        deps.prisma.gitCredential.findMany({
          where: { projectId } as any,
          orderBy: { updatedAt: "desc" },
        }),
        deps.prisma.gitCredential.findMany({
          where: { scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
          orderBy: { updatedAt: "desc" },
        }),
      ]);

      return {
        success: true,
        data: {
          credentials: [...projectCredentials, ...platformCredentials].map(toGitCredentialDto),
        },
      };
    });

    server.post(
      "/:projectId/git-credentials",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid() });
        const { projectId } = paramsSchema.parse(request.params);
        const body = credentialCreateBodySchema.parse(request.body ?? {});

        const checked = await ensureProjectExists(deps.prisma, projectId);
        if (!checked.ok) return checked.res;

        const credential = await deps.prisma.gitCredential.create({
          data: {
            id: uuidv7(),
            projectId,
            scope: SHARED_SCOPE_PROJECT,
            key: body.key,
            displayName: body.displayName ?? body.key,
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
        const paramsSchema = z.object({
          projectId: z.string().uuid(),
          credentialId: z.string().uuid(),
        });
        const { projectId, credentialId } = paramsSchema.parse(request.params);
        const body = credentialPatchBodySchema.parse(request.body ?? {});

        const checked = await ensureProjectExists(deps.prisma, projectId);
        if (!checked.ok) return checked.res;

        const existing = await deps.prisma.gitCredential.findFirst({
          where: {
            id: credentialId,
            OR: [
              { projectId },
              { scope: SHARED_SCOPE_PLATFORM, projectId: null },
            ],
          } as any,
        });
        if (!existing) {
          return { success: false, error: { code: "NOT_FOUND", message: "GitCredential 不存在" } };
        }

        if (isPlatformScope((existing as any)?.scope) && body.key) {
          const duplicated = await findPlatformCredentialByKey(deps.prisma, body.key);
          if (duplicated && String((duplicated as any).id ?? "") !== credentialId) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: "平台公共 GitCredential key 已存在" },
            };
          }
        }

        const credential = await deps.prisma.gitCredential.update({
          where: { id: credentialId },
          data: buildCredentialData(body) as any,
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

        const checked = await ensureProjectExists(deps.prisma, projectId);
        if (!checked.ok) return checked.res;

        const existing = await deps.prisma.gitCredential.findFirst({
          where: {
            id: credentialId,
            OR: [
              { projectId },
              { scope: SHARED_SCOPE_PLATFORM, projectId: null },
            ],
          } as any,
        });
        if (!existing) {
          return { success: false, error: { code: "NOT_FOUND", message: "GitCredential 不存在" } };
        }

        const inUseProject = await deps.prisma.project.findFirst({
          where: {
            OR: [{ runGitCredentialId: credentialId }, { scmAdminCredentialId: credentialId }],
          } as any,
          select: { id: true },
        });
        if (inUseProject) {
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
          const cred = await deps.prisma.gitCredential.findUnique({ where: { id: body.runGitCredentialId } } as any);
          if (!cred || !isCredentialUsableForProject(cred, projectId)) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: "runGitCredentialId 不存在或不属于该 Project/平台公共配置" },
            };
          }
        }
        if (body.scmAdminCredentialId) {
          const cred = await deps.prisma.gitCredential.findUnique({ where: { id: body.scmAdminCredentialId } } as any);
          if (!cred || !isCredentialUsableForProject(cred, projectId)) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: "scmAdminCredentialId 不存在或不属于该 Project/平台公共配置" },
            };
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

export function makePlatformGitCredentialRoutes(deps: {
  prisma: PrismaDeps;
  auth: AuthHelpers;
}): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get("/git-credentials", { preHandler: requireAdmin }, async () => {
      const credentials = await deps.prisma.gitCredential.findMany({
        where: { scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
        orderBy: { updatedAt: "desc" },
      });
      return { success: true, data: { credentials: credentials.map(toGitCredentialDto) } };
    });

    server.post("/git-credentials", { preHandler: requireAdmin }, async (request) => {
      const body = credentialCreateBodySchema.parse(request.body ?? {});

      const duplicated = await findPlatformCredentialByKey(deps.prisma, body.key);
      if (duplicated) {
        return {
          success: false,
          error: { code: "BAD_INPUT", message: "平台公共 GitCredential key 已存在" },
        };
      }

      const credential = await deps.prisma.gitCredential.create({
        data: {
          id: uuidv7(),
          projectId: null,
          scope: SHARED_SCOPE_PLATFORM,
          key: body.key,
          displayName: body.displayName ?? body.key,
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
    });

    server.patch("/git-credentials/:credentialId", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ credentialId: z.string().uuid() });
      const { credentialId } = paramsSchema.parse(request.params);
      const body = credentialPatchBodySchema.parse(request.body ?? {});

      const existing = await deps.prisma.gitCredential.findFirst({
        where: { id: credentialId, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "平台公共 GitCredential 不存在" } };
      }

      if (body.key) {
        const duplicated = await findPlatformCredentialByKey(deps.prisma, body.key);
        if (duplicated && String((duplicated as any).id ?? "") !== credentialId) {
          return {
            success: false,
            error: { code: "BAD_INPUT", message: "平台公共 GitCredential key 已存在" },
          };
        }
      }

      const credential = await deps.prisma.gitCredential.update({
        where: { id: credentialId },
        data: buildCredentialData(body) as any,
      });

      return { success: true, data: { credential: toGitCredentialDto(credential) } };
    });

    server.delete("/git-credentials/:credentialId", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ credentialId: z.string().uuid() });
      const { credentialId } = paramsSchema.parse(request.params);

      const existing = await deps.prisma.gitCredential.findFirst({
        where: { id: credentialId, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "平台公共 GitCredential 不存在" } };
      }

      const inUseProject = await deps.prisma.project.findFirst({
        where: {
          OR: [{ runGitCredentialId: credentialId }, { scmAdminCredentialId: credentialId }],
        } as any,
        select: { id: true },
      });
      if (inUseProject) {
        return {
          success: false,
          error: { code: "BAD_INPUT", message: "该平台公共 GitCredential 已被项目引用，无法删除" },
        };
      }

      await deps.prisma.gitCredential.delete({ where: { id: credentialId } });

      return { success: true, data: { credentialId } };
    });
  };
}
