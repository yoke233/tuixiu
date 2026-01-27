import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { suggestRunKeyWithLlm } from "../utils/gitWorkspace.js";
import type { AcpTunnel } from "../services/acpTunnel.js";

import type { CreateWorkspace, CreateWorkspaceResult } from "./types.js";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

function normalizeWorkspaceMode(mode: unknown): "worktree" | "clone" {
  return String(mode ?? "").trim().toLowerCase() === "clone" ? "clone" : "worktree";
}

function stepTitle(step: any): string {
  const key = String(step?.key ?? step?.kind ?? "").trim();
  if (!key) return "任务步骤";
  return key;
}

function inferTestCommand(step: any, issue: any): string {
  const fromParams = (step?.params as any)?.command;
  if (typeof fromParams === "string" && fromParams.trim()) return fromParams.trim();
  const fromIssue = typeof issue?.testRequirements === "string" ? issue.testRequirements.trim() : "";
  if (fromIssue) return fromIssue;
  return "pnpm -r test";
}

function buildStepInstruction(step: any, issue: any): string {
  const kind = String(step?.kind ?? "").trim();
  const params = step?.params ?? {};
  const mode = typeof (params as any).mode === "string" ? String((params as any).mode).trim().toLowerCase() : "";

  if (kind === "prd.generate") {
    return [
      "你是产品经理（PM）。请根据任务信息生成一份 PRD（中文）。",
      "要求：内容结构清晰、可执行、包含验收标准与非目标。",
      "",
      "最后请输出一个代码块：```REPORT_JSON```，其内容必须是 JSON：",
      `- kind: "prd"`,
      `- title: string`,
      `- markdown: string（完整 PRD Markdown）`,
      `- acceptanceCriteria: string[]`,
      "不要在 JSON 外再包裹解释。",
    ].join("\n");
  }

  if (kind === "test.run") {
    const cmd = inferTestCommand(step, issue);
    return [
      "请在 workspace 中运行测试，并根据结果输出结构化摘要。",
      `建议命令：${cmd}`,
      "",
      "最后请输出一个代码块：```CI_RESULT_JSON```，其内容必须是 JSON：",
      `- passed: boolean`,
      `- failedCount?: number`,
      `- durationMs?: number`,
      `- summary?: string`,
      `- logExcerpt?: string（最多 4000 字符）`,
    ].join("\n");
  }

  if (kind === "code.review") {
    const who = mode === "ai" ? "AI Reviewer" : "Reviewer";
    return [
      `你是 ${who}。请对当前分支改动进行代码评审。`,
      "请基于 `git diff`（相对 base branch）输出关键问题、建议修改与风险。",
      "",
      "最后请输出一个代码块：```REPORT_JSON```，其内容必须是 JSON：",
      `- kind: "review"`,
      `- verdict: "approve" | "changes_requested"`,
      `- findings: { severity: "high"|"medium"|"low"; message: string; path?: string }[]`,
      `- markdown: string（评审报告 Markdown）`,
    ].join("\n");
  }

  if (kind === "dev.implement") {
    return [
      "你是软件工程师。请在当前分支实现需求并提交代码（git commit）。",
      "实现完成后输出：变更摘要、关键文件列表、以及如何验证。",
    ].join("\n");
  }

  return `请执行步骤：${stepTitle(step)}`;
}

async function selectAvailableAgent(prisma: PrismaDeps, preferredAgentId?: string | null): Promise<any | null> {
  if (preferredAgentId) {
    const a = await prisma.agent.findUnique({ where: { id: preferredAgentId } });
    if (a && (a as any).status === "online" && (a as any).currentLoad < (a as any).maxConcurrentRuns) return a;
  }

  const agents = await prisma.agent.findMany({
    where: { status: "online" },
    orderBy: { createdAt: "asc" },
  });

  return (
    (agents as any[]).find((a) => Number(a.currentLoad) < Number(a.maxConcurrentRuns)) ?? null
  );
}

async function ensureWorkspace(opts: {
  prisma: PrismaDeps;
  createWorkspace?: CreateWorkspace;
  run: any;
  task: any;
  issue: any;
}): Promise<{ workspace: CreateWorkspaceResult; mode: "worktree" | "clone" }> {
  const existingPath = typeof opts.task?.workspacePath === "string" ? opts.task.workspacePath.trim() : "";
  const existingBranch = typeof opts.task?.branchName === "string" ? opts.task.branchName.trim() : "";
  const existingMode = normalizeWorkspaceMode(opts.task?.workspaceType);
  const baseBranch =
    typeof opts.task?.baseBranch === "string" && opts.task.baseBranch.trim()
      ? opts.task.baseBranch.trim()
      : typeof opts.issue?.project?.defaultBranch === "string" && opts.issue.project.defaultBranch.trim()
        ? opts.issue.project.defaultBranch.trim()
        : "main";

  if (existingPath && existingBranch) {
    return {
      workspace: { workspacePath: existingPath, branchName: existingBranch, workspaceMode: existingMode, baseBranch },
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

  await opts.prisma.artifact.create({
    data: {
      id: uuidv7(),
      runId: opts.run.id,
      type: "branch",
      content: { branch: branchName, baseBranch, workspacePath, workspaceMode: mode } as any,
    },
  });

  return { workspace: { ...ws, baseBranch }, mode };
}

export async function startAcpAgentExecution(deps: {
  prisma: PrismaDeps;
  acp: AcpTunnel;
  createWorkspace?: CreateWorkspace;
}, runId: string): Promise<void> {
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

  const role =
    roleKey
      ? await deps.prisma.roleTemplate.findFirst({ where: { projectId: issue.projectId, key: roleKey } })
      : null;
  if (roleKey && !role) throw new Error("RoleTemplate 不存在");

  await deps.prisma.run.update({ where: { id: run.id }, data: { agentId: agent.id } as any }).catch(() => {});
  await deps.prisma.issue
    .update({ where: { id: issue.id }, data: { status: "running", assignedAgentId: agent.id } as any })
    .catch(() => {});
  await deps.prisma.agent.update({ where: { id: agent.id }, data: { currentLoad: { increment: 1 } } }).catch(() => {});

  const promptParts: string[] = [];
  promptParts.push(
    [
      mode === "clone" ? "你正在一个独立的 Git clone 工作区中执行任务：" : "你正在一个独立的 Git worktree 中执行任务：",
      `- workspace: ${workspace.workspacePath}`,
      `- branch: ${workspace.branchName}`,
      "",
      "请在该分支上进行修改，并在任务完成后将修改提交（git commit）到该分支。",
    ].join("\n"),
  );

  if (role?.promptTemplate?.trim()) {
    const rendered = renderTemplate(role.promptTemplate, {
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

  promptParts.push(`当前步骤: ${stepTitle(step)}`);
  promptParts.push(buildStepInstruction(step, issue));

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

  const init =
    role?.initScript?.trim()
      ? {
          script: role.initScript,
          timeout_seconds: role.initTimeoutSeconds,
          env: {
            ...(project.githubAccessToken
              ? { GH_TOKEN: project.githubAccessToken, GITHUB_TOKEN: project.githubAccessToken }
              : {}),
            TUIXIU_PROJECT_ID: issue.projectId,
            TUIXIU_PROJECT_NAME: String(project.name ?? ""),
            TUIXIU_REPO_URL: String(project.repoUrl ?? ""),
            TUIXIU_DEFAULT_BRANCH: String(project.defaultBranch ?? ""),
            TUIXIU_ROLE_KEY: role.key,
            TUIXIU_RUN_ID: run.id,
            TUIXIU_WORKSPACE: workspace.workspacePath,
            TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${issue.projectId}`,
          },
        }
      : undefined;

  await deps.acp.promptRun({
    proxyId: String(agent.proxyId ?? ""),
    runId: run.id,
    cwd: workspace.workspacePath,
    sessionId: (run as any).acpSessionId ?? null,
    prompt: promptParts.join("\n\n"),
    init,
  });
}
