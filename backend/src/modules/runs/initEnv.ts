import { buildGitRuntimeEnv } from "../../utils/gitCredentialRuntime.js";
import type { WorkspaceMode } from "../../utils/runWorkspace.js";
import type { WorkspacePolicy } from "../../utils/workspacePolicy.js";

export type BuildRunInitEnvParams = {
  roleEnv: Record<string, string>;
  project: {
    id?: string | null;
    name?: string | null;
    repoUrl?: string | null;
    scmType?: string | null;
    defaultBranch?: string | null;
  };
  issueProjectId: string;
  runId: string;
  baseBranch: string;
  branchName: string;
  workspaceGuestPath: string;
  workspaceMode: WorkspaceMode;
  sandboxWorkspaceProvider?: string | null;
  resolvedPolicy: WorkspacePolicy;
  runGitCredential?: any | null;
  initActions?: string | null;
  workspaceHostPath?: string | null;
  roleKey?: string | null;
};

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
}

export function buildRunInitEnv(params: BuildRunInitEnvParams): Record<string, string> {
  const initEnv: Record<string, string> = {
    ...params.roleEnv,
    TUIXIU_PROJECT_ID: String(params.issueProjectId ?? ""),
    TUIXIU_PROJECT_NAME: String(params.project?.name ?? ""),
    TUIXIU_BASE_BRANCH: String(params.baseBranch ?? ""),
    TUIXIU_RUN_ID: String(params.runId ?? ""),
    TUIXIU_RUN_BRANCH: String(params.branchName ?? ""),
    TUIXIU_WORKSPACE_GUEST: String(params.workspaceGuestPath ?? ""),
    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${String(params.issueProjectId ?? "")}`,
  };

  if (params.workspaceHostPath) {
    initEnv.TUIXIU_WORKSPACE = String(params.workspaceHostPath);
  }
  if (params.initActions) {
    initEnv.TUIXIU_INIT_ACTIONS = String(params.initActions);
  }
  if (params.sandboxWorkspaceProvider) {
    initEnv.TUIXIU_WORKSPACE_PROVIDER = String(params.sandboxWorkspaceProvider);
  }

  const normalizedWorkspaceMode =
    params.sandboxWorkspaceProvider === "guest" && params.workspaceMode === "worktree"
      ? "clone"
      : params.workspaceMode;
  initEnv.TUIXIU_WORKSPACE_MODE = normalizedWorkspaceMode;

  if (params.roleKey) initEnv.TUIXIU_ROLE_KEY = String(params.roleKey);

  if (params.resolvedPolicy === "git") {
    const repoUrl = String(params.project?.repoUrl ?? "").trim();
    const scmType = String(params.project?.scmType ?? "").trim();
    const defaultBranch = String(params.project?.defaultBranch ?? "").trim();
    requireNonEmpty(repoUrl, "TUIXIU_REPO_URL");
    requireNonEmpty(params.branchName, "TUIXIU_RUN_BRANCH");
    requireNonEmpty(params.baseBranch, "TUIXIU_BASE_BRANCH");

    initEnv.TUIXIU_REPO_URL = repoUrl;
    initEnv.TUIXIU_SCM_TYPE = scmType;
    initEnv.TUIXIU_DEFAULT_BRANCH = defaultBranch;

    Object.assign(
      initEnv,
      buildGitRuntimeEnv({
        project: { repoUrl, scmType: scmType || null },
        credential: params.runGitCredential as any,
      }),
    );
  }

  if (!initEnv.USER_HOME) initEnv.USER_HOME = "/root";
  if (!initEnv.TUIXIU_BWRAP_USERNAME) initEnv.TUIXIU_BWRAP_USERNAME = "agent";
  if (!initEnv.TUIXIU_BWRAP_UID) initEnv.TUIXIU_BWRAP_UID = "1000";
  if (!initEnv.TUIXIU_BWRAP_GID) initEnv.TUIXIU_BWRAP_GID = initEnv.TUIXIU_BWRAP_UID;
  if (!initEnv.TUIXIU_BWRAP_HOME_PATH) initEnv.TUIXIU_BWRAP_HOME_PATH = initEnv.USER_HOME;

  return initEnv;
}


