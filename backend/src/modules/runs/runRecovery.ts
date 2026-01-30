import type { PrismaDeps } from "../../db.js";
import { parseEnvText } from "../../utils/envText.js";
import { buildWorkspaceInitScript, mergeInitScripts } from "../../utils/agentInit.js";
import {
  assertRoleGitAuthEnv,
  pickGitAccessToken,
  resolveGitAuthMode,
  resolveGitHttpUsername,
} from "../../utils/gitAuth.js";

type RecoveryInit = {
  script: string;
  timeout_seconds?: number;
  env: Record<string, string>;
};

function normalizeRoleEnv(env: Record<string, string>): Record<string, string> {
  if (env.GH_TOKEN && env.GITHUB_TOKEN === undefined) env.GITHUB_TOKEN = env.GH_TOKEN;
  if (env.GITHUB_TOKEN && env.GH_TOKEN === undefined) env.GH_TOKEN = env.GITHUB_TOKEN;
  if (env.GITLAB_TOKEN && env.GITLAB_ACCESS_TOKEN === undefined)
    env.GITLAB_ACCESS_TOKEN = env.GITLAB_TOKEN;
  if (env.GITLAB_ACCESS_TOKEN && env.GITLAB_TOKEN === undefined)
    env.GITLAB_TOKEN = env.GITLAB_ACCESS_TOKEN;
  return env;
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

  const roleEnv = normalizeRoleEnv(role?.envText ? parseEnvText(String(role.envText)) : {});
  assertRoleGitAuthEnv(roleEnv, role?.key ?? null);
  const gitAuthMode = resolveGitAuthMode({
    repoUrl: String(project?.repoUrl ?? ""),
    scmType: project?.scmType ?? null,
    gitAuthMode: project?.gitAuthMode ?? null,
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
    TUIXIU_PROJECT_ID: String(opts.issue?.projectId ?? ""),
    TUIXIU_PROJECT_NAME: String(project?.name ?? ""),
    TUIXIU_REPO_URL: String(project?.repoUrl ?? ""),
    TUIXIU_SCM_TYPE: String(project?.scmType ?? ""),
    TUIXIU_DEFAULT_BRANCH: String(project?.defaultBranch ?? ""),
    TUIXIU_BASE_BRANCH: String(project?.defaultBranch ?? "main"),
    TUIXIU_RUN_ID: String(opts.run?.id ?? ""),
    TUIXIU_RUN_BRANCH: resolveBranchName(opts.run),
    TUIXIU_WORKSPACE: String(opts.run?.workspacePath ?? ""),
    TUIXIU_WORKSPACE_GUEST: "/workspace",
    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String(opts.issue?.projectId ?? "")}`,
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

  return {
    script: mergeInitScripts(baseInitScript, roleInitScript),
    timeout_seconds: role?.initTimeoutSeconds,
    env: initEnv,
  };
}
