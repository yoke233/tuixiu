import type { PrismaDeps } from "../db.js";
import { suggestRunKeyWithLlm } from "../utils/gitWorkspace.js";
import { parseEnvText } from "../utils/envText.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import { buildContextPackPrompt } from "../modules/acp/contextPack.js";
import { renderTextTemplateFromDb } from "../modules/templates/textTemplates.js";
import { renderTextTemplate } from "../utils/textTemplate.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../utils/agentInit.js";
import { getSandboxWorkspaceMode } from "../utils/sandboxCaps.js";
import { resolveAgentWorkspaceCwd } from "../utils/agentWorkspaceCwd.js";
import { resolveExecutionProfile } from "../utils/executionProfile.js";
import {
  assertRoleGitAuthEnv,
  pickGitAccessToken,
  resolveGitAuthMode,
  resolveGitHttpUsername,
} from "../utils/gitAuth.js";
import { buildInitPipeline } from "../utils/initPipeline.js";
import { stringifyContextInventory } from "../utils/contextInventory.js";
import { assertWorkspacePolicyCompat, resolveWorkspacePolicy } from "../utils/workspacePolicy.js";

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
  const bundleSource = task?.bundleSource ?? null;

  if (!task || !step || !issue || !project) {
    throw new Error("Run 缺少 task/step/issue/project 上下文");
  }

  const preferredAgentId = typeof issue.assignedAgentId === "string" ? issue.assignedAgentId : null;
  const agent = await selectAvailableAgent(deps.prisma, preferredAgentId);
  if (!agent) throw new Error("没有可用的 Agent");

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

  const executionProfile = await resolveExecutionProfile({
    prisma: deps.prisma,
    platformProfileKey: process.env.EXECUTION_PROFILE_DEFAULT_KEY ?? null,
    taskProfileId: task.executionProfileId ?? null,
    roleProfileId: (role as any)?.executionProfileId ?? null,
    projectProfileId: project?.executionProfileId ?? null,
  });
  const resolvedPolicy = resolveWorkspacePolicy({
    platformDefault: process.env.WORKSPACE_POLICY_DEFAULT ?? null,
    projectPolicy: project?.workspacePolicy ?? null,
    rolePolicy: (role as any)?.workspacePolicy ?? null,
    taskPolicy: task?.workspacePolicy ?? null,
    profilePolicy: executionProfile?.workspacePolicy ?? null,
  });
  if (resolvedPolicy.resolved === "bundle" && !bundleSource?.path) {
    throw new Error("bundle policy 需要提供 bundle 来源");
  }
  assertWorkspacePolicyCompat({ policy: resolvedPolicy.resolved, capabilities: agent?.capabilities });

  const { workspace, mode } = await ensureWorkspace({
    prisma: deps.prisma,
    createWorkspace: deps.createWorkspace,
    run,
    task,
    issue,
  });

  await deps.prisma.run
    .update({
      where: { id: run.id },
      data: {
        agentId: agent.id,
        resolvedWorkspacePolicy: resolvedPolicy.resolved,
        workspacePolicySource: resolvedPolicy,
        executionProfileId: executionProfile?.id ?? null,
        executionProfileSnapshot: executionProfile ?? null,
        bundleSource: bundleSource ?? null,
      } as any,
    })
    .catch(() => {});
  await deps.prisma.task
    .update({
      where: { id: task.id },
      data: {
        resolvedWorkspacePolicy: resolvedPolicy.resolved,
        workspacePolicySource: resolvedPolicy,
        executionProfileId: executionProfile?.id ?? null,
        executionProfileSnapshot: executionProfile ?? null,
      } as any,
    })
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
  if (resolvedPolicy.resolved === "git") {
    assertRoleGitAuthEnv(roleEnv, role?.key ?? null);
  }
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
  const enableRuntimeSkillsMounting = project?.enableRuntimeSkillsMounting === true;
  let skillsManifest: any | null = null;
  if (enableRuntimeSkillsMounting && role?.id) {
    const bindings = await deps.prisma.roleSkillBinding.findMany({
      where: { roleTemplateId: role.id, enabled: true } as any,
      orderBy: { createdAt: "asc" },
      select: { skillId: true, versionPolicy: true, pinnedVersionId: true },
    });

    if (bindings.length) {
      const skillIds = bindings.map((b: any) => String(b.skillId ?? "")).filter(Boolean);
      const skills = await deps.prisma.skill.findMany({
        where: { id: { in: skillIds } } as any,
        select: { id: true, name: true, latestVersionId: true },
      });
      const skillById = new Map<string, any>();
      for (const s of skills as any[]) skillById.set(String(s.id ?? ""), s);

      const resolved = bindings.map((b: any) => {
        const skillId = String(b.skillId ?? "");
        const skill = skillById.get(skillId) ?? null;
        if (!skill) throw new Error(`role skills 配置包含不存在的 skillId: ${skillId}`);

        const policy = String(b.versionPolicy ?? "latest");
        if (policy === "pinned") {
          const pinnedVersionId = String(b.pinnedVersionId ?? "").trim();
          if (!pinnedVersionId)
            throw new Error(`role skills 配置 pinned 缺少 pinnedVersionId（skillId=${skillId}）`);
          return { skillId, skillName: String(skill.name ?? ""), skillVersionId: pinnedVersionId };
        }

        const latestVersionId = String(skill.latestVersionId ?? "").trim();
        if (!latestVersionId)
          throw new Error(`role skills 配置 latest 但 Skill 未发布 latestVersionId（skillId=${skillId}）`);
        return { skillId, skillName: String(skill.name ?? ""), skillVersionId: latestVersionId };
      });

      const versionIds = Array.from(new Set(resolved.map((x) => x.skillVersionId)));
      const versions = await deps.prisma.skillVersion.findMany({
        where: { id: { in: versionIds } } as any,
        select: { id: true, skillId: true, contentHash: true, storageUri: true },
      });
      const versionById = new Map<string, any>();
      for (const v of versions as any[]) versionById.set(String(v.id ?? ""), v);

      const missing = versionIds.filter((id) => !versionById.has(id));
      if (missing.length) throw new Error(`role skills 解析失败：SkillVersion 不存在: ${missing.join(", ")}`);

      const skillVersions = resolved.map((x) => {
        const v = versionById.get(x.skillVersionId);
        if (!v) throw new Error("unreachable");
        if (String(v.skillId ?? "") !== x.skillId) {
          throw new Error(
            `role skills 解析失败：SkillVersion 不属于该 Skill（skillId=${x.skillId}, skillVersionId=${x.skillVersionId}）`,
          );
        }
        const storageUri = typeof v.storageUri === "string" ? String(v.storageUri).trim() : "";
        if (!storageUri)
          throw new Error(`role skills 解析失败：SkillVersion.storageUri 为空（skillVersionId=${x.skillVersionId}）`);
        return {
          skillId: x.skillId,
          skillName: x.skillName,
          skillVersionId: x.skillVersionId,
          contentHash: String(v.contentHash ?? ""),
          storageUri,
        };
      });

      skillsManifest = { runId: String(run.id), skillVersions };
    }
  }
  const sandboxWorkspaceMode = getSandboxWorkspaceMode((agent as any)?.capabilities);
  const agentWorkspaceCwd = resolveAgentWorkspaceCwd({
    runId: String(run.id),
    sandboxWorkspaceMode,
  });
  const initEnv: Record<string, string> = {
    ...roleEnv,
    TUIXIU_PROJECT_ID: String(issue.projectId),
    TUIXIU_PROJECT_NAME: String(project.name ?? ""),
    TUIXIU_BASE_BRANCH: baseBranchForPrompt,
    TUIXIU_RUN_ID: String(run.id),
    TUIXIU_RUN_BRANCH: String(workspace.branchName),
    TUIXIU_WORKSPACE: String(workspace.workspacePath),
    TUIXIU_WORKSPACE_GUEST: agentWorkspaceCwd,
    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String(issue.projectId)}`,
  };
  if (resolvedPolicy.resolved === "git") {
    if (initEnv.GH_TOKEN === undefined && project?.githubAccessToken) initEnv.GH_TOKEN = String(project.githubAccessToken);
    if (initEnv.GITHUB_TOKEN === undefined && project?.githubAccessToken)
      initEnv.GITHUB_TOKEN = String(project.githubAccessToken);
    if (initEnv.GITLAB_TOKEN === undefined && project?.gitlabAccessToken)
      initEnv.GITLAB_TOKEN = String(project.gitlabAccessToken);
    if (initEnv.GITLAB_ACCESS_TOKEN === undefined && project?.gitlabAccessToken)
      initEnv.GITLAB_ACCESS_TOKEN = String(project.gitlabAccessToken);

    initEnv.TUIXIU_REPO_URL = String(project.repoUrl ?? "");
    initEnv.TUIXIU_SCM_TYPE = String(project.scmType ?? "");
    initEnv.TUIXIU_DEFAULT_BRANCH = String(project.defaultBranch ?? "");
  }
  const hasSkills = !!skillsManifest?.skillVersions?.length;
  const pipeline = buildInitPipeline({
    policy: resolvedPolicy.resolved,
    hasSkills,
    hasBundle: resolvedPolicy.resolved === "bundle" || !!bundleSource?.path,
  });
  if (pipeline.actions.length) {
    initEnv.TUIXIU_INIT_ACTIONS = pipeline.actions.map((a) => a.type).join(",");
  }

  const inventoryItems: Array<{
    key: string;
    source: "repo" | "skills" | "bundle" | "artifact";
    ref?: string | null;
    version?: string | null;
    hash?: string | null;
  }> = [];
  if (resolvedPolicy.resolved === "git" && project?.repoUrl) {
    inventoryItems.push({
      key: "repo",
      source: "repo",
      ref: String(project.repoUrl ?? ""),
      version: String(baseBranchForPrompt ?? ""),
    });
  }
  if (skillsManifest?.skillVersions?.length) {
    for (const sv of skillsManifest.skillVersions) {
      inventoryItems.push({
        key: `skill:${String(sv.skillName ?? sv.skillId)}`,
        source: "skills",
        ref: String(sv.storageUri ?? ""),
        version: String(sv.skillVersionId ?? ""),
        hash: String(sv.contentHash ?? ""),
      });
    }
  }
  if (bundleSource?.path) {
    initEnv.TUIXIU_BUNDLE_PATH = String(bundleSource.path);
    inventoryItems.push({
      key: "bundle",
      source: "bundle",
      ref: String(bundleSource.path ?? ""),
      hash: bundleSource.hash ? String(bundleSource.hash) : null,
    });
  }
  if (inventoryItems.length) {
    const inventory = stringifyContextInventory(inventoryItems);
    initEnv.TUIXIU_INVENTORY_PATH = inventory.path;
    initEnv.TUIXIU_INVENTORY_JSON = inventory.json;
    const baseMetadata =
      (run as any)?.metadata && typeof (run as any).metadata === "object" ? (run as any).metadata : {};
    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: { metadata: { ...baseMetadata, contextInventory: inventoryItems } } as any,
      })
      .catch(() => {});
  }
  if (hasSkills) {
    initEnv.TUIXIU_SKILLS_SRC = `${agentWorkspaceCwd}/.tuixiu/codex-home/skills`;
  }

  if (sandboxWorkspaceMode) {
    initEnv.TUIXIU_WORKSPACE_MODE = sandboxWorkspaceMode;
    if (sandboxWorkspaceMode === "mount") {
      initEnv.TUIXIU_SKIP_WORKSPACE_INIT = "1";
    }
  }
  if (role?.key) initEnv.TUIXIU_ROLE_KEY = String(role.key);
  if (resolvedPolicy.resolved === "git") {
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
  }

  const baseInitScript = buildWorkspaceInitScript();
  const roleInitScript = role?.initScript?.trim() ? String(role.initScript) : "";

  const init = {
    script: mergeInitScripts(baseInitScript, roleInitScript),
    timeout_seconds: role?.initTimeoutSeconds,
    env: initEnv,
    ...(skillsManifest ? { skillsManifest } : {}),
  };

  await deps.acp.promptRun({
    proxyId: String(agent.proxyId ?? ""),
    runId: run.id,
    cwd: agentWorkspaceCwd,
    sessionId: (run as any).acpSessionId ?? null,
    prompt: [{ type: "text", text: promptParts.join("\n\n") }],
    init,
  });
}
