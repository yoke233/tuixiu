import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { createRunWorktree, suggestRunKey } from "../utils/gitWorkspace.js";
import { parseEnvText } from "../utils/envText.js";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickBoxliteWorkspaceMode(agent: any): "mount" | "git_clone" | null {
  const caps = agent?.capabilities;
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  if (sandbox.provider !== "boxlite_oci") return null;
  const boxlite = sandbox.boxlite;
  if (!isRecord(boxlite)) return "mount";
  const mode = boxlite.workspaceMode;
  return mode === "git_clone" ? "git_clone" : "mount";
}

function pickBoxliteWorkingDir(agent: any): string | null {
  const caps = agent?.capabilities;
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  if (sandbox.provider !== "boxlite_oci") return null;
  const boxlite = sandbox.boxlite;
  if (!isRecord(boxlite)) return null;
  const wd = boxlite.workingDir;
  return typeof wd === "string" && wd.trim() ? wd.trim() : null;
}

function pickRoleEnv(role: any): Record<string, string> {
  return parseEnvText(role?.envText);
}

const issueStatusSchema = z.enum([
  "pending",
  "running",
  "reviewing",
  "done",
  "failed",
  "cancelled"
]);

const mutableIssueStatusSchema = z.enum(["pending", "reviewing", "done", "failed", "cancelled"]);

const createIssueBodySchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  testRequirements: z.string().optional()
});

export function makeIssueRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent: SendToAgent;
  createWorkspace?: typeof createRunWorktree;
}): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async (request) => {
      const querySchema = z.object({
        status: issueStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0)
      });
      const { status, limit, offset } = querySchema.parse(request.query);

      const where = status ? { status } : {};
      const [total, issues] = await Promise.all([
        deps.prisma.issue.count({ where }),
        deps.prisma.issue.findMany({
          where,
          include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset
        })
      ]);

      return { success: true, data: { issues, total, limit, offset } };
    });

    server.get("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const issue = await deps.prisma.issue.findUnique({
        where: { id },
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } }
      });
      if (!issue) {
        return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
      }
      return { success: true, data: { issue } };
    });

    server.post("/", async (request) => {
      const body = createIssueBodySchema.parse(request.body);

      const project = body.projectId
        ? await deps.prisma.project.findUnique({ where: { id: body.projectId } })
        : await deps.prisma.project.findFirst({ orderBy: { createdAt: "desc" } });

      if (!project) {
        return { success: false, error: { code: "NO_PROJECT", message: "请先创建 Project" } };
      }

      const issue = await deps.prisma.issue.create({
        data: {
          id: uuidv7(),
          projectId: project.id,
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          constraints: body.constraints,
          testRequirements: body.testRequirements
        }
      });

      // 默认只创建 Issue，进入需求池（pending）。
      // 后续由 /api/issues/:id/start 指定 Agent 并启动 Run。
      return { success: true, data: { issue } };
    });

    server.post("/:id/start", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        agentId: z.string().uuid().optional(),
        roleKey: z.string().min(1).max(100).optional(),
        worktreeName: z.string().trim().min(1).max(100).optional()
      });
      const { id } = paramsSchema.parse(request.params);
      const { agentId, roleKey, worktreeName } = bodySchema.parse(request.body ?? {});

      const issue = await deps.prisma.issue.findUnique({
        where: { id },
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } }
      });
      if (!issue) {
        return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
      }
      if (issue.status === "running") {
        return { success: false, error: { code: "ALREADY_RUNNING", message: "Issue 正在运行中" } };
      }

      const selectedAgent = agentId
        ? await deps.prisma.agent.findUnique({ where: { id: agentId } })
        : (
            await deps.prisma.agent.findMany({
              where: { status: "online" },
              orderBy: { createdAt: "asc" }
            })
          ).find(
            (a: { currentLoad: number; maxConcurrentRuns: number }) => a.currentLoad < a.maxConcurrentRuns,
          ) ?? null;

      if (!selectedAgent || selectedAgent.status !== "online") {
        return { success: false, error: { code: "NO_AGENT", message: "没有可用的 Agent" } };
      }
      if (selectedAgent.currentLoad >= selectedAgent.maxConcurrentRuns) {
        return { success: false, error: { code: "AGENT_BUSY", message: "该 Agent 正忙" } };
      }

      const wantsBoxliteClone = pickBoxliteWorkspaceMode(selectedAgent) === "git_clone";

      const effectiveRoleKey = roleKey?.trim() ? roleKey.trim() : (issue.project as any)?.defaultRoleKey?.trim() ?? "";
      const role = effectiveRoleKey
        ? await deps.prisma.roleTemplate.findFirst({ where: { projectId: issue.projectId, key: effectiveRoleKey } })
        : null;

      if (effectiveRoleKey && !role) {
        return { success: false, error: { code: "NO_ROLE", message: "RoleTemplate 不存在" } };
      }

      const run = await deps.prisma.run.create({
        data: {
          id: uuidv7(),
          issueId: issue.id,
          agentId: selectedAgent.id,
          status: "running",
          metadata: role ? ({ roleKey: role.key } as any) : undefined
        }
      });

      await deps.prisma.issue.update({
        where: { id: issue.id },
        data: { status: "running", assignedAgentId: selectedAgent.id }
      });
      await deps.prisma.agent.update({
        where: { id: selectedAgent.id },
        data: { currentLoad: { increment: 1 } }
      });

      let workspacePath = "";
      let branchName = "";
      try {
        const baseBranch = issue.project.defaultBranch || "main";
        const runNumber = (Array.isArray(issue.runs) ? issue.runs.length : 0) + 1;
        const requestedName =
          typeof worktreeName === "string" && worktreeName.trim()
            ? worktreeName.trim()
            : "";

        const defaultKey = suggestRunKey({
          title: issue.title,
          externalProvider: (issue as any).externalProvider,
          externalNumber: (issue as any).externalNumber,
          runNumber
        });

        const runKeyForBranch = requestedName
          ? suggestRunKey({ title: requestedName })
          : defaultKey;

        if (wantsBoxliteClone) {
          workspacePath = pickBoxliteWorkingDir(selectedAgent) ?? "/workspace";
          const suffix = run.id.slice(0, 8);
          branchName = `run/${runKeyForBranch}-${suffix}`;

          await deps.prisma.run.update({
            where: { id: run.id },
            data: {
              workspaceType: "boxlite_clone",
              workspacePath,
              branchName
            }
          });
          await deps.prisma.artifact.create({
            data: {
              id: uuidv7(),
              runId: run.id,
              type: "branch",
              content: { branch: branchName, baseBranch, workspacePath, workspaceType: "boxlite_clone" } as any
            }
          });
        } else {
          const nameForWorktree = requestedName || defaultKey;
          const ws = await (deps.createWorkspace ?? createRunWorktree)({ runId: run.id, baseBranch, name: nameForWorktree });
          workspacePath = ws.workspacePath;
          branchName = ws.branchName;

          await deps.prisma.run.update({
            where: { id: run.id },
            data: {
              workspaceType: "worktree",
              workspacePath,
              branchName
            }
          });
          await deps.prisma.artifact.create({
            data: {
              id: uuidv7(),
              runId: run.id,
              type: "branch",
              content: { branch: branchName, baseBranch, workspacePath } as any
            }
          });
        }
      } catch (error) {
        await deps.prisma.run.update({
          where: { id: run.id },
          data: { status: "failed", completedAt: new Date(), errorMessage: `创建 workspace 失败: ${String(error)}` }
        });
        await deps.prisma.issue.update({ where: { id: issue.id }, data: { status: "failed" } }).catch(() => {});
        await deps.prisma.agent
          .update({ where: { id: selectedAgent.id }, data: { currentLoad: { decrement: 1 } } })
          .catch(() => {});

        return {
          success: false,
          error: {
            code: "WORKSPACE_FAILED",
            message: "创建 Run 工作区失败",
            details: String(error)
          },
          data: { issue, run }
        };
      }

      const promptParts: string[] = [];
      promptParts.push(
        wantsBoxliteClone
          ? [
              "你正在 BoxLite 沙箱内的独立 workspace（git_clone 模式）中执行任务：",
              `- workspace(guest): ${workspacePath}`,
              `- branch: ${branchName}`,
              "",
              "重要：该模式下后端不会替你 push。请在完成修改后执行：",
              `- git commit -am "..."（或 git add/commit）`,
              `- git push -u origin ${branchName}`,
              "",
              "后端会通过 fetch 该分支来展示 diff 并创建 PR。",
            ].join("\n")
          : [
              "你正在一个独立的 Git worktree 中执行任务：",
              `- workspace: ${workspacePath}`,
              `- branch: ${branchName}`,
              "",
              "请在该分支上进行修改，并在任务完成后将修改提交（git commit）到该分支。",
            ].join("\n"),
      );

      if (role?.promptTemplate?.trim()) {
        const rendered = renderTemplate(role.promptTemplate, {
          workspace: workspacePath,
          branch: branchName,
          repoUrl: String(issue.project.repoUrl ?? ""),
          defaultBranch: String(issue.project.defaultBranch ?? ""),
          "project.id": String(issue.project.id ?? ""),
          "project.name": String((issue.project as any).name ?? ""),
          "issue.id": String(issue.id ?? ""),
          "issue.title": String(issue.title ?? ""),
          "issue.description": String(issue.description ?? ""),
          roleKey: role.key,
          "role.key": role.key,
          "role.name": String(role.displayName ?? role.key),
        });
        promptParts.push(`角色指令:\n${rendered}`);
      }

      promptParts.push(`任务标题: ${issue.title}`);
      if (issue.description) promptParts.push(`任务描述:\n${issue.description}`);

      const acceptance = Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria : [];
      if (acceptance.length) {
        promptParts.push(`验收标准:\n${acceptance.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
      }
      const constraints = Array.isArray(issue.constraints) ? issue.constraints : [];
      if (constraints.length) {
        promptParts.push(`约束条件:\n${constraints.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
      }
      if (issue.testRequirements) {
        promptParts.push(`测试要求:\n${issue.testRequirements}`);
      }

      try {
        const roleScript = role?.initScript?.trim() ? role.initScript : "";

        const initEnv: Record<string, string> = {
          ...pickRoleEnv(role),
          TUIXIU_PROJECT_ID: issue.projectId,
          TUIXIU_PROJECT_NAME: String((issue.project as any).name ?? ""),
          TUIXIU_REPO_URL: String(issue.project.repoUrl ?? ""),
          TUIXIU_DEFAULT_BRANCH: String(issue.project.defaultBranch ?? ""),
          TUIXIU_RUN_BRANCH: branchName,
          TUIXIU_RUN_ID: run.id,
          TUIXIU_WORKSPACE: workspacePath,
          TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${issue.projectId}`,
          ...(role ? { TUIXIU_ROLE_KEY: role.key } : {})
        };

        const init = wantsBoxliteClone || roleScript
          ? {
              script: roleScript,
              timeout_seconds: wantsBoxliteClone ? Math.max(role?.initTimeoutSeconds ?? 300, 900) : role?.initTimeoutSeconds,
              env: initEnv
            }
          : undefined;

        await deps.sendToAgent(selectedAgent.proxyId, {
          type: "execute_task",
          run_id: run.id,
          session_id: run.id,
          prompt: promptParts.join("\n\n"),
          cwd: workspacePath,
          init
        });
      } catch (error) {
        await deps.prisma.run.update({
          where: { id: run.id },
          data: { status: "failed", completedAt: new Date(), errorMessage: String(error) }
        });
        await deps.prisma.issue.update({
          where: { id: issue.id },
          data: { status: "failed" }
        });
        await deps.prisma.agent
          .update({ where: { id: selectedAgent.id }, data: { currentLoad: { decrement: 1 } } })
          .catch(() => {});

        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送任务到 Agent 失败",
            details: String(error)
          },
          data: { issue, run }
        };
      }

      return { success: true, data: { run } };
    });

    server.patch("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        status: mutableIssueStatusSchema.optional()
      });

      const { id } = paramsSchema.parse(request.params);
      const { status } = bodySchema.parse(request.body ?? {});

      const issue = await deps.prisma.issue.findUnique({ where: { id } });
      if (!issue) {
        return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
      }
      if (issue.status === "running") {
        return {
          success: false,
          error: { code: "ISSUE_RUNNING", message: "Issue 正在运行中，请先完成/取消 Run" }
        };
      }
      if (!status) {
        return { success: true, data: { issue } };
      }

      const updated = await deps.prisma.issue.update({
        where: { id },
        data: { status }
      });

      return { success: true, data: { issue: updated } };
    });
  };
}
