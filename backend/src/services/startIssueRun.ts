import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { toPublicProject } from "../utils/publicProject.js";
import { createRunWorktree, suggestRunKeyWithLlm } from "../utils/gitWorkspace.js";
import { parseEnvText } from "../utils/envText.js";
import { postGitHubIssueCommentBestEffort } from "./githubIssueComments.js";
import type { AcpTunnel } from "./acpTunnel.js";

export type WorkspaceMode = "worktree" | "clone";

export type CreateWorkspaceResult = {
  workspaceMode?: WorkspaceMode;
  workspacePath: string;
  branchName: string;
  baseBranch?: string;
  repoRoot?: string;
  gitAuthMode?: string | null;
  timingsMs?: Record<string, number>;
};

type StartIssueRunResult =
  | { success: true; data: { run: any } }
  | { success: false; error: { code: string; message: string; details?: string }; data?: any };

function toPublicIssue<T extends { project?: unknown }>(issue: T): T {
  const anyIssue = issue as any;
  if (anyIssue && anyIssue.project) {
    return { ...anyIssue, project: toPublicProject(anyIssue.project) };
  }
  return issue;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

export async function startIssueRun(opts: {
  prisma: PrismaDeps;
  acp: AcpTunnel;
  createWorkspace?: (opts: { runId: string; baseBranch: string; name: string }) => Promise<CreateWorkspaceResult>;
  issueId: string;
  agentId?: string;
  roleKey?: string;
  worktreeName?: string;
  extraPromptParts?: string[];
}): Promise<StartIssueRunResult> {
  const { issueId, agentId, roleKey, worktreeName } = opts;

  const issue = await opts.prisma.issue.findUnique({
    where: { id: issueId },
    include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
  });
  if (!issue) {
    return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
  }
  if ((issue as any).status === "running") {
    return { success: false, error: { code: "ALREADY_RUNNING", message: "Issue 正在运行中" } };
  }

  const selectedAgent = agentId
    ? await opts.prisma.agent.findUnique({ where: { id: agentId } })
    : (
        await opts.prisma.agent.findMany({
          where: { status: "online" },
          orderBy: { createdAt: "asc" },
        })
      ).find((a: { currentLoad: number; maxConcurrentRuns: number }) => a.currentLoad < a.maxConcurrentRuns) ?? null;

  if (!selectedAgent || (selectedAgent as any).status !== "online") {
    return { success: false, error: { code: "NO_AGENT", message: "没有可用的 Agent" } };
  }
  if ((selectedAgent as any).currentLoad >= (selectedAgent as any).maxConcurrentRuns) {
    return { success: false, error: { code: "AGENT_BUSY", message: "该 Agent 正忙" } };
  }

  const effectiveRoleKey = roleKey?.trim()
    ? roleKey.trim()
    : ((issue as any).project as any)?.defaultRoleKey?.trim() ?? "";
  const role = effectiveRoleKey
    ? await opts.prisma.roleTemplate.findFirst({ where: { projectId: (issue as any).projectId, key: effectiveRoleKey } })
    : null;

  if (effectiveRoleKey && !role) {
    return { success: false, error: { code: "NO_ROLE", message: "RoleTemplate 不存在" } };
  }

  const run = await opts.prisma.run.create({
    data: {
      id: uuidv7(),
      issueId: (issue as any).id,
      agentId: (selectedAgent as any).id,
      status: "running",
      metadata: role ? ({ roleKey: (role as any).key } as any) : undefined,
    },
  });

  await opts.prisma.issue.update({
    where: { id: (issue as any).id },
    data: { status: "running", assignedAgentId: (selectedAgent as any).id },
  });
  await opts.prisma.agent.update({
    where: { id: (selectedAgent as any).id },
    data: { currentLoad: { increment: 1 } },
  });

  const issueIsGitHub = String((issue as any).externalProvider ?? "").toLowerCase() === "github";
  const githubIssueNumber = Number((issue as any).externalNumber ?? 0);
  const githubAccessToken = String(((issue as any).project as any)?.githubAccessToken ?? "").trim();
  const repoUrl = String(((issue as any).project as any)?.repoUrl ?? "").trim();

  if (issueIsGitHub && githubAccessToken) {
    await postGitHubIssueCommentBestEffort({
      repoUrl,
      githubAccessToken,
      issueNumber: githubIssueNumber,
      kind: "assigned",
      agentName: String((selectedAgent as any).name ?? (selectedAgent as any).proxyId ?? "agent"),
      roleKey: role ? String((role as any).key) : effectiveRoleKey || null,
      runId: String((run as any).id),
    });
  }

  let workspacePath = "";
  let branchName = "";
  let workspaceMode: WorkspaceMode = "worktree";
  try {
    const baseBranch = ((issue as any).project as any).defaultBranch || "main";
    const runNumber = (Array.isArray((issue as any).runs) ? (issue as any).runs.length : 0) + 1;
    const name =
      typeof worktreeName === "string" && worktreeName.trim()
        ? worktreeName.trim()
        : await suggestRunKeyWithLlm({
            title: (issue as any).title,
            externalProvider: (issue as any).externalProvider,
            externalNumber: (issue as any).externalNumber,
            runNumber,
          });

    const createWorkspace =
      opts.createWorkspace ??
      (async (args: { runId: string; baseBranch: string; name: string }): Promise<CreateWorkspaceResult> => {
        const legacy = await createRunWorktree(args);
        return { ...legacy, workspaceMode: "worktree", baseBranch: args.baseBranch, timingsMs: {} };
      });

    const ws = await createWorkspace({ runId: (run as any).id, baseBranch, name });

    workspacePath = ws.workspacePath;
    branchName = ws.branchName;
    workspaceMode = ws.workspaceMode === "clone" ? "clone" : "worktree";
    const baseBranchSnapshot = ws.baseBranch?.trim() ? ws.baseBranch.trim() : baseBranch;
    const timingsMsSnapshot = ws.timingsMs && typeof ws.timingsMs === "object" ? ws.timingsMs : {};

    const caps = (selectedAgent as any)?.capabilities;
    const sandboxProvider =
      caps && typeof caps === "object" && (caps as any).sandbox && typeof (caps as any).sandbox === "object"
        ? (caps as any).sandbox.provider
        : null;

    const snapshot = {
      workspaceMode,
      workspacePath,
      branchName,
      baseBranch: baseBranchSnapshot,
      gitAuthMode: ws.gitAuthMode ?? ((issue as any).project as any)?.gitAuthMode ?? null,
      sandbox: { provider: sandboxProvider },
      agent: { max_concurrent: (selectedAgent as any).maxConcurrentRuns },
      timingsMs: timingsMsSnapshot,
    };

    await opts.prisma.run.update({
      where: { id: (run as any).id },
      data: {
        workspaceType: workspaceMode,
        workspacePath,
        branchName,
        metadata: role ? ({ roleKey: (role as any).key, snapshot } as any) : ({ snapshot } as any),
      },
    });
    await opts.prisma.artifact.create({
      data: {
        id: uuidv7(),
        runId: (run as any).id,
        type: "branch",
        content: { branch: branchName, baseBranch: baseBranchSnapshot, workspacePath, workspaceMode } as any,
      },
    });
  } catch (error) {
    await opts.prisma.run.update({
      where: { id: (run as any).id },
      data: { status: "failed", completedAt: new Date(), errorMessage: `创建 workspace 失败: ${String(error)}` },
    });
    await opts.prisma.issue.update({ where: { id: (issue as any).id }, data: { status: "failed" } }).catch(() => {});
    await opts.prisma.agent
      .update({ where: { id: (selectedAgent as any).id }, data: { currentLoad: { decrement: 1 } } })
      .catch(() => {});

    return {
      success: false,
      error: {
        code: "WORKSPACE_FAILED",
        message: "创建 Run 工作区失败",
        details: String(error),
      },
      data: { issue: toPublicIssue(issue as any), run },
    };
  }

  const promptParts: string[] = [];
  promptParts.push(
    [
      workspaceMode === "clone" ? "你正在一个独立的 Git clone 工作区中执行任务：" : "你正在一个独立的 Git worktree 中执行任务：",
      `- workspace: ${workspacePath}`,
      `- branch: ${branchName}`,
      "",
      "请在该分支上进行修改，并在任务完成后将修改提交（git commit）到该分支。",
    ].join("\n"),
  );

  if (role?.promptTemplate?.trim()) {
    const rendered = renderTemplate((role as any).promptTemplate, {
      workspace: workspacePath,
      branch: branchName,
      repoUrl: String(((issue as any).project as any).repoUrl ?? ""),
      defaultBranch: String(((issue as any).project as any).defaultBranch ?? ""),
      "project.id": String(((issue as any).project as any).id ?? ""),
      "project.name": String(((issue as any).project as any)?.name ?? ""),
      "issue.id": String((issue as any).id ?? ""),
      "issue.title": String((issue as any).title ?? ""),
      "issue.description": String((issue as any).description ?? ""),
      roleKey: (role as any).key,
      "role.key": (role as any).key,
      "role.name": String((role as any).displayName ?? (role as any).key),
    });
    promptParts.push(`角色指令:\n${rendered}`);
  }

  const extraParts = Array.isArray(opts.extraPromptParts) ? opts.extraPromptParts : [];
  for (const part of extraParts) {
    const text = String(part ?? "").trim();
    if (text) promptParts.push(text);
  }

  promptParts.push(`任务标题: ${(issue as any).title}`);
  if ((issue as any).description) promptParts.push(`任务描述:\n${(issue as any).description}`);

  const acceptance = Array.isArray((issue as any).acceptanceCriteria) ? (issue as any).acceptanceCriteria : [];
  if (acceptance.length) {
    promptParts.push(`验收标准:\n${acceptance.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  const constraints = Array.isArray((issue as any).constraints) ? (issue as any).constraints : [];
  if (constraints.length) {
    promptParts.push(`约束条件:\n${constraints.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  if ((issue as any).testRequirements) {
    promptParts.push(`测试要求:\n${(issue as any).testRequirements}`);
  }

  try {
    const init =
      role?.initScript?.trim()
        ? {
            script: (role as any).initScript,
            timeout_seconds: (role as any).initTimeoutSeconds,
            env: {
              ...(((issue as any).project as any).githubAccessToken
                ? {
                    GH_TOKEN: ((issue as any).project as any).githubAccessToken,
                    GITHUB_TOKEN: ((issue as any).project as any).githubAccessToken,
                  }
                : {}),
              ...parseEnvText((role as any).envText),
              TUIXIU_PROJECT_ID: (issue as any).projectId,
              TUIXIU_PROJECT_NAME: String(((issue as any).project as any)?.name ?? ""),
              TUIXIU_REPO_URL: String(((issue as any).project as any).repoUrl ?? ""),
              TUIXIU_DEFAULT_BRANCH: String(((issue as any).project as any).defaultBranch ?? ""),
              TUIXIU_ROLE_KEY: (role as any).key,
              TUIXIU_RUN_ID: (run as any).id,
              TUIXIU_WORKSPACE: workspacePath,
              TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${(issue as any).projectId}`,
            },
          }
        : undefined;

    await opts.acp.promptRun({
      proxyId: String((selectedAgent as any).proxyId ?? ""),
      runId: String((run as any).id),
      cwd: workspacePath,
      sessionId: (run as any).acpSessionId ?? null,
      prompt: promptParts.join("\n\n"),
      init,
    });

    if (issueIsGitHub && githubAccessToken) {
      await postGitHubIssueCommentBestEffort({
        repoUrl,
        githubAccessToken,
        issueNumber: githubIssueNumber,
        kind: "started",
        agentName: String((selectedAgent as any).name ?? (selectedAgent as any).proxyId ?? "agent"),
        roleKey: role ? String((role as any).key) : effectiveRoleKey || null,
        runId: String((run as any).id),
        branchName,
      });
    }
  } catch (error) {
    await opts.prisma.run.update({
      where: { id: (run as any).id },
      data: { status: "failed", completedAt: new Date(), errorMessage: String(error) },
    });
    await opts.prisma.issue.update({
      where: { id: (issue as any).id },
      data: { status: "failed" },
    });
    await opts.prisma.agent
      .update({ where: { id: (selectedAgent as any).id }, data: { currentLoad: { decrement: 1 } } })
      .catch(() => {});

    return {
      success: false,
      error: {
        code: "AGENT_SEND_FAILED",
        message: "发送任务到 Agent 失败",
        details: String(error),
      },
      data: { issue: toPublicIssue(issue as any), run },
    };
  }

  return { success: true, data: { run } };
}
