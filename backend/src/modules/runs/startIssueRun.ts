import type { PrismaDeps } from "../../db.js";
import { uuidv7 } from "../../utils/uuid.js";
import { toPublicProject } from "../../utils/publicProject.js";
import { suggestRunKeyWithLlm } from "../../utils/gitWorkspace.js";
import { parseEnvText } from "../../utils/envText.js";
import {
  DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
  deriveSandboxInstanceName,
  normalizeKeepaliveTtlSeconds,
} from "../../utils/sandbox.js";
import { renderTextTemplate } from "../../utils/textTemplate.js";
import { postGitHubIssueCommentBestEffort } from "../scm/githubIssueComments.js";
import type { AcpTunnel } from "../acp/acpTunnel.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../../utils/agentInit.js";
import { getSandboxWorkspaceMode } from "../../utils/sandboxCaps.js";
import { resolveAgentWorkspaceCwd } from "../../utils/agentWorkspaceCwd.js";
import {
  assertRoleGitAuthEnv,
  pickGitAccessToken,
  resolveGitAuthMode,
  resolveGitHttpUsername,
} from "../../utils/gitAuth.js";

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
  | {
      success: false;
      error: { code: string; message: string; details?: string };
      data?: any;
    };

function toPublicIssue<T extends { project?: unknown }>(issue: T): T {
  const anyIssue = issue as any;
  if (anyIssue && anyIssue.project) {
    return { ...anyIssue, project: toPublicProject(anyIssue.project) };
  }
  return issue;
}

function normalizeRoleEnv(env: Record<string, string>): Record<string, string> {
  if (env.GH_TOKEN && env.GITHUB_TOKEN === undefined) env.GITHUB_TOKEN = env.GH_TOKEN;
  if (env.GITHUB_TOKEN && env.GH_TOKEN === undefined) env.GH_TOKEN = env.GITHUB_TOKEN;
  if (env.GITLAB_TOKEN && env.GITLAB_ACCESS_TOKEN === undefined)
    env.GITLAB_ACCESS_TOKEN = env.GITLAB_TOKEN;
  if (env.GITLAB_ACCESS_TOKEN && env.GITLAB_TOKEN === undefined)
    env.GITLAB_TOKEN = env.GITLAB_ACCESS_TOKEN;
  return env;
}

export async function startIssueRun(opts: {
  prisma: PrismaDeps;
  acp: AcpTunnel;
  createWorkspace?: (opts: {
    runId: string;
    baseBranch: string;
    name: string;
  }) => Promise<CreateWorkspaceResult>;
  issueId: string;
  agentId?: string;
  roleKey?: string;
  worktreeName?: string;
  keepaliveTtlSeconds?: number;
  extraPromptParts?: string[];
}): Promise<StartIssueRunResult> {
  const { issueId, agentId, roleKey, worktreeName } = opts;

  const issue = await opts.prisma.issue.findUnique({
    where: { id: issueId },
    include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
  });
  if (!issue) {
    return {
      success: false,
      error: { code: "NOT_FOUND", message: "Issue 不存在" },
    };
  }
  if ((issue as any).status === "running") {
    return {
      success: false,
      error: { code: "ALREADY_RUNNING", message: "Issue 正在运行中" },
    };
  }

  const selectedAgent = agentId
    ? await opts.prisma.agent.findUnique({ where: { id: agentId } })
    : ((
        await opts.prisma.agent.findMany({
          where: { status: "online" },
          orderBy: { createdAt: "asc" },
        })
      ).find(
        (a: { currentLoad: number; maxConcurrentRuns: number }) =>
          a.currentLoad < a.maxConcurrentRuns,
      ) ?? null);

  if (!selectedAgent || (selectedAgent as any).status !== "online") {
    return {
      success: false,
      error: { code: "NO_AGENT", message: "没有可用的 Agent" },
    };
  }
  if ((selectedAgent as any).currentLoad >= (selectedAgent as any).maxConcurrentRuns) {
    return {
      success: false,
      error: { code: "AGENT_BUSY", message: "该 Agent 正忙" },
    };
  }

  const effectiveRoleKey = roleKey?.trim()
    ? roleKey.trim()
    : (((issue as any).project as any)?.defaultRoleKey?.trim() ?? "");
  const role = effectiveRoleKey
    ? await opts.prisma.roleTemplate.findFirst({
        where: { projectId: (issue as any).projectId, key: effectiveRoleKey },
      })
    : null;

  if (effectiveRoleKey && !role) {
    return {
      success: false,
      error: { code: "NO_ROLE", message: "RoleTemplate 不存在" },
    };
  }

  const requestedTtl = normalizeKeepaliveTtlSeconds(opts.keepaliveTtlSeconds);
  const keepaliveTtlSeconds =
    requestedTtl === null
      ? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS
      : Math.min(86_400, Math.max(60, requestedTtl));

  const runId = uuidv7();
  const run = await opts.prisma.run.create({
    data: {
      id: runId,
      issueId: (issue as any).id,
      agentId: (selectedAgent as any).id,
      status: "running",
      sandboxInstanceName: deriveSandboxInstanceName(runId),
      keepaliveTtlSeconds,
      sandboxStatus: "creating",
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
      prisma: opts.prisma,
      projectId: (issue as any).projectId,
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
  let baseBranchForRun =
    String(((issue as any).project as any).defaultBranch ?? "").trim() || "main";
  let workspaceMode: WorkspaceMode = "clone";
  let gitAuthModeFromWorkspace: string | null = null;
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

    const createWorkspace = opts.createWorkspace;
    if (!createWorkspace) {
      throw new Error("createWorkspace 未配置，无法创建 workspace");
    }

    const ws = await createWorkspace({
      runId: (run as any).id,
      baseBranch,
      name,
    });

    workspacePath = ws.workspacePath;
    branchName = ws.branchName;
    workspaceMode = ws.workspaceMode === "worktree" ? "worktree" : "clone";
    const resolvedBaseBranch = ws.baseBranch?.trim() ? ws.baseBranch.trim() : baseBranch;
    baseBranchForRun = resolvedBaseBranch;
    const timingsMsSnapshot = ws.timingsMs && typeof ws.timingsMs === "object" ? ws.timingsMs : {};

    const caps = (selectedAgent as any)?.capabilities;
    const sandboxProvider =
      caps &&
      typeof caps === "object" &&
      (caps as any).sandbox &&
      typeof (caps as any).sandbox === "object"
        ? (caps as any).sandbox.provider
        : null;

    const sandboxWorkspaceMode = getSandboxWorkspaceMode(caps);
    gitAuthModeFromWorkspace = ws.gitAuthMode ?? null;
    const snapshot = {
      workspaceMode,
      workspacePath,
      branchName,
      baseBranch: resolvedBaseBranch,
      gitAuthMode: ws.gitAuthMode ?? ((issue as any).project as any)?.gitAuthMode ?? null,
      sandbox: { provider: sandboxProvider, workspaceMode: sandboxWorkspaceMode ?? undefined },
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
  } catch (error) {
    await opts.prisma.run.update({
      where: { id: (run as any).id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: `创建 workspace 失败: ${String(error)}`,
      },
    });
    await opts.prisma.issue
      .update({ where: { id: (issue as any).id }, data: { status: "failed" } })
      .catch(() => {});
    await opts.prisma.agent
      .update({
        where: { id: (selectedAgent as any).id },
        data: { currentLoad: { decrement: 1 } },
      })
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

  const sandboxWorkspaceMode = getSandboxWorkspaceMode((selectedAgent as any)?.capabilities);
  const agentWorkspacePath = resolveAgentWorkspaceCwd({
    runId: String((run as any).id ?? ""),
    sandboxWorkspaceMode,
  });

  const promptParts: string[] = [];
  const projectForPrompt: any = (issue as any).project;
  const workspaceNoticeVars = {
    workspace: String(agentWorkspacePath),
    branch: String(branchName),
    workspaceMode: String(workspaceMode),
    repoUrl: String(projectForPrompt?.repoUrl ?? ""),
    scmType: String(projectForPrompt?.scmType ?? ""),
    defaultBranch: String(projectForPrompt?.defaultBranch ?? ""),
    baseBranch: String(baseBranchForRun),
  };
  const projectNoticeTemplate = (projectForPrompt as any)?.agentWorkspaceNoticeTemplate;
  const noticeTemplate =
    projectNoticeTemplate !== undefined && projectNoticeTemplate !== null
      ? String(projectNoticeTemplate)
      : process.env.AGENT_WORKSPACE_NOTICE_TEMPLATE;
  const workspaceNoticeDefault =
    "请在该工作区中进行修改。若该工作区是 Git 仓库，请在任务完成后将修改提交（git commit）到该分支；否则无需执行 git commit。";
  const workspaceNotice =
    noticeTemplate === undefined
      ? workspaceNoticeDefault
      : renderTextTemplate(String(noticeTemplate), workspaceNoticeVars).trim();
  promptParts.push(
    [
      workspaceMode === "clone"
        ? "你正在一个独立的 Git clone 工作区中执行任务："
        : "你正在一个独立的 Git worktree 中执行任务：",
      `- workspace: ${agentWorkspacePath}`,
      `- branch: ${branchName}`,
      ...(workspaceNotice ? ["", workspaceNotice] : []),
    ].join("\n"),
  );

  if (role?.promptTemplate?.trim()) {
    const rendered = renderTextTemplate((role as any).promptTemplate, {
      workspace: agentWorkspacePath,
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

  const acceptance = Array.isArray((issue as any).acceptanceCriteria)
    ? (issue as any).acceptanceCriteria
    : [];
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
    const project: any = (issue as any).project;
    const roleEnv = normalizeRoleEnv(role ? parseEnvText(String((role as any).envText)) : {});
    assertRoleGitAuthEnv(roleEnv, role ? String((role as any).key ?? "") : null);
    const gitAuthMode = resolveGitAuthMode({
      repoUrl: String(project?.repoUrl ?? ""),
      scmType: project?.scmType ?? null,
      gitAuthMode: gitAuthModeFromWorkspace ?? project?.gitAuthMode ?? null,
      githubAccessToken: project?.githubAccessToken ?? null,
      gitlabAccessToken: project?.gitlabAccessToken ?? null,
    });
    const gitHttpUsername = resolveGitHttpUsername({
      repoUrl: String(project?.repoUrl ?? ""),
      scmType: project?.scmType ?? null,
    });
    const gitHttpPassword = pickGitAccessToken({
      scmType: project?.scmType ?? null,
      githubAccessToken: project?.githubAccessToken ?? null,
      gitlabAccessToken: project?.gitlabAccessToken ?? null,
      repoUrl: project?.repoUrl ?? null,
      gitAuthMode: project?.gitAuthMode ?? null,
    });

    const initEnv: Record<string, string> = {
      ...(project?.githubAccessToken
        ? {
            GH_TOKEN: String(project.githubAccessToken),
            GITHUB_TOKEN: String(project.githubAccessToken),
          }
        : {}),
      ...(project?.gitlabAccessToken
        ? {
            GITLAB_TOKEN: String(project.gitlabAccessToken),
            GITLAB_ACCESS_TOKEN: String(project.gitlabAccessToken),
          }
        : {}),
      ...roleEnv,
      TUIXIU_PROJECT_ID: String((issue as any).projectId),
      TUIXIU_PROJECT_NAME: String(project?.name ?? ""),
      TUIXIU_REPO_URL: String(project?.repoUrl ?? ""),
      TUIXIU_SCM_TYPE: String(project?.scmType ?? ""),
      TUIXIU_DEFAULT_BRANCH: String(project?.defaultBranch ?? ""),
      TUIXIU_BASE_BRANCH: String(baseBranchForRun),
      TUIXIU_RUN_ID: String((run as any).id),
      TUIXIU_RUN_BRANCH: String(branchName),
      TUIXIU_WORKSPACE: String(agentWorkspacePath),
      TUIXIU_WORKSPACE_GUEST: String(agentWorkspacePath),
      TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String((issue as any).projectId)}`,
    };
    if (sandboxWorkspaceMode) {
      initEnv.TUIXIU_WORKSPACE_MODE = sandboxWorkspaceMode;
      if (sandboxWorkspaceMode === "mount") {
        initEnv.TUIXIU_SKIP_WORKSPACE_INIT = "1";
      }
    }
    if (role?.key) initEnv.TUIXIU_ROLE_KEY = String(role.key);
    if (initEnv.TUIXIU_GIT_AUTH_MODE === undefined) initEnv.TUIXIU_GIT_AUTH_MODE = gitAuthMode;
    if (initEnv.TUIXIU_GIT_HTTP_USERNAME === undefined && gitHttpUsername) {
      initEnv.TUIXIU_GIT_HTTP_USERNAME = gitHttpUsername;
    }
    if (initEnv.TUIXIU_GIT_HTTP_PASSWORD === undefined && gitHttpPassword) {
      initEnv.TUIXIU_GIT_HTTP_PASSWORD = gitHttpPassword;
    }
    if (initEnv.TUIXIU_GIT_HTTP_PASSWORD === undefined) {
      const fallbackToken =
        initEnv.GITHUB_TOKEN ||
        initEnv.GH_TOKEN ||
        initEnv.GITLAB_ACCESS_TOKEN ||
        initEnv.GITLAB_TOKEN;
      if (fallbackToken) initEnv.TUIXIU_GIT_HTTP_PASSWORD = fallbackToken;
    }

    const baseInitScript = buildWorkspaceInitScript();
    const roleInitScript = role?.initScript?.trim() ? String(role.initScript) : "";

    const init = {
      script: mergeInitScripts(baseInitScript, roleInitScript),
      timeout_seconds: role?.initTimeoutSeconds,
      env: initEnv,
    };

    await opts.acp.promptRun({
      proxyId: String((selectedAgent as any).proxyId ?? ""),
      runId: String((run as any).id),
      cwd: agentWorkspacePath,
      sessionId: (run as any).acpSessionId ?? null,
      prompt: [{ type: "text", text: promptParts.join("\n\n") }],
      init,
    });

    if (issueIsGitHub && githubAccessToken) {
      await postGitHubIssueCommentBestEffort({
        prisma: opts.prisma,
        projectId: (issue as any).projectId,
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
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: String(error),
      },
    });
    await opts.prisma.issue.update({
      where: { id: (issue as any).id },
      data: { status: "failed" },
    });
    await opts.prisma.agent
      .update({
        where: { id: (selectedAgent as any).id },
        data: { currentLoad: { decrement: 1 } },
      })
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
