import type { PrismaDeps } from "../../db.js";
import { Prisma } from "@prisma/client";
import { uuidv7 } from "../../utils/uuid.js";
import { toPublicProject } from "../../utils/publicProject.js";
import { suggestRunKeyWithLlm } from "../../utils/gitWorkspace.js";
import { parseEnvText, stripForbiddenGitEnv } from "../../utils/envText.js";
import {
  DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
  deriveSandboxInstanceName,
  normalizeKeepaliveTtlSeconds,
} from "../../utils/sandbox.js";
import { renderTextTemplate } from "../../utils/textTemplate.js";
import { postGitHubIssueCommentBestEffort } from "../scm/githubIssueComments.js";
import type { AcpTunnel } from "../acp/acpTunnel.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../../utils/agentInit.js";
import { buildRunInitEnv } from "./initEnv.js";
import { getSandboxWorkspaceProvider } from "../../utils/sandboxCaps.js";
import { resolveAgentWorkspaceCwd } from "../../utils/agentWorkspaceCwd.js";
import { resolveExecutionProfile } from "../../utils/executionProfile.js";
import { GitAuthEnvError } from "../../utils/gitAuth.js";
import { buildInitPipeline } from "../../utils/initPipeline.js";
import { stringifyContextInventory } from "../../utils/contextInventory.js";
import { assertWorkspacePolicyCompat, resolveWorkspacePolicy } from "../../utils/workspacePolicy.js";
import { mergeAgentInputsManifests } from "../agentInputs/mergeAgentInputs.js";
import { loadProjectCredentials } from "../../utils/projectCredentials.js";

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
  const out = { ...env };
  if (out.GH_TOKEN && out.GITHUB_TOKEN === undefined) out.GITHUB_TOKEN = out.GH_TOKEN;
  if (out.GITHUB_TOKEN && out.GH_TOKEN === undefined) out.GH_TOKEN = out.GITHUB_TOKEN;
  if (out.GITLAB_TOKEN && out.GITLAB_ACCESS_TOKEN === undefined)
    out.GITLAB_ACCESS_TOKEN = out.GITLAB_TOKEN;
  if (out.GITLAB_ACCESS_TOKEN && out.GITLAB_TOKEN === undefined)
    out.GITLAB_TOKEN = out.GITLAB_ACCESS_TOKEN;
  return stripForbiddenGitEnv(out);
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

  const effectiveRoleKey = roleKey?.trim() ? roleKey.trim() : "";
  if (!effectiveRoleKey) {
    return {
      success: false,
      error: { code: "ROLE_REQUIRED", message: "必须选择 RoleTemplate" },
    };
  }
  const role = await opts.prisma.roleTemplate.findFirst({
    where: { projectId: (issue as any).projectId, key: effectiveRoleKey },
  });

  if (!role) {
    return {
      success: false,
      error: { code: "NO_ROLE", message: "RoleTemplate 不存在" },
    };
  }

  const project = (issue as any).project as any;
  const executionProfile = await resolveExecutionProfile({
    prisma: opts.prisma,
    platformProfileKey: process.env.EXECUTION_PROFILE_DEFAULT_KEY ?? null,
    roleProfileId: (role as any)?.executionProfileId ?? null,
    projectProfileId: project?.executionProfileId ?? null,
  });
  const resolvedPolicy = resolveWorkspacePolicy({
    projectPolicy: project?.workspacePolicy ?? null,
    rolePolicy: (role as any)?.workspacePolicy ?? null,
    taskPolicy: null,
    profilePolicy: executionProfile?.workspacePolicy ?? null,
  });
  const hasBundle = resolvedPolicy.resolved === "bundle";
  if (hasBundle) {
    return {
      success: false,
      error: { code: "BUNDLE_MISSING", message: "bundle policy 需要提供 bundle 来源" },
    };
  }

  const runGitCredentialId =
    resolvedPolicy.resolved === "git" ? String(project?.runGitCredentialId ?? "").trim() : "";
  if (resolvedPolicy.resolved === "git" && !runGitCredentialId) {
    return {
      success: false,
      error: { code: "RUN_GIT_CREDENTIAL_MISSING", message: "Project 未配置 Run GitCredential" },
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
      resolvedWorkspacePolicy: resolvedPolicy.resolved,
      workspacePolicySource: resolvedPolicy,
      executionProfileId: executionProfile?.id ?? null,
      executionProfileSnapshot: executionProfile
        ? (executionProfile as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
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
  const { admin } = await loadProjectCredentials(opts.prisma, project ?? {});
  const githubAccessToken = String((admin as any)?.githubAccessToken ?? "").trim();
  const repoUrl = String(project?.repoUrl ?? "").trim();

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
  let baseBranchForRun = String(project?.defaultBranch ?? "").trim() || "main";
  let workspaceMode: WorkspaceMode = "clone";
  try {
    const baseBranch = project?.defaultBranch || "main";
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

    assertWorkspacePolicyCompat({ policy: resolvedPolicy.resolved, capabilities: caps });
    const sandboxWorkspaceProvider = getSandboxWorkspaceProvider(caps);
    const snapshot = {
      workspaceMode,
      workspacePath,
      branchName,
      baseBranch: resolvedBaseBranch,
      gitAuthMode: ws.gitAuthMode ?? null,
      sandbox: { provider: sandboxProvider, workspaceProvider: sandboxWorkspaceProvider ?? undefined },
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
      .catch(() => { });
    await opts.prisma.agent
      .update({
        where: { id: (selectedAgent as any).id },
        data: { currentLoad: { decrement: 1 } },
      })
      .catch(() => { });

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

  const sandboxWorkspaceProvider = getSandboxWorkspaceProvider((selectedAgent as any)?.capabilities);
  const agentWorkspacePath = resolveAgentWorkspaceCwd({
    runId: String((run as any).id ?? ""),
    sandboxWorkspaceProvider,
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
    const runGitCredential =
      resolvedPolicy.resolved === "git"
        ? await opts.prisma.gitCredential.findUnique({ where: { id: runGitCredentialId } } as any)
        : null;
    if (
      resolvedPolicy.resolved === "git" &&
      (!runGitCredential || String((runGitCredential as any)?.projectId ?? "") !== String(project?.id ?? ""))
    ) {
      throw new GitAuthEnvError("RUN_GIT_CREDENTIAL_MISSING", "Project 未配置 Run GitCredential");
    }

    const initEnv = buildRunInitEnv({
      roleEnv,
      project: {
        id: project?.id ?? null,
        name: project?.name ?? null,
        repoUrl: project?.repoUrl ?? null,
        scmType: project?.scmType ?? null,
        defaultBranch: project?.defaultBranch ?? null,
      },
      issueProjectId: String((issue as any).projectId),
      runId: String((run as any).id),
      baseBranch: String(baseBranchForRun),
      branchName: String(branchName),
      workspaceGuestPath: String(agentWorkspacePath),
      workspaceMode,
      sandboxWorkspaceProvider,
      resolvedPolicy: resolvedPolicy.resolved,
      runGitCredential,
      roleKey: role?.key ? String(role.key) : null,
    });

    const enableRuntimeSkillsMounting = project?.enableRuntimeSkillsMounting === true;
    const skillInputs: Array<{
      skillId: string;
      skillName: string;
      skillVersionId: string;
      contentHash: string;
      storageUri: string;
    }> = [];
    if (enableRuntimeSkillsMounting && role?.id) {
      const bindings = await opts.prisma.roleSkillBinding.findMany({
        where: { roleTemplateId: role.id, enabled: true } as any,
        orderBy: { createdAt: "asc" },
        select: { skillId: true, versionPolicy: true, pinnedVersionId: true },
      });

      if (bindings.length) {
        const skillIds = bindings.map((b: any) => String(b.skillId ?? "")).filter(Boolean);
        const skills = await opts.prisma.skill.findMany({
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
            if (!pinnedVersionId) throw new Error(`role skills 配置 pinned 缺少 pinnedVersionId（skillId=${skillId}）`);
            return { skillId, skillName: String(skill.name ?? ""), skillVersionId: pinnedVersionId };
          }

          const latestVersionId = String(skill.latestVersionId ?? "").trim();
          if (!latestVersionId) throw new Error(`role skills 配置 latest 但 Skill 未发布 latestVersionId（skillId=${skillId}）`);
          return { skillId, skillName: String(skill.name ?? ""), skillVersionId: latestVersionId };
        });

        const versionIds = Array.from(new Set(resolved.map((x) => x.skillVersionId)));
        const versions = await opts.prisma.skillVersion.findMany({
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
            throw new Error(`role skills 解析失败：SkillVersion 不属于该 Skill（skillId=${x.skillId}, skillVersionId=${x.skillVersionId}）`);
          }
          const storageUri = typeof v.storageUri === "string" ? String(v.storageUri).trim() : "";
          if (!storageUri) throw new Error(`role skills 解析失败：SkillVersion.storageUri 为空（skillVersionId=${x.skillVersionId}）`);
          return {
            skillId: x.skillId,
            skillName: x.skillName,
            skillVersionId: x.skillVersionId,
            contentHash: String(v.contentHash ?? ""),
            storageUri,
          };
        });

        skillInputs.push(...skillVersions);
      }
    }
    const hasSkills = skillInputs.length > 0;
    const pipeline = buildInitPipeline({
      policy: resolvedPolicy.resolved,
      hasBundle,
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
        version: String(baseBranchForRun ?? ""),
      });
    }
    if (hasSkills) {
      for (const sv of skillInputs) {
        inventoryItems.push({
          key: `skill:${String(sv.skillName ?? sv.skillId)}`,
          source: "skills",
          ref: String(sv.storageUri ?? ""),
          version: String(sv.skillVersionId ?? ""),
          hash: String(sv.contentHash ?? ""),
        });
      }
    }
    if (inventoryItems.length) {
      const inventory = stringifyContextInventory(inventoryItems);
      initEnv.TUIXIU_INVENTORY_PATH = inventory.path;
      initEnv.TUIXIU_INVENTORY_JSON = inventory.json;
      const baseMetadata =
        (run as any)?.metadata && typeof (run as any).metadata === "object" ? (run as any).metadata : {};
      await opts.prisma.run
        .update({
          where: { id: (run as any).id },
          data: { metadata: { ...baseMetadata, contextInventory: inventoryItems } } as any,
        })
        .catch(() => { });
    }
    if (hasSkills) {
      // skills 将通过 agentInputs 落地到 USER_HOME/.codex/skills（不再拷贝进 workspace）
    }

    const baseInitScript = buildWorkspaceInitScript();
    const roleInitScript = role?.initScript?.trim() ? String(role.initScript) : "";

    const init = {
      script: mergeInitScripts(baseInitScript, roleInitScript),
      timeout_seconds: role?.initTimeoutSeconds,
      env: initEnv,
      agentInputs: (() => {
        const kebabCase = (value: string) =>
          value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80);

        const usedNames = new Set<string>();
        const skillItems = skillInputs.map((sv) => {
          let dirName = kebabCase(String(sv.skillName ?? ""));
          if (!dirName) dirName = `skill-${String(sv.skillId).slice(0, 8)}`;
          if (usedNames.has(dirName)) dirName = `${dirName}-${String(sv.contentHash).slice(0, 8)}`;
          usedNames.add(dirName);
          return {
            id: `skill:${dirName}`,
            apply: "downloadExtract" as const,
            access: "rw" as const,
            source: {
              type: "httpZip" as const,
              uri: String(sv.storageUri),
              contentHash: String(sv.contentHash),
            },
            target: { root: "USER_HOME" as const, path: `.codex/skills/${dirName}` },
          };
        });

        const base = {
          version: 1 as const,
          items: [
            {
              id: "workspace",
              apply: "bindMount" as const,
              access: "rw" as const,
              source: { type: "hostPath" as const, path: String(workspacePath) },
              target: { root: "WORKSPACE" as const, path: "." },
            },
            ...skillItems,
          ],
        };

        return mergeAgentInputsManifests(base, (role as any)?.agentInputs ?? null);
      })(),
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
    const gitAuthErr =
      error instanceof GitAuthEnvError
        ? { code: error.code, message: error.message, details: error.details }
        : null;

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
      .catch(() => { });

    return {
      success: false,
      error:
        gitAuthErr ??
        ({
          code: "AGENT_SEND_FAILED",
          message: "发送任务到 Agent 失败",
          details: String(error),
        } as any),
      data: { issue: toPublicIssue(issue as any), run },
    };
  }

  return { success: true, data: { run } };
}
