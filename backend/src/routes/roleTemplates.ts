import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import { normalizeAgentInputs } from "../modules/agentInputs/agentInputsSchema.js";
import { listEffectiveRoleTemplates } from "../utils/roleTemplates.js";
import { SHARED_SCOPE_PLATFORM, SHARED_SCOPE_PROJECT, isPlatformScope } from "../utils/sharedScopes.js";
import { uuidv7 } from "../utils/uuid.js";
import { listEnvKeys, listForbiddenGitEnvKeys } from "../utils/envText.js";

function normalizeEnvText(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("envText 必须是字符串（.env 格式）");
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function isAdminRequest(request: any): Promise<boolean> {
  const auth = String(request?.headers?.authorization ?? "").trim();
  if (!auth) return false;

  const jwtVerify = (request as any)?.jwtVerify;
  if (typeof jwtVerify !== "function") return false;

  try {
    await jwtVerify.call(request);
  } catch {
    return false;
  }

  const role = String(((request as any).user as any)?.role ?? "");
  return role === "admin";
}

function parseIncludePlatform(request: any): boolean {
  const raw = String((request?.query as any)?.includePlatform ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function toRoleDto(role: any, opts?: { includeEnvText?: boolean }): any {
  const { envText, agentInputs, ...rest } = role ?? {};
  const base = {
    ...rest,
    projectId: role?.projectId ?? null,
    scope: isPlatformScope(role?.scope) ? SHARED_SCOPE_PLATFORM : SHARED_SCOPE_PROJECT,
    agentInputs: agentInputs ?? null,
    envKeys: listEnvKeys(envText),
  };
  return opts?.includeEnvText ? { ...base, envText: envText ?? null } : base;
}

const roleCreateBodySchema = z.object({
  key: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  description: z.string().optional(),
  promptTemplate: z.string().optional(),
  initScript: z.string().optional(),
  initTimeoutSeconds: z.coerce.number().int().positive().max(3600).default(300),
  envText: z.string().max(20000).optional(),
  agentInputs: z.unknown().optional(),
  workspacePolicy: z.enum(["git", "mount", "empty", "bundle"]).optional(),
  executionProfileId: z.string().uuid().optional(),
});

const rolePatchBodySchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  promptTemplate: z.string().optional(),
  initScript: z.string().optional(),
  initTimeoutSeconds: z.coerce.number().int().positive().max(3600).optional(),
  envText: z.string().max(20000).nullable().optional(),
  agentInputs: z.unknown().nullable().optional(),
  workspacePolicy: z.enum(["git", "mount", "empty", "bundle"]).nullable().optional(),
  executionProfileId: z.string().uuid().nullable().optional(),
});

async function findPlatformRoleByKey(prisma: PrismaDeps, key: string) {
  return await prisma.roleTemplate.findFirst({
    where: { key, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
  });
}

function buildRoleAgentInputs(agentInputsRaw: unknown) {
  const agentInputs = normalizeAgentInputs(agentInputsRaw);
  return agentInputs === undefined ? undefined : agentInputs === null ? null : agentInputs;
}

function normalizeRoleBodyEnvOrError(envText: string | null | undefined) {
  if (envText !== undefined) {
    const forbidden = listForbiddenGitEnvKeys(envText);
    if (forbidden.length) {
      return {
        ok: false as const,
        res: {
          success: false,
          error: {
            code: "ROLE_ENV_GIT_KEYS_FORBIDDEN",
            message: "Git 认证已迁移到 GitCredential，请在 Project 凭证中配置",
            details: forbidden as any,
          },
        },
      };
    }
  }
  return { ok: true as const };
}

export function makeRoleTemplateRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/:projectId/roles", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const includeEnvText = await isAdminRequest(request);
      const includePlatform = parseIncludePlatform(request);
      const roles = await listEffectiveRoleTemplates(deps.prisma, {
        projectId,
        includePlatform,
        projectOrder: "desc",
      });

      return {
        success: true,
        data: { roles: roles.map((r: unknown) => toRoleDto(r, { includeEnvText })) },
      };
    });

    server.post("/:projectId/roles", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);
      const body = roleCreateBodySchema.parse(request.body ?? {});
      const envText = normalizeEnvText(body.envText);

      const envChecked = normalizeRoleBodyEnvOrError(envText);
      if (!envChecked.ok) return envChecked.res;

      const agentInputsForDb = buildRoleAgentInputs(body.agentInputs);

      const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }

      const role = await deps.prisma.roleTemplate.create({
        data: {
          id: uuidv7(),
          projectId,
          scope: SHARED_SCOPE_PROJECT,
          key: body.key,
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
          workspacePolicy: body.workspacePolicy ?? null,
          ...(body.executionProfileId
            ? { executionProfile: { connect: { id: body.executionProfileId } } }
            : {}),
          ...(envText !== undefined ? { envText } : {}),
          ...(agentInputsForDb !== undefined ? { agentInputs: agentInputsForDb as any } : {}),
        } as any,
      });

      return { success: true, data: { role: toRoleDto(role, { includeEnvText: true }) } };
    });

    server.patch("/:projectId/roles/:roleId", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
      const { projectId, roleId } = paramsSchema.parse(request.params);
      const body = rolePatchBodySchema.parse(request.body ?? {});
      const envText = normalizeEnvText(body.envText);

      const envChecked = normalizeRoleBodyEnvOrError(envText);
      if (!envChecked.ok) return envChecked.res;

      const agentInputsForDb = buildRoleAgentInputs(body.agentInputs);

      const existing = await deps.prisma.roleTemplate.findFirst({
        where: { id: roleId, projectId, scope: SHARED_SCOPE_PROJECT } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
      }

      const role = await deps.prisma.roleTemplate.update({
        where: { id: roleId },
        data: {
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
          ...(body.workspacePolicy !== undefined ? { workspacePolicy: body.workspacePolicy } : {}),
          ...(body.executionProfileId !== undefined
            ? body.executionProfileId === null
              ? { executionProfile: { disconnect: true } }
              : { executionProfile: { connect: { id: body.executionProfileId } } }
            : {}),
          ...(envText !== undefined ? { envText } : {}),
          ...(agentInputsForDb !== undefined ? { agentInputs: agentInputsForDb as any } : {}),
        },
      });

      return { success: true, data: { role: toRoleDto(role, { includeEnvText: true }) } };
    });

    server.delete("/:projectId/roles/:roleId", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
      const { projectId, roleId } = paramsSchema.parse(request.params);

      const existing = await deps.prisma.roleTemplate.findFirst({
        where: { id: roleId, projectId, scope: SHARED_SCOPE_PROJECT } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
      }

      await deps.prisma.roleTemplate.delete({ where: { id: roleId } });

      return { success: true, data: { roleId } };
    });
  };
}

export function makePlatformRoleTemplateRoutes(deps: {
  prisma: PrismaDeps;
  auth: AuthHelpers;
}): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get("/roles", { preHandler: requireAdmin }, async () => {
      const roles = await deps.prisma.roleTemplate.findMany({
        where: { scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
        orderBy: { createdAt: "desc" },
      });
      return {
        success: true,
        data: { roles: roles.map((role: any) => toRoleDto(role, { includeEnvText: true })) },
      };
    });

    server.post("/roles", { preHandler: requireAdmin }, async (request) => {
      const body = roleCreateBodySchema.parse(request.body ?? {});
      const envText = normalizeEnvText(body.envText);

      const envChecked = normalizeRoleBodyEnvOrError(envText);
      if (!envChecked.ok) return envChecked.res;

      const duplicated = await findPlatformRoleByKey(deps.prisma, body.key);
      if (duplicated) {
        return { success: false, error: { code: "BAD_INPUT", message: "平台公共 Role key 已存在" } };
      }

      const agentInputsForDb = buildRoleAgentInputs(body.agentInputs);
      const role = await deps.prisma.roleTemplate.create({
        data: {
          id: uuidv7(),
          projectId: null,
          scope: SHARED_SCOPE_PLATFORM,
          key: body.key,
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
          workspacePolicy: body.workspacePolicy ?? null,
          ...(body.executionProfileId
            ? { executionProfile: { connect: { id: body.executionProfileId } } }
            : {}),
          ...(envText !== undefined ? { envText } : {}),
          ...(agentInputsForDb !== undefined ? { agentInputs: agentInputsForDb as any } : {}),
        } as any,
      });

      return { success: true, data: { role: toRoleDto(role, { includeEnvText: true }) } };
    });

    server.patch("/roles/:roleId", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ roleId: z.string().uuid() });
      const { roleId } = paramsSchema.parse(request.params);
      const body = rolePatchBodySchema.parse(request.body ?? {});
      const envText = normalizeEnvText(body.envText);

      const envChecked = normalizeRoleBodyEnvOrError(envText);
      if (!envChecked.ok) return envChecked.res;

      const agentInputsForDb = buildRoleAgentInputs(body.agentInputs);

      const existing = await deps.prisma.roleTemplate.findFirst({
        where: { id: roleId, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "平台公共 RoleTemplate 不存在" } };
      }

      const role = await deps.prisma.roleTemplate.update({
        where: { id: roleId },
        data: {
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
          ...(body.workspacePolicy !== undefined ? { workspacePolicy: body.workspacePolicy } : {}),
          ...(body.executionProfileId !== undefined
            ? body.executionProfileId === null
              ? { executionProfile: { disconnect: true } }
              : { executionProfile: { connect: { id: body.executionProfileId } } }
            : {}),
          ...(envText !== undefined ? { envText } : {}),
          ...(agentInputsForDb !== undefined ? { agentInputs: agentInputsForDb as any } : {}),
        },
      });

      return { success: true, data: { role: toRoleDto(role, { includeEnvText: true }) } };
    });

    server.delete("/roles/:roleId", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ roleId: z.string().uuid() });
      const { roleId } = paramsSchema.parse(request.params);

      const existing = await deps.prisma.roleTemplate.findFirst({
        where: { id: roleId, scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
      });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "平台公共 RoleTemplate 不存在" } };
      }

      const inUseProject = await deps.prisma.project.findFirst({
        where: {
          defaultRoleKey: String((existing as any).key ?? ""),
          NOT: {
            roles: {
              some: {
                key: String((existing as any).key ?? ""),
                scope: SHARED_SCOPE_PROJECT,
              },
            },
          },
        } as any,
        select: { id: true },
      });
      if (inUseProject) {
        return {
          success: false,
          error: { code: "BAD_INPUT", message: "该平台公共 Role 已被项目默认角色引用，无法删除" },
        };
      }

      await deps.prisma.roleTemplate.delete({ where: { id: roleId } });

      return { success: true, data: { roleId } };
    });
  };
}
