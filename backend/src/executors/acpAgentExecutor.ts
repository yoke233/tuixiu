import type { PrismaDeps } from "../db.js";
import { suggestRunKeyWithLlm } from "../utils/gitWorkspace.js";
import { parseEnvText } from "../utils/envText.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import { buildContextPackPrompt } from "../modules/acp/contextPack.js";
import { renderTextTemplateFromDb } from "../modules/templates/textTemplates.js";
import { renderTextTemplate } from "../utils/textTemplate.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../utils/agentInit.js";
import {
  pickGitAccessToken,
  resolveGitAuthMode,
  resolveGitHttpUsername,
} from "../utils/gitAuth.js";

import type { CreateWorkspace, CreateWorkspaceResult } from "./types.js";

function normalizeWorkspaceMode(mode: unknown): "worktree" | "clone" {
  const v = String(mode ?? "")
    .trim()
    .toLowerCase();
  if (v === "worktree") return "worktree";
  return "clone";
}

function stepTitle(step: any): string {
  const key = String(step?.key ?? step?.kind ?? "").trim();
  if (!key) return "任务步骤";
  return key;
}

function inferTestCommand(step: any, issue: any): string {
  const fromParams = (step?.params as any)?.command;
  if (typeof fromParams === "string" && fromParams.trim()) return fromParams.trim();
  const fromIssue =
    typeof issue?.testRequirements === "string" ? issue.testRequirements.trim() : "";
  if (fromIssue) return fromIssue;
  return "pnpm -r test";
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

async function buildStepInstruction(prisma: PrismaDeps, step: any, issue: any): Promise<string> {
  const kind = String(step?.kind ?? "").trim();
  const params = step?.params ?? {};
  const mode =
    typeof (params as any).mode === "string"
      ? String((params as any).mode)
          .trim()
          .toLowerCase()
      : "";

  const feedbackRaw = (params as any)?.feedback;
  const feedbackMessage =
    feedbackRaw &&
    typeof feedbackRaw === "object" &&
    typeof (feedbackRaw as any).message === "string"
      ? String((feedbackRaw as any).message).trim()
      : "";
  const feedbackClamped =
    feedbackMessage.length > 2000
      ? `${feedbackMessage.slice(0, 1800)}\n\n…（截断）`
      : feedbackMessage;

  if (kind === "prd.generate") {
    return await renderTextTemplateFromDb(
      { prisma },
      { key: "acp.stepInstruction.prd.generate", projectId: issue?.projectId, vars: {} },
    );
  }

  if (kind === "session.interactive") {
    return await renderTextTemplateFromDb(
      { prisma },
      { key: "acp.stepInstruction.session.interactive", projectId: issue?.projectId, vars: {} },
    );
  }

  if (kind === "test.run") {
    const cmd = inferTestCommand(step, issue);
    return await renderTextTemplateFromDb(
      { prisma },
      { key: "acp.stepInstruction.test.run", projectId: issue?.projectId, vars: { cmd } },
    );
  }

  if (kind === "code.review") {
    const who = mode === "ai" ? "AI Reviewer（对抗式）" : "Reviewer";
    const githubPr = (params as any).githubPr;
    const prNumber =
      githubPr && typeof githubPr === "object" && Number.isFinite((githubPr as any).number)
        ? Number((githubPr as any).number)
        : 0;
    const prUrl =
      githubPr && typeof githubPr === "object" ? String((githubPr as any).url ?? "").trim() : "";
    const baseBranch =
      githubPr && typeof githubPr === "object"
        ? String((githubPr as any).baseBranch ?? "").trim()
        : "";
    const headBranch =
      githubPr && typeof githubPr === "object"
        ? String((githubPr as any).headBranch ?? "").trim()
        : "";
    const headShaShort =
      githubPr && typeof githubPr === "object"
        ? String((githubPr as any).headSha ?? "")
            .trim()
            .slice(0, 12)
        : "";
    const fetchBaseCommand = baseBranch ? `git fetch origin ${baseBranch}` : "";
    const diffCommand = baseBranch
      ? `git diff ${baseBranch}...HEAD`
      : "git diff <base-branch>...HEAD";

    return await renderTextTemplateFromDb(
      { prisma },
      {
        key: "acp.stepInstruction.code.review",
        projectId: issue?.projectId,
        vars: {
          who,
          prNumber,
          prUrl,
          baseBranch,
          headBranch,
          headShaShort,
          fetchBaseCommand,
          diffCommand,
        },
      },
    );
  }

  if (kind === "dev.implement") {
    return await renderTextTemplateFromDb(
      { prisma },
      {
        key: "acp.stepInstruction.dev.implement",
        projectId: issue?.projectId,
        vars: { feedback: feedbackClamped },
      },
    );
  }

  return await renderTextTemplateFromDb(
    { prisma },
    {
      key: "acp.stepInstruction.default",
      projectId: issue?.projectId,
      vars: { stepTitle: stepTitle(step) },
    },
  );
}

async function selectAvailableAgent(
  prisma: PrismaDeps,
  preferredAgentId?: string | null,
): Promise<any | null> {
  if (preferredAgentId) {
    const a = await prisma.agent.findUnique({ where: { id: preferredAgentId } });
    if (
      a &&
      (a as any).status === "online" &&
      (a as any).currentLoad < (a as any).maxConcurrentRuns
    )
      return a;
  }

  const agents = await prisma.agent.findMany({
    where: { status: "online" },
    orderBy: { createdAt: "asc" },
  });

  return (agents as any[]).find((a) => Number(a.currentLoad) < Number(a.maxConcurrentRuns)) ?? null;
}

async function ensureWorkspace(opts: {
  prisma: PrismaDeps;
  createWorkspace?: CreateWorkspace;
  run: any;
  task: any;
  issue: any;
}): Promise<{ workspace: CreateWorkspaceResult; mode: "worktree" | "clone" }> {
  const existingPath =
    typeof opts.task?.workspacePath === "string" ? opts.task.workspacePath.trim() : "";
  const existingBranch =
    typeof opts.task?.branchName === "string" ? opts.task.branchName.trim() : "";
  const existingMode = normalizeWorkspaceMode(opts.task?.workspaceType);
  const baseBranch =
    typeof opts.task?.baseBranch === "string" && opts.task.baseBranch.trim()
      ? opts.task.baseBranch.trim()
      : typeof opts.issue?.project?.defaultBranch === "string" &&
          opts.issue.project.defaultBranch.trim()
        ? opts.issue.project.defaultBranch.trim()
        : "main";

  if (existingPath && existingBranch) {
    return {
      workspace: {
        workspacePath: existingPath,
        branchName: existingBranch,
        workspaceMode: existingMode,
        baseBranch,
      },
      mode: existingMode,
    };
  }

  if (!opts.createWorkspace) {
    throw new Error("createWorkspace 未配置，无法创建 workspace");
  }

  const desiredName = await suggestRunKeyWithLlm({
    title: opts.issue?.title,
    externalProvider: opts.issue?.externalProvider,
    externalNumber: opts.issue?.externalNumber,
    runNumber: 1,
  });

  const ws = await opts.createWorkspace({
    runId: opts.run.id,
    baseBranch,
    name: desiredName || "task",
  });

  const mode = normalizeWorkspaceMode(ws.workspaceMode ?? existingMode);
  const workspacePath = ws.workspacePath;
  const branchName = ws.branchName;

  await opts.prisma.task.update({
    where: { id: opts.task.id },
    data: {
      workspaceType: mode,
      workspacePath,
      branchName,
      baseBranch,
    } as any,
  });
  await opts.prisma.run.update({
    where: { id: opts.run.id },
    data: {
      workspaceType: mode,
      workspacePath,
      branchName,
    } as any,
  });

  return { workspace: { ...ws, baseBranch }, mode };
}

export async function startAcpAgentExecution(
  deps: {
    prisma: PrismaDeps;
    acp: AcpTunnel;
    createWorkspace?: CreateWorkspace;
  },
  runId: string,
): Promise<void> {
  if (!deps.acp) throw new Error("acpTunnel 未配置");

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      step: true,
      task: { include: { issue: { include: { project: true } } } },
    },
  });
  if (!run) throw new Error("Run 不存在");

  const task = (run as any).task as any;
  const step = (run as any).step as any;
  const issue = task?.issue as any;
  const project = issue?.project as any;

  if (!task || !step || !issue || !project) {
    throw new Error("Run 缺少 task/step/issue/project 上下文");
  }

  const preferredAgentId = typeof issue.assignedAgentId === "string" ? issue.assignedAgentId : null;
  const agent = await selectAvailableAgent(deps.prisma, preferredAgentId);
  if (!agent) throw new Error("没有可用的 Agent");

  const { workspace, mode } = await ensureWorkspace({
    prisma: deps.prisma,
    createWorkspace: deps.createWorkspace,
    run,
    task,
    issue,
  });

  const roleKey =
    typeof step.roleKey === "string" && step.roleKey.trim()
      ? step.roleKey.trim()
      : typeof project.defaultRoleKey === "string" && project.defaultRoleKey.trim()
        ? project.defaultRoleKey.trim()
        : "";

  const role = roleKey
    ? await deps.prisma.roleTemplate.findFirst({
        where: { projectId: issue.projectId, key: roleKey },
      })
    : null;
  if (roleKey && !role) throw new Error("RoleTemplate 不存在");

  await deps.prisma.run
    .update({ where: { id: run.id }, data: { agentId: agent.id } as any })
    .catch(() => {});
  await deps.prisma.issue
    .update({
      where: { id: issue.id },
      data: { status: "running", assignedAgentId: agent.id } as any,
    })
    .catch(() => {});
  await deps.prisma.agent
    .update({ where: { id: agent.id }, data: { currentLoad: { increment: 1 } } })
    .catch(() => {});

  const promptParts: string[] = [];
  const baseBranchForPrompt = String(
    workspace.baseBranch ?? task.baseBranch ?? project.defaultBranch ?? "main",
  );
  const workspaceNoticeVars = {
    workspace: String(workspace.workspacePath),
    branch: String(workspace.branchName),
    workspaceMode: String(mode),
    repoUrl: String(project.repoUrl ?? ""),
    scmType: String(project.scmType ?? ""),
    defaultBranch: String(project.defaultBranch ?? ""),
    baseBranch: baseBranchForPrompt,
  };
  const projectNoticeTemplate = (project as any)?.agentWorkspaceNoticeTemplate;
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
      mode === "clone"
        ? "你正在一个独立的 Git clone 工作区中执行任务："
        : "你正在一个独立的 Git worktree 中执行任务：",
      `- workspace: ${workspace.workspacePath}`,
      `- branch: ${workspace.branchName}`,
      ...(workspaceNotice ? ["", workspaceNotice] : []),
    ].join("\n"),
  );

  if (role?.promptTemplate?.trim()) {
    const rendered = renderTextTemplate(role.promptTemplate, {
      workspace: workspace.workspacePath,
      branch: workspace.branchName,
      repoUrl: String(project.repoUrl ?? ""),
      defaultBranch: String(project.defaultBranch ?? ""),
      "project.id": String(project.id ?? ""),
      "project.name": String(project.name ?? ""),
      "issue.id": String(issue.id ?? ""),
      "issue.title": String(issue.title ?? ""),
      "issue.description": String(issue.description ?? ""),
      roleKey: role.key,
      "role.key": role.key,
      "role.name": String(role.displayName ?? role.key),
    });
    promptParts.push(`角色指令:\n${rendered}`);
  }

  const contextPack = await buildContextPackPrompt({
    workspacePath: workspace.workspacePath,
    stepKind: String(step?.kind ?? ""),
  });
  if (contextPack) promptParts.push(contextPack);

  promptParts.push(`当前步骤: ${stepTitle(step)}`);
  promptParts.push(await buildStepInstruction(deps.prisma, step, issue));

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

  const roleEnv = normalizeRoleEnv(role?.envText ? parseEnvText(String(role.envText)) : {});
  const gitAuthMode = resolveGitAuthMode({
    repoUrl: String(project?.repoUrl ?? ""),
    scmType: project?.scmType ?? null,
    gitAuthMode: workspace.gitAuthMode ?? project?.gitAuthMode ?? null,
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
    ...(project.githubAccessToken
      ? {
          GH_TOKEN: String(project.githubAccessToken),
          GITHUB_TOKEN: String(project.githubAccessToken),
        }
      : {}),
    ...(project.gitlabAccessToken
      ? {
          GITLAB_TOKEN: String(project.gitlabAccessToken),
          GITLAB_ACCESS_TOKEN: String(project.gitlabAccessToken),
        }
      : {}),
    ...roleEnv,
    TUIXIU_PROJECT_ID: String(issue.projectId),
    TUIXIU_PROJECT_NAME: String(project.name ?? ""),
    TUIXIU_REPO_URL: String(project.repoUrl ?? ""),
    TUIXIU_SCM_TYPE: String(project.scmType ?? ""),
    TUIXIU_DEFAULT_BRANCH: String(project.defaultBranch ?? ""),
    TUIXIU_BASE_BRANCH: baseBranchForPrompt,
    TUIXIU_RUN_ID: String(run.id),
    TUIXIU_RUN_BRANCH: String(workspace.branchName),
    TUIXIU_WORKSPACE: String(workspace.workspacePath),
    TUIXIU_WORKSPACE_GUEST: "/workspace",
    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String(issue.projectId)}`,
  };
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

  await deps.acp.promptRun({
    proxyId: String(agent.proxyId ?? ""),
    runId: run.id,
    cwd: "/workspace",
    sessionId: (run as any).acpSessionId ?? null,
    prompt: [{ type: "text", text: promptParts.join("\n\n") }],
    init,
  });
}
