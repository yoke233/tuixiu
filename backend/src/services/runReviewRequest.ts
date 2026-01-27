import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import * as gitlab from "../integrations/gitlab.js";
import * as github from "../integrations/github.js";
import type { GitAuthProject } from "../utils/gitAuth.js";
import { postGitHubPrCreatedCommentBestEffort } from "./githubIssueComments.js";

export type GitPush = (opts: { cwd: string; branch: string; project: GitAuthProject }) => Promise<void>;

export type RunReviewDeps = {
  prisma: PrismaDeps;
  gitPush: GitPush;
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
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
  }

  const taskId = (run as any).taskId as string | null;
  const existingPrInRun = run.artifacts.find((a: any) => a.type === "pr");
  if (existingPrInRun) {
    return { success: true, data: { pr: existingPrInRun } };
  }

  if (taskId) {
    const existingPr = await deps.prisma.artifact.findFirst({
      where: { type: "pr", run: { is: { taskId } } } as any,
      orderBy: { createdAt: "desc" },
    });
    if (existingPr) {
      return { success: true, data: { pr: existingPr } };
    }
  }

  const project = run.issue.project;
  const scm = String(project.scmType ?? "").toLowerCase();

  const branchArtifact = run.artifacts.find((a: any) => a.type === "branch");
  const branchFromArtifact = (branchArtifact?.content as any)?.branch;
  const branch = run.branchName || (typeof branchFromArtifact === "string" ? branchFromArtifact : "");
  if (!branch) {
    return { success: false, error: { code: "NO_BRANCH", message: "Run 暂无 branch 信息" } };
  }

  const targetBranch = body.targetBranch ?? project.defaultBranch ?? "main";
  const title = body.title ?? run.issue.title ?? `Run ${run.id}`;
  const description = body.description ?? run.issue.description ?? "";

  try {
    await deps.gitPush({ cwd: run.workspacePath ?? process.cwd(), branch, project });
  } catch (err) {
    return { success: false, error: { code: "GIT_PUSH_FAILED", message: "git push 失败", details: String(err) } };
  }

  if (scm === "gitlab") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab projectId/token" }
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab baseUrl" } };
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
        error: { code: "GITLAB_PR_FAILED", message: "创建 GitLab PR 失败", details: String(err) }
      };
    }

    const created = await deps.prisma.artifact.create({
      data: {
        id: uuidv7(),
        runId: run.id,
        type: "pr",
        content: {
          provider: "gitlab",
          baseUrl,
          projectId: project.gitlabProjectId,
          iid: mergeRequest.iid,
          id: mergeRequest.id,
          webUrl: mergeRequest.web_url,
          state: mergeRequest.state,
          title: mergeRequest.title,
          sourceBranch: mergeRequest.source_branch,
          targetBranch: mergeRequest.target_branch
        } as any
      }
    });

    if (opts?.setRunWaitingCi !== false) {
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "waiting_ci" } }).catch(() => {});
    }

    const issueIsGitHub = String((run as any)?.issue?.externalProvider ?? "").toLowerCase() === "github";
    const issueNumber = Number((run as any)?.issue?.externalNumber ?? 0);
    const repoUrlForIssue = String((run as any)?.issue?.externalUrl ?? project.repoUrl ?? "").trim();
    const githubTokenForComment = String(project.githubAccessToken ?? "").trim();
    if (issueIsGitHub && githubTokenForComment) {
      await postGitHubPrCreatedCommentBestEffort({
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
    return { success: true, data: { pr: created } };
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

    const created = await deps.prisma.artifact.create({
      data: {
        id: uuidv7(),
        runId: run.id,
        type: "pr",
        content: {
          provider: "github",
          apiBaseUrl: parsed.apiBaseUrl,
          owner: parsed.owner,
          repo: parsed.repo,
          number: pr.number,
          id: pr.id,
          webUrl: pr.html_url,
          state: pr.state,
          title: pr.title,
          sourceBranch: pr.head.ref,
          targetBranch: pr.base.ref
        } as any
      }
    });

    if (opts?.setRunWaitingCi !== false) {
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "waiting_ci" } }).catch(() => {});
    }

    const issueIsGitHub = String((run as any)?.issue?.externalProvider ?? "").toLowerCase() === "github";
    const issueNumber = Number((run as any)?.issue?.externalNumber ?? 0);
    const repoUrlForIssue = String((run as any)?.issue?.externalUrl ?? project.repoUrl ?? "").trim();
    if (issueIsGitHub && token) {
      await postGitHubPrCreatedCommentBestEffort({
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
    return { success: true, data: { pr: created } };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub" } };
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

  const taskId = (run as any).taskId as string | null;
  let prArtifact = run.artifacts.find((a: any) => a.type === "pr") as any;
  if (!prArtifact && taskId) {
    prArtifact = await deps.prisma.artifact.findFirst({
      where: { type: "pr", run: { is: { taskId } } } as any,
      orderBy: { createdAt: "desc" },
    });
  }
  if (!prArtifact) {
    return { success: false, error: { code: "NO_PR", message: "Run 暂无 PR 产物" } };
  }

  const content = (prArtifact.content ?? {}) as any;
  if (scm === "gitlab") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab projectId/token" }
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab baseUrl" } };
    }

    const iid = Number(content.iid);
    if (!Number.isFinite(iid) || iid <= 0) {
      return { success: false, error: { code: "BAD_PR", message: "PR 产物缺少 iid" } };
    }

    const auth: gitlab.GitLabAuth = {
      baseUrl,
      projectId: project.gitlabProjectId,
      accessToken: project.gitlabAccessToken
    };

    let mergeRequest: gitlab.GitLabMergeRequest;
    try {
      mergeRequest = await mergeMergeRequest(auth, {
        iid,
        squash: body.squash,
        mergeCommitMessage: body.mergeCommitMessage
      });
    } catch (err) {
      return { success: false, error: { code: "GITLAB_MERGE_FAILED", message: "合并 PR 失败", details: String(err) } };
    }

    // best-effort: refresh state after merge (some GitLab instances are eventually consistent)
    try {
      mergeRequest = await getMergeRequest(auth, { iid });
    } catch {
      // ignore
    }

    const updated = await deps.prisma.artifact.update({
      where: { id: prArtifact.id },
      data: {
        content: {
          ...content,
          state: mergeRequest.state,
          merge_status: mergeRequest.merge_status,
          detailed_merge_status: mergeRequest.detailed_merge_status
        } as any
      }
    });

    if (String(mergeRequest.state).toLowerCase() === "merged") {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return { success: true, data: { pr: updated } };
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

    const number = Number(content.number);
    if (!Number.isFinite(number) || number <= 0) {
      return { success: false, error: { code: "BAD_PR", message: "PR 产物缺少 number" } };
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
        pullNumber: number,
        mergeMethod: body.squash ? "squash" : "merge",
        commitMessage: body.mergeCommitMessage
      });
      merged = Boolean(res.merged);
    } catch (err) {
      return { success: false, error: { code: "GITHUB_MERGE_FAILED", message: "合并 PR 失败", details: String(err) } };
    }

    let pr: github.GitHubPullRequest | null = null;
    try {
      pr = await getPullRequest(auth, { pullNumber: number });
    } catch {
      // ignore
    }

    const nextState =
      merged || (pr?.merged_at ? true : false) ? "merged" : (typeof pr?.state === "string" ? pr.state : "unknown");

    const updated = await deps.prisma.artifact.update({
      where: { id: prArtifact.id },
      data: {
        content: {
          ...content,
          state: nextState,
          merged,
          merge_commit_message: body.mergeCommitMessage
        } as any
      }
    });

    if (merged) {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return { success: true, data: { pr: updated } };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub" } };
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

  const taskId = (run as any).taskId as string | null;
  let prArtifact = run.artifacts.find((a: any) => a.type === "pr") as any;
  if (!prArtifact && taskId) {
    prArtifact = await deps.prisma.artifact.findFirst({
      where: { type: "pr", run: { is: { taskId } } } as any,
      orderBy: { createdAt: "desc" },
    });
  }
  if (!prArtifact) {
    return { success: false, error: { code: "NO_PR", message: "Run 暂无 PR 产物" } };
  }

  const content = (prArtifact.content ?? {}) as any;
  if (scm === "gitlab") {
    if (!project.gitlabProjectId || !project.gitlabAccessToken) {
      return {
        success: false,
        error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab projectId/token" },
      };
    }

    const baseUrl = inferGitlabBaseUrl(project.repoUrl);
    if (!baseUrl) {
      return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab baseUrl" } };
    }

    const iid = Number(content.iid);
    if (!Number.isFinite(iid) || iid <= 0) {
      return { success: false, error: { code: "BAD_PR", message: "PR 产物缺少 iid" } };
    }

    const auth: gitlab.GitLabAuth = {
      baseUrl,
      projectId: project.gitlabProjectId,
      accessToken: project.gitlabAccessToken,
    };

    let mergeRequest: gitlab.GitLabMergeRequest;
    try {
      mergeRequest = await getMergeRequest(auth, { iid });
    } catch (err) {
      return { success: false, error: { code: "GITLAB_API_FAILED", message: "获取 GitLab PR 失败", details: String(err) } };
    }

    const updated = await deps.prisma.artifact.update({
      where: { id: prArtifact.id },
      data: {
        content: {
          ...content,
          state: mergeRequest.state,
          merge_status: mergeRequest.merge_status,
          detailed_merge_status: mergeRequest.detailed_merge_status,
        } as any,
      },
    });

    if (String(mergeRequest.state).toLowerCase() === "merged") {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return { success: true, data: { pr: updated } };
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

    const number = Number(content.number);
    if (!Number.isFinite(number) || number <= 0) {
      return { success: false, error: { code: "BAD_PR", message: "PR 产物缺少 number" } };
    }

    const auth: github.GitHubAuth = {
      apiBaseUrl: parsed.apiBaseUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      accessToken: token,
    };

    let pr: github.GitHubPullRequest;
    try {
      pr = await getPullRequest(auth, { pullNumber: number });
    } catch (err) {
      return { success: false, error: { code: "GITHUB_API_FAILED", message: "获取 GitHub PR 失败", details: String(err) } };
    }

    const merged = Boolean(pr.merged_at);
    const nextState = merged ? "merged" : (typeof pr.state === "string" ? pr.state : "unknown");

    const updated = await deps.prisma.artifact.update({
      where: { id: prArtifact.id },
      data: {
        content: {
          ...content,
          webUrl: pr.html_url,
          state: nextState,
          title: pr.title,
          sourceBranch: pr.head?.ref,
          targetBranch: pr.base?.ref,
          merged,
          merged_at: pr.merged_at ?? null,
          mergeable: pr.mergeable ?? null,
          mergeable_state: pr.mergeable_state ?? null,
        } as any,
      },
    });

    if (merged) {
      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
    }

    return { success: true, data: { pr: updated } };
  }

  return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab/GitHub" } };
}
