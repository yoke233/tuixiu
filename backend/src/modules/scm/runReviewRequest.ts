import type { PrismaDeps } from "../../db.js";
import * as gitlab from "../../integrations/gitlab.js";
import * as github from "../../integrations/github.js";
import type { GitAuthProject } from "../../utils/gitAuth.js";
import { isSandboxGitPushEnabled } from "../../utils/sandboxCaps.js";
import { postGitHubPrCreatedCommentBestEffort } from "./githubIssueComments.js";
import { buildRunScmStateUpdate } from "./runScmState.js";

export type RunReviewDeps = {
  prisma: PrismaDeps;
  sandboxGitPush?: (opts: { run: any; branch: string; project: GitAuthProject }) => Promise<void>;
  gitlab?: {
    inferBaseUrl?: typeof gitlab.inferGitlabBaseUrl;
    createMergeRequest?: typeof gitlab.createMergeRequest;
    mergeMergeRequest?: typeof gitlab.mergeMergeRequest;
    getMergeRequest?: typeof gitlab.getMergeRequest;
  };
  github?: {
    parseRepo?: typeof github.parseGitHubRepo;
    createPullRequest?: typeof github.createPullRequest;
    mergePullRequest?: typeof github.mergePullRequest;
    getPullRequest?: typeof github.getPullRequest;
  };
};

function appendGitHubIssueLinkForPrBody(params: {
  body: string;
  issue: { externalProvider?: string | null; externalNumber?: number | null; externalUrl?: string | null };
}): string {
  const provider = String(params.issue.externalProvider ?? "").toLowerCase();
  if (provider !== "github") return params.body;

  const externalNumber = params.issue.externalNumber;
  if (typeof externalNumber !== "number" || !Number.isFinite(externalNumber) || externalNumber <= 0) {
    return params.body;
  }

  const externalUrl = params.issue.externalUrl?.trim();
  const issueRefRegex = new RegExp(`#${externalNumber}(?!\\d)`);
  if (issueRefRegex.test(params.body)) return params.body;
  if (externalUrl && params.body.includes(externalUrl)) return params.body;

  const trimmed = params.body.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}Closes #${externalNumber}`;
}

function isSandboxGitPushRun(run: any): boolean {
  const assignedCaps = run?.issue?.assignedAgent?.capabilities;
  const runCaps = run?.agent?.capabilities;
  return isSandboxGitPushEnabled(assignedCaps ?? runCaps);
}

export async function createReviewRequestForRun(
  deps: RunReviewDeps,
  runId: string,
  body: { title?: string; description?: string; targetBranch?: string },
  opts?: { setRunWaitingCi?: boolean }
): Promise<{
  success: boolean;
  data?: { pr: unknown };
  error?: { code: string; message: string; details?: string };
}> {
  const inferGitlabBaseUrl = deps.gitlab?.inferBaseUrl ?? gitlab.inferGitlabBaseUrl;
  const createMergeRequest = deps.gitlab?.createMergeRequest ?? gitlab.createMergeRequest;
  const parseGitHubRepo = deps.github?.parseRepo ?? github.parseGitHubRepo;
  const createPullRequest = deps.github?.createPullRequest ?? github.createPullRequest;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      agent: { select: { id: true, capabilities: true } } as any,
      issue: { include: { project: true, assignedAgent: { select: { id: true, capabilities: true } } } } as any,
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
  }

  const runAny = run as any;

  const taskId = (run as any).taskId as string | null;
  const existingScmProvider = typeof runAny.scmProvider === "string" ? String(runAny.scmProvider).trim() : "";
  const existingScmPrNumber = Number.isFinite(runAny.scmPrNumber as any) ? Number(runAny.scmPrNumber) : null;
  const existingScmPrUrl = typeof runAny.scmPrUrl === "string" ? String(runAny.scmPrUrl).trim() : "";
  const existingScmPrState = typeof runAny.scmPrState === "string" ? String(runAny.scmPrState).trim() : "";

  if (existingScmPrUrl || (existingScmPrNumber && existingScmPrNumber > 0)) {
    return {
      success: true,
      data: {
        pr: {
          provider: existingScmProvider || null,
          number: existingScmPrNumber,
          url: existingScmPrUrl || null,
          state: existingScmPrState || null,
        },
      },
    };
  }

  if (taskId) {
    // best-effort: backward compatible lookup (old data may still store PR in Artifact)
    const existingPr = await deps.prisma.artifact
      .findFirst({
        where: { type: "pr", run: { is: { taskId } } } as any,
        orderBy: { createdAt: "desc" },
      })
      .catch(() => null);
    if (existingPr) return { success: true, data: { pr: existingPr } };
  }

  const project = runAny.issue.project;
  const scm = String(project.scmType ?? "").toLowerCase();

  if (scm !== "gitlab" && scm !== "codeup" && scm !== "github") {
    return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub/Codeup" } };
  }

  const branchArtifact = runAny.artifacts.find((a: any) => a.type === "branch");
  const branchFromArtifact = (branchArtifact?.content as any)?.branch;
  const branch = runAny.branchName || (typeof branchFromArtifact === "string" ? branchFromArtifact : "");
  if (!branch) {
    return { success: false, error: { code: "NO_BRANCH", message: "Run 暂无 branch 信息" } };
  }

  const targetBranch = body.targetBranch ?? project.defaultBranch ?? "main";
  const title = body.title ?? runAny.issue.title ?? `Run ${runAny.id}`;
  const description = body.description ?? runAny.issue.description ?? "";

  const shouldSandboxGitPush = isSandboxGitPushRun(runAny);
  if (!shouldSandboxGitPush) {
    return {
      success: false,
      error: { code: "SANDBOX_GIT_PUSH_UNSUPPORTED", message: "sandbox 不支持 git push" },
    };
  }
  if (!deps.sandboxGitPush) {
    return { success: false, error: { code: "NO_SANDBOX_GIT_PUSH", message: "sandbox git push 未配置" } };
  }
  try {
    await deps.sandboxGitPush({ run: runAny, branch, project });
  } catch (err) {
    return { success: false, error: { code: "GIT_PUSH_FAILED", message: "git push 失败", details: String(err) } };
  }

  if (scm === "gitlab" || scm === "codeup") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab/Codeup projectId/token" }
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab/Codeup baseUrl" } };
    }

    const auth: gitlab.GitLabAuth = {
      baseUrl,
      projectId: project.gitlabProjectId,
      accessToken: project.gitlabAccessToken
    };

    let mergeRequest: gitlab.GitLabMergeRequest;
    try {
      mergeRequest = await createMergeRequest(auth, { sourceBranch: branch, targetBranch, title, description });
    } catch (err) {
      return {
        success: false,
        error: { code: "GITLAB_PR_FAILED", message: "创建 GitLab/Codeup PR 失败", details: String(err) }
      };
    }

    const stateRaw = String(mergeRequest.state ?? "").trim().toLowerCase();
    const prState = stateRaw === "merged" ? "merged" : stateRaw === "closed" ? "closed" : "open";
    const now = new Date();

    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "gitlab",
              scmPrNumber: mergeRequest.iid,
              scmPrUrl: mergeRequest.web_url,
              scmPrState: prState as any,
            },
            { now },
          ),
          ...(opts?.setRunWaitingCi !== false ? ({ status: "waiting_ci" } as any) : null),
        } as any,
      })
      .catch(() => {});

    if (opts?.setRunWaitingCi !== false) {
      // status 已在上面 update 中写入（best-effort）；这里保留兼容逻辑
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "waiting_ci" } }).catch(() => {});
    }

    const issueIsGitHub = String((run as any)?.issue?.externalProvider ?? "").toLowerCase() === "github";
    const issueNumber = Number((run as any)?.issue?.externalNumber ?? 0);
    const repoUrlForIssue = String((run as any)?.issue?.externalUrl ?? project.repoUrl ?? "").trim();
    const githubTokenForComment = String(project.githubAccessToken ?? "").trim();
    if (issueIsGitHub && githubTokenForComment) {
      await postGitHubPrCreatedCommentBestEffort({
        prisma: deps.prisma,
        projectId: (run as any)?.issue?.projectId ?? null,
        repoUrl: repoUrlForIssue,
        githubAccessToken: githubTokenForComment,
        issueNumber,
        runId: run.id,
        prUrl: mergeRequest.web_url,
        provider: "gitlab",
        sourceBranch: mergeRequest.source_branch,
        targetBranch: mergeRequest.target_branch,
      });
    }
    return {
      success: true,
      data: { pr: { provider: "gitlab", number: mergeRequest.iid, url: mergeRequest.web_url, state: prState } },
    };
  }

  if (scm === "github") {
    const token = project.githubAccessToken;
    if (!token) {
      return { success: false, error: { code: "NO_GITHUB_CONFIG", message: "Project 未配置 GitHub token" } };
    }

    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 解析 GitHub owner/repo" } };
    }

    const auth: github.GitHubAuth = {
      apiBaseUrl: parsed.apiBaseUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      accessToken: token
    };

    let pr: github.GitHubPullRequest;
    const prBody = appendGitHubIssueLinkForPrBody({ body: description, issue: run.issue });
    try {
      pr = await createPullRequest(auth, { head: branch, base: targetBranch, title, body: prBody });
    } catch (err) {
      return {
        success: false,
        error: { code: "GITHUB_PR_FAILED", message: "创建 GitHub PR 失败", details: String(err) }
      };
    }

    const prUrl = String(pr.html_url ?? "").trim();
    const prNumber = Number(pr.number ?? 0);
    const headSha = String((pr as any)?.head?.sha ?? "").trim();
    const baseRef = String((pr as any)?.base?.ref ?? "").trim();
    const headRef = String((pr as any)?.head?.ref ?? "").trim();
    const isMerged = Boolean((pr as any)?.merged_at);
    const stateRaw = String((pr as any)?.state ?? "").trim().toLowerCase();
    const prState = isMerged ? "merged" : stateRaw === "closed" ? "closed" : "open";
    const now = new Date();

    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "github",
              scmPrNumber: prNumber || null,
              scmPrUrl: prUrl || null,
              scmPrState: prState as any,
              scmHeadSha: headSha || null,
            },
            { now },
          ),
          ...(opts?.setRunWaitingCi !== false ? ({ status: "waiting_ci" } as any) : null),
        } as any,
      })
      .catch(() => {});

    if (opts?.setRunWaitingCi !== false) {
      // status 已在上面 update 中写入（best-effort）；这里保留兼容逻辑
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "waiting_ci" } }).catch(() => {});
    }

    const issueIsGitHub = String((run as any)?.issue?.externalProvider ?? "").toLowerCase() === "github";
    const issueNumber = Number((run as any)?.issue?.externalNumber ?? 0);
    const repoUrlForIssue = String((run as any)?.issue?.externalUrl ?? project.repoUrl ?? "").trim();
    if (issueIsGitHub && token) {
      await postGitHubPrCreatedCommentBestEffort({
        prisma: deps.prisma,
        projectId: (run as any)?.issue?.projectId ?? null,
        repoUrl: repoUrlForIssue,
        githubAccessToken: token,
        issueNumber,
        runId: run.id,
        prUrl: pr.html_url,
        provider: "github",
        sourceBranch: pr.head.ref,
        targetBranch: pr.base.ref,
      });
    }
    return {
      success: true,
      data: {
        pr: {
          provider: "github",
          number: prNumber || null,
          url: prUrl || null,
          state: prState,
          baseBranch: baseRef || null,
          headBranch: headRef || null,
          headSha: headSha || null,
        },
      },
    };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub/Codeup" } };
}

export async function mergeReviewRequestForRun(
  deps: RunReviewDeps,
  runId: string,
  body: { squash?: boolean; mergeCommitMessage?: string }
): Promise<{
  success: boolean;
  data?: { pr: unknown };
  error?: { code: string; message: string; details?: string };
}> {
  const inferGitlabBaseUrl = deps.gitlab?.inferBaseUrl ?? gitlab.inferGitlabBaseUrl;
  const mergeMergeRequest = deps.gitlab?.mergeMergeRequest ?? gitlab.mergeMergeRequest;
  const getMergeRequest = deps.gitlab?.getMergeRequest ?? gitlab.getMergeRequest;
  const parseGitHubRepo = deps.github?.parseRepo ?? github.parseGitHubRepo;
  const mergePullRequest = deps.github?.mergePullRequest ?? github.mergePullRequest;
  const getPullRequest = deps.github?.getPullRequest ?? github.getPullRequest;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
  }

  const project = run.issue.project;
  const scm = String(project.scmType ?? "").toLowerCase();

  const prNumberFromRun = Number.isFinite((run as any).scmPrNumber as any) ? Number((run as any).scmPrNumber) : null;
  const prUrlFromRun = typeof (run as any).scmPrUrl === "string" ? String((run as any).scmPrUrl).trim() : "";

  let prNumber = prNumberFromRun;
  let prUrl = prUrlFromRun;

  // backward compatible fallback (old data may still store PR in Artifact)
  const taskId = (run as any).taskId as string | null;
  let prArtifact = null as any;
  let content = {} as any;
  if (!prNumber) {
    prArtifact = run.artifacts.find((a: any) => a.type === "pr") as any;
    if (!prArtifact && taskId) {
      prArtifact = await deps.prisma.artifact
        .findFirst({
          where: { type: "pr", run: { is: { taskId } } } as any,
          orderBy: { createdAt: "desc" },
        })
        .catch(() => null);
    }
    content = (prArtifact?.content ?? {}) as any;

    if (scm === "gitlab" || scm === "codeup") {
      const iid = Number(content.iid);
      if (Number.isFinite(iid) && iid > 0) prNumber = iid;
      if (!prUrl) {
        prUrl =
          typeof content.webUrl === "string"
            ? String(content.webUrl).trim()
            : typeof content.web_url === "string"
              ? String(content.web_url).trim()
              : "";
      }
    }

    if (scm === "github") {
      const n = Number(content.number);
      if (Number.isFinite(n) && n > 0) prNumber = n;
      if (!prUrl) {
        prUrl =
          typeof content.webUrl === "string"
            ? String(content.webUrl).trim()
            : typeof content.web_url === "string"
              ? String(content.web_url).trim()
              : "";
      }
    }
  }

  if (!prNumber || prNumber <= 0) {
    return { success: false, error: { code: "NO_PR", message: "Run 暂无 PR 信息" } };
  }
  if (scm === "gitlab" || scm === "codeup") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab/Codeup projectId/token" }
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab/Codeup baseUrl" } };
    }

    const auth: gitlab.GitLabAuth = {
      baseUrl,
      projectId: project.gitlabProjectId,
      accessToken: project.gitlabAccessToken
    };

    let mergeRequest: gitlab.GitLabMergeRequest;
    try {
      mergeRequest = await mergeMergeRequest(auth, {
        iid: prNumber,
        squash: body.squash,
        mergeCommitMessage: body.mergeCommitMessage
      });
    } catch (err) {
      return { success: false, error: { code: "GITLAB_MERGE_FAILED", message: "合并 PR 失败", details: String(err) } };
    }

    // best-effort: refresh state after merge (some GitLab instances are eventually consistent)
    try {
      mergeRequest = await getMergeRequest(auth, { iid: prNumber });
    } catch {
      // ignore
    }

    const stateRaw = String(mergeRequest.state ?? "").trim().toLowerCase();
    const prState = stateRaw === "merged" ? "merged" : stateRaw === "closed" ? "closed" : "open";
    const now = new Date();
    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "gitlab",
              scmPrNumber: prNumber,
              scmPrUrl: String(mergeRequest.web_url ?? prUrl ?? "").trim() || null,
              scmPrState: prState as any,
            },
            { now },
          ),
        } as any,
      })
      .catch(() => {});

    if (String(mergeRequest.state).toLowerCase() === "merged") {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return {
      success: true,
      data: {
        pr: { provider: "gitlab", number: prNumber, url: String(mergeRequest.web_url ?? prUrl ?? "").trim() || null, state: prState },
      },
    };
  }

  if (scm === "github") {
    const token = project.githubAccessToken;
    if (!token) {
      return { success: false, error: { code: "NO_GITHUB_CONFIG", message: "Project 未配置 GitHub token" } };
    }
    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 解析 GitHub owner/repo" } };
    }

    const auth: github.GitHubAuth = {
      apiBaseUrl: parsed.apiBaseUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      accessToken: token
    };

    let merged = false;
    try {
      const res = await mergePullRequest(auth, {
        pullNumber: prNumber,
        mergeMethod: body.squash ? "squash" : "merge",
        commitMessage: body.mergeCommitMessage
      });
      merged = Boolean(res.merged);
    } catch (err) {
      return { success: false, error: { code: "GITHUB_MERGE_FAILED", message: "合并 PR 失败", details: String(err) } };
    }

    let pr: github.GitHubPullRequest | null = null;
    try {
      pr = await getPullRequest(auth, { pullNumber: prNumber });
    } catch {
      // ignore
    }

    const nextState =
      merged || (pr?.merged_at ? true : false) ? "merged" : (typeof pr?.state === "string" ? pr.state : "unknown");

    const prUrlNext = String((pr as any)?.html_url ?? prUrl ?? "").trim();
    const headShaNext = String((pr as any)?.head?.sha ?? (run as any)?.scmHeadSha ?? "").trim();
    const prState = String(nextState).toLowerCase() === "merged" ? "merged" : String(nextState).toLowerCase() === "closed" ? "closed" : "open";
    const now = new Date();

    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "github",
              scmPrNumber: prNumber,
              scmPrUrl: prUrlNext || null,
              scmPrState: prState as any,
              scmHeadSha: headShaNext || null,
            },
            { now },
          ),
        } as any,
      })
      .catch(() => {});

    if (merged) {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return {
      success: true,
      data: { pr: { provider: "github", number: prNumber, url: prUrlNext || null, state: prState, merged } },
    };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub/Codeup" } };
}

export async function syncReviewRequestForRun(
  deps: RunReviewDeps,
  runId: string,
): Promise<{
  success: boolean;
  data?: { pr: unknown };
  error?: { code: string; message: string; details?: string };
}> {
  const inferGitlabBaseUrl = deps.gitlab?.inferBaseUrl ?? gitlab.inferGitlabBaseUrl;
  const getMergeRequest = deps.gitlab?.getMergeRequest ?? gitlab.getMergeRequest;
  const parseGitHubRepo = deps.github?.parseRepo ?? github.parseGitHubRepo;
  const getPullRequest = deps.github?.getPullRequest ?? github.getPullRequest;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!run) {
    return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
  }

  const project = run.issue.project;
  const scm = String(project.scmType ?? "").toLowerCase();

  const prNumberFromRun = Number.isFinite((run as any).scmPrNumber as any) ? Number((run as any).scmPrNumber) : null;
  const prUrlFromRun = typeof (run as any).scmPrUrl === "string" ? String((run as any).scmPrUrl).trim() : "";

  let prNumber = prNumberFromRun;
  let prUrl = prUrlFromRun;

  // backward compatible fallback (old data may still store PR in Artifact)
  const taskId = (run as any).taskId as string | null;
  let prArtifact = null as any;
  let content = {} as any;
  if (!prNumber) {
    prArtifact = run.artifacts.find((a: any) => a.type === "pr") as any;
    if (!prArtifact && taskId) {
      prArtifact = await deps.prisma.artifact
        .findFirst({
          where: { type: "pr", run: { is: { taskId } } } as any,
          orderBy: { createdAt: "desc" },
        })
        .catch(() => null);
    }
    content = (prArtifact?.content ?? {}) as any;
  }

  if (!prNumber) {
    if (scm === "gitlab" || scm === "codeup") {
      const iid = Number(content.iid);
      if (Number.isFinite(iid) && iid > 0) prNumber = iid;
      if (!prUrl) prUrl = typeof content.webUrl === "string" ? String(content.webUrl).trim() : String(content.web_url ?? "").trim();
    }

    if (scm === "github") {
      const n = Number(content.number);
      if (Number.isFinite(n) && n > 0) prNumber = n;
      if (!prUrl) prUrl = typeof content.webUrl === "string" ? String(content.webUrl).trim() : String(content.web_url ?? "").trim();
    }
  }

  if (!prNumber || prNumber <= 0) {
    return { success: false, error: { code: "NO_PR", message: "Run 暂无 PR 信息" } };
  }
  if (scm === "gitlab" || scm === "codeup") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab/Codeup projectId/token" },
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab/Codeup baseUrl" } };
    }

    const auth: gitlab.GitLabAuth = {
      baseUrl,
      projectId: project.gitlabProjectId,
      accessToken: project.gitlabAccessToken,
    };

    let mergeRequest: gitlab.GitLabMergeRequest;
    try {
      mergeRequest = await getMergeRequest(auth, { iid: prNumber });
    } catch (err) {
      return { success: false, error: { code: "GITLAB_API_FAILED", message: "获取 GitLab/Codeup PR 失败", details: String(err) } };
    }

    const stateRaw = String(mergeRequest.state ?? "").trim().toLowerCase();
    const prState = stateRaw === "merged" ? "merged" : stateRaw === "closed" ? "closed" : "open";
    const now = new Date();

    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "gitlab",
              scmPrNumber: prNumber,
              scmPrUrl: String(mergeRequest.web_url ?? prUrl ?? "").trim() || null,
              scmPrState: prState as any,
            },
            { now },
          ),
        } as any,
      })
      .catch(() => {});

    if (String(mergeRequest.state).toLowerCase() === "merged") {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return {
      success: true,
      data: { pr: { provider: "gitlab", number: prNumber, url: String(mergeRequest.web_url ?? prUrl ?? "").trim() || null, state: prState } },
    };
  }

  if (scm === "github") {
    const token = project.githubAccessToken;
    if (!token) {
      return { success: false, error: { code: "NO_GITHUB_CONFIG", message: "Project 未配置 GitHub token" } };
    }

    const parsed = parseGitHubRepo(project.repoUrl);
    if (!parsed) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 解析 GitHub owner/repo" } };
    }

    const auth: github.GitHubAuth = {
      apiBaseUrl: parsed.apiBaseUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      accessToken: token,
    };

    let pr: github.GitHubPullRequest;
    try {
      pr = await getPullRequest(auth, { pullNumber: prNumber });
    } catch (err) {
      return { success: false, error: { code: "GITHUB_API_FAILED", message: "获取 GitHub PR 失败", details: String(err) } };
    }

    const merged = Boolean(pr.merged_at);
    const nextState = merged ? "merged" : (typeof pr.state === "string" ? pr.state : "unknown");

    const prUrlNext = String((pr as any)?.html_url ?? prUrl ?? "").trim();
    const headShaNext = String((pr as any)?.head?.sha ?? (run as any)?.scmHeadSha ?? "").trim();
    const prState = String(nextState).toLowerCase() === "merged" ? "merged" : String(nextState).toLowerCase() === "closed" ? "closed" : "open";
    const now = new Date();

    await deps.prisma.run
      .update({
        where: { id: run.id },
        data: {
          ...buildRunScmStateUpdate(
            {
              scmProvider: "github",
              scmPrNumber: prNumber,
              scmPrUrl: prUrlNext || null,
              scmPrState: prState as any,
              scmHeadSha: headShaNext || null,
            },
            { now },
          ),
        } as any,
      })
      .catch(() => {});

    if (merged) {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return {
      success: true,
      data: { pr: { provider: "github", number: prNumber, url: prUrlNext || null, state: prState, merged } },
    };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub/Codeup" } };
}
