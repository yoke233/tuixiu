import type { PrismaDeps } from "../../db.js";
import { parseEnvText, stripForbiddenGitEnv } from "../../utils/envText.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../../utils/agentInit.js";
import { resolveAgentWorkspaceCwd } from "../../utils/agentWorkspaceCwd.js";
import { buildInitPipeline } from "../../utils/initPipeline.js";
import { GitAuthEnvError } from "../../utils/gitAuth.js";
import { buildGitRuntimeEnv } from "../../utils/gitCredentialRuntime.js";
import { getSandboxWorkspaceProvider } from "../../utils/sandboxCaps.js";
import { normalizeWorkspacePolicy } from "../../utils/workspacePolicy.js";
import { mergeAgentInputsManifests } from "../agentInputs/mergeAgentInputs.js";

type RecoveryInit = {
  script: string;
  timeout_seconds?: number;
  env: Record<string, string>;
  agentInputs?: unknown;
};

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

function getRoleKey(run: any, project: any): string {
  const meta = run?.metadata;
  const metaObj = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null;
  const key = metaObj && typeof metaObj.roleKey === "string" ? metaObj.roleKey.trim() : "";
  if (key) return key;
  const fallback =
    typeof project?.defaultRoleKey === "string" && project.defaultRoleKey.trim()
      ? project.defaultRoleKey.trim()
      : "";
  return fallback;
}

function resolveBranchName(run: any): string {
  const branch = typeof run?.branchName === "string" ? run.branchName.trim() : "";
  if (branch) return branch;
  const artBranch = Array.isArray(run?.artifacts)
    ? run.artifacts.find((a: any) => a?.type === "branch")?.content?.branch
    : "";
  return typeof artBranch === "string" && artBranch.trim() ? artBranch.trim() : "";
}

export async function buildRecoveryInit(opts: {
  prisma: PrismaDeps;
  run: any;
  issue: any;
  project: any;
}): Promise<RecoveryInit | undefined> {
  const project = opts.project ?? opts.issue?.project;
  if (!project) return undefined;

  const roleKey = getRoleKey(opts.run, project);
  if (!roleKey) return undefined;

  const role = await opts.prisma.roleTemplate.findFirst({
    where: { projectId: opts.issue?.projectId, key: roleKey },
  });
  if (!role) return undefined;

  const resolvedPolicy = normalizeWorkspacePolicy(opts.run?.resolvedWorkspacePolicy) ?? "git";

  const roleEnv = normalizeRoleEnv(role?.envText ? parseEnvText(String(role.envText)) : {});

  const runGitCredentialId = resolvedPolicy === "git" ? String(project?.runGitCredentialId ?? "").trim() : "";
  if (resolvedPolicy === "git" && !runGitCredentialId) {
    throw new GitAuthEnvError("RUN_GIT_CREDENTIAL_MISSING", "Project 未配置 Run GitCredential");
  }
  const runGitCredential =
    resolvedPolicy === "git"
      ? await opts.prisma.gitCredential.findUnique({ where: { id: runGitCredentialId } } as any)
      : null;
  if (
    resolvedPolicy === "git" &&
    (!runGitCredential || String((runGitCredential as any)?.projectId ?? "") !== String(project?.id ?? ""))
  ) {
    throw new GitAuthEnvError("RUN_GIT_CREDENTIAL_MISSING", "Project 未配置 Run GitCredential");
  }

  const sandboxWorkspaceProvider = getSandboxWorkspaceProvider((opts.run as any)?.agent?.capabilities);
  const pipeline = buildInitPipeline({ policy: resolvedPolicy, hasBundle: false });

  const initEnv: Record<string, string> = {
    ...roleEnv,
    TUIXIU_PROJECT_ID: String(opts.issue?.projectId ?? ""),
    TUIXIU_PROJECT_NAME: String(project?.name ?? ""),
    TUIXIU_BASE_BRANCH: String(project?.defaultBranch ?? "main"),
    TUIXIU_RUN_ID: String(opts.run?.id ?? ""),
    TUIXIU_RUN_BRANCH: resolveBranchName(opts.run),
    TUIXIU_WORKSPACE: String(opts.run?.workspacePath ?? ""),
    TUIXIU_WORKSPACE_GUEST: resolveAgentWorkspaceCwd({
      runId: String(opts.run?.id ?? ""),
      sandboxWorkspaceProvider,
    }),
    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String(opts.issue?.projectId ?? "")}`,
  };
  if (!initEnv.USER_HOME) initEnv.USER_HOME = "/root";
  if (role?.key) initEnv.TUIXIU_ROLE_KEY = String(role.key);
  if (pipeline.actions.length) {
    initEnv.TUIXIU_INIT_ACTIONS = pipeline.actions.map((a) => a.type).join(",");
  }
  if (sandboxWorkspaceProvider) {
    initEnv.TUIXIU_WORKSPACE_PROVIDER = sandboxWorkspaceProvider;
  }
  const normalizedWorkspaceMode =
    sandboxWorkspaceProvider === "guest" && String(opts.run?.workspaceType ?? "") === "worktree"
      ? "clone"
      : String(opts.run?.workspaceType ?? "");
  initEnv.TUIXIU_WORKSPACE_MODE = normalizedWorkspaceMode || "clone";

  if (resolvedPolicy === "git") {
    initEnv.TUIXIU_REPO_URL = String(project?.repoUrl ?? "");
    initEnv.TUIXIU_SCM_TYPE = String(project?.scmType ?? "");
    initEnv.TUIXIU_DEFAULT_BRANCH = String(project?.defaultBranch ?? "");

    Object.assign(
      initEnv,
      buildGitRuntimeEnv({
        project: { repoUrl: String(project?.repoUrl ?? ""), scmType: project?.scmType ?? null },
        credential: runGitCredential as any,
      }),
    );
  }

  const baseInitScript = buildWorkspaceInitScript();
  const roleInitScript = role?.initScript?.trim() ? String(role.initScript) : "";

  const workspacePath = String(opts.run?.workspacePath ?? "").trim();

  return {
    script: mergeInitScripts(baseInitScript, roleInitScript),
    timeout_seconds: role?.initTimeoutSeconds,
    env: initEnv,
    agentInputs: workspacePath
      ? await (async () => {
          const enableRuntimeSkillsMounting = project?.enableRuntimeSkillsMounting === true;
          const skillInputs: Array<{
            skillId: string;
            skillName: string;
            skillVersionId: string;
            contentHash: string;
            storageUri: string;
          }> = [];

          if (enableRuntimeSkillsMounting && (role as any)?.id) {
            const bindings = await opts.prisma.roleSkillBinding.findMany({
              where: { roleTemplateId: (role as any).id, enabled: true } as any,
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

              skillInputs.push(...skillVersions);
            }
          }

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
                source: { type: "hostPath" as const, path: workspacePath },
                target: { root: "WORKSPACE" as const, path: "." },
              },
              ...skillItems,
            ],
          };

          return mergeAgentInputsManifests(base, (role as any)?.agentInputs ?? null);
        })()
      : undefined,
  };
}
