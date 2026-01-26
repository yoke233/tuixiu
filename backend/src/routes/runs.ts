import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import * as gitlab from "../integrations/gitlab.js";

const execFileAsync = promisify(execFile);

type RunChangeFile = {
  path: string;
  status: string;
  oldPath?: string;
};

function parseNameStatus(output: string): RunChangeFile[] {
  const lines = output.split(/\r?\n/g).map((l) => l.trim()).filter(Boolean);
  const files: RunChangeFile[] = [];
  for (const line of lines) {
    const parts = line.split("\t").filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0];
    if (status.startsWith("R") && parts.length >= 3) {
      files.push({ status, oldPath: parts[1], path: parts[2] });
      continue;
    }
    files.push({ status, path: parts[1] });
  }
  return files;
}

function trimTail(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function buildContextFromRun(opts: {
  run: any;
  issue: any;
  events: Array<{ source?: string; type?: string; payload?: any; timestamp?: any }>;
}): string {
  const issue = opts.issue ?? {};
  const run = opts.run ?? {};

  const parts: string[] = [];
  if (issue.title) parts.push(`任务标题: ${issue.title}`);
  if (issue.description) parts.push(`任务描述:\n${issue.description}`);

  const acceptance = Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria : [];
  if (acceptance.length) {
    parts.push(`验收标准:\n${acceptance.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  const constraints = Array.isArray(issue.constraints) ? issue.constraints : [];
  if (constraints.length) {
    parts.push(`约束条件:\n${constraints.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  if (issue.testRequirements) parts.push(`测试要求:\n${issue.testRequirements}`);

  const branch = run.branchName || (run.artifacts ?? []).find((a: any) => a.type === "branch")?.content?.branch;
  if (typeof branch === "string" && branch) parts.push(`当前分支: ${branch}`);

  // 对话节选：仅保留用户消息 + agent_message_chunk + 系统文本（避免把巨大工具输出塞进 prompt）。
  const events = [...(opts.events ?? [])];
  events.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));

  const lines: string[] = [];
  let agentBuf = "";
  const flushAgent = () => {
    const text = agentBuf.trim();
    if (!text) {
      agentBuf = "";
      return;
    }
    lines.push(`Agent: ${text}`);
    agentBuf = "";
  };

  for (const e of events) {
    const source = String(e.source ?? "");
    const payload = e.payload as any;

    if (source === "user") {
      flushAgent();
      const t = payload?.text;
      if (typeof t === "string" && t.trim()) lines.push(`User: ${t.trim()}`);
      continue;
    }

    if (source === "acp" && payload?.type === "session_update") {
      const upd = payload.update as any;
      if (upd?.sessionUpdate === "agent_message_chunk" && upd?.content?.type === "text") {
        const t = upd.content.text;
        if (typeof t === "string" && t) {
          agentBuf += t;
          if (agentBuf.length > 1200 || t.includes("\n\n")) flushAgent();
        }
        continue;
      }

      // 其它 session_update 作为边界：先 flush，避免顺序混乱
      flushAgent();
      continue;
    }

    if (source === "acp" && payload?.type === "text") {
      flushAgent();
      const t = payload.text;
      if (typeof t === "string" && t.trim()) lines.push(`System: ${t.trim()}`);
      continue;
    }

    if (source === "acp" && payload?.type === "prompt_result") {
      flushAgent();
      continue;
    }
  }
  flushAgent();

  if (lines.length) {
    parts.push(`最近对话节选:\n${lines.slice(-40).join("\n")}`);
  }

  return trimTail(parts.join("\n\n"), 9000);
}

export function makeRunRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  gitPush?: (opts: { cwd: string; branch: string }) => Promise<void>;
  gitlab?: {
    inferBaseUrl?: typeof gitlab.inferGitlabBaseUrl;
    createMergeRequest?: typeof gitlab.createMergeRequest;
    mergeMergeRequest?: typeof gitlab.mergeMergeRequest;
    getMergeRequest?: typeof gitlab.getMergeRequest;
  };
}): FastifyPluginAsync {
  return async (server) => {
    const gitPush =
      deps.gitPush ??
      (async (opts: { cwd: string; branch: string }) => {
        await execFileAsync("git", ["push", "-u", "origin", opts.branch], { cwd: opts.cwd });
      });

    const inferGitlabBaseUrl = deps.gitlab?.inferBaseUrl ?? gitlab.inferGitlabBaseUrl;
    const createMergeRequest = deps.gitlab?.createMergeRequest ?? gitlab.createMergeRequest;
    const mergeMergeRequest = deps.gitlab?.mergeMergeRequest ?? gitlab.mergeMergeRequest;
    const getMergeRequest = deps.gitlab?.getMergeRequest ?? gitlab.getMergeRequest;

    server.get("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { issue: true, agent: true, artifacts: true }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }
      return { success: true, data: { run } };
    });

    server.get("/:id/events", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const querySchema = z.object({
        limit: z.coerce.number().int().positive().max(500).default(200)
      });
      const { id } = paramsSchema.parse(request.params);
      const { limit } = querySchema.parse(request.query);

      const events = await deps.prisma.event.findMany({
        where: { runId: id },
        orderBy: { timestamp: "desc" },
        take: limit
      });
      return { success: true, data: { events } };
    });

    server.get("/:id/changes", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } }
        }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      const baseBranch = run.issue.project.defaultBranch || "main";
      const branchArtifact = run.artifacts.find((a: any) => a.type === "branch");
      const branchFromArtifact = (branchArtifact?.content as any)?.branch;
      const branch = run.branchName || (typeof branchFromArtifact === "string" ? branchFromArtifact : "");

      if (!branch) {
        return { success: false, error: { code: "NO_BRANCH", message: "Run 暂无 branch 信息" } };
      }

      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--name-status", `${baseBranch}...${branch}`],
          { cwd: process.cwd() }
        );
        const files = parseNameStatus(stdout);
        return { success: true, data: { baseBranch, branch, files } };
      } catch (err) {
        return {
          success: false,
          error: { code: "GIT_DIFF_FAILED", message: "获取变更失败", details: String(err) }
        };
      }
    });

    server.get("/:id/diff", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const querySchema = z.object({ path: z.string().min(1) });
      const { id } = paramsSchema.parse(request.params);
      const { path } = querySchema.parse(request.query);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } }
        }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      const baseBranch = run.issue.project.defaultBranch || "main";
      const branchArtifact = run.artifacts.find((a: any) => a.type === "branch");
      const branchFromArtifact = (branchArtifact?.content as any)?.branch;
      const branch = run.branchName || (typeof branchFromArtifact === "string" ? branchFromArtifact : "");

      if (!branch) {
        return { success: false, error: { code: "NO_BRANCH", message: "Run 暂无 branch 信息" } };
      }

      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", `${baseBranch}...${branch}`, "--", path],
          { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
        );
        return { success: true, data: { baseBranch, branch, path, diff: stdout } };
      } catch (err) {
        return {
          success: false,
          error: { code: "GIT_DIFF_FAILED", message: "获取 diff 失败", details: String(err) }
        };
      }
    });

    server.post("/:id/create-mr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        targetBranch: z.string().min(1).optional()
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } }
        }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      const existingMr = run.artifacts.find((a: any) => a.type === "mr");
      if (existingMr) {
        return { success: true, data: { mr: existingMr } };
      }

      const project = run.issue.project;
      if (String(project.scmType ?? "").toLowerCase() !== "gitlab") {
        return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab" } };
      }
      if (!project.gitlabProjectId || !project.gitlabAccessToken) {
        return { success: false, error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab projectId/token" } };
      }

      const baseUrl = inferGitlabBaseUrl(project.repoUrl);
      if (!baseUrl) {
        return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab baseUrl" } };
      }

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
        await gitPush({ cwd: run.workspacePath ?? process.cwd(), branch });
      } catch (err) {
        return { success: false, error: { code: "GIT_PUSH_FAILED", message: "git push 失败", details: String(err) } };
      }

      const auth: gitlab.GitLabAuth = {
        baseUrl,
        projectId: project.gitlabProjectId,
        accessToken: project.gitlabAccessToken
      };

      let mr: gitlab.GitLabMergeRequest;
      try {
        mr = await createMergeRequest(auth, { sourceBranch: branch, targetBranch, title, description });
      } catch (err) {
        return {
          success: false,
          error: { code: "GITLAB_MR_FAILED", message: "创建 GitLab MR 失败", details: String(err) }
        };
      }

      const created = await deps.prisma.artifact.create({
        data: {
          id: uuidv7(),
          runId: run.id,
          type: "mr",
          content: {
            provider: "gitlab",
            baseUrl,
            projectId: project.gitlabProjectId,
            iid: mr.iid,
            id: mr.id,
            webUrl: mr.web_url,
            state: mr.state,
            title: mr.title,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch
          } as any
        }
      });

      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "waiting_ci" } }).catch(() => {});

      return { success: true, data: { mr: created } };
    });

    server.post("/:id/merge-mr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        squash: z.boolean().optional(),
        mergeCommitMessage: z.string().min(1).optional()
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } }
        }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      const project = run.issue.project;
      if (String(project.scmType ?? "").toLowerCase() !== "gitlab") {
        return { success: false, error: { code: "UNSUPPORTED_SCM", message: "当前仅支持 GitLab" } };
      }
      if (!project.gitlabProjectId || !project.gitlabAccessToken) {
        return { success: false, error: { code: "NO_GITLAB_CONFIG", message: "Project 未配置 GitLab projectId/token" } };
      }

      const baseUrl = inferGitlabBaseUrl(project.repoUrl);
      if (!baseUrl) {
        return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 推导 GitLab baseUrl" } };
      }

      const mrArtifact = run.artifacts.find((a: any) => a.type === "mr") as any;
      if (!mrArtifact) {
        return { success: false, error: { code: "NO_MR", message: "Run 暂无 MR 产物" } };
      }

      const content = (mrArtifact.content ?? {}) as any;
      const iid = Number(content.iid);
      if (!Number.isFinite(iid) || iid <= 0) {
        return { success: false, error: { code: "BAD_MR", message: "MR 产物缺少 iid" } };
      }

      const auth: gitlab.GitLabAuth = {
        baseUrl,
        projectId: project.gitlabProjectId,
        accessToken: project.gitlabAccessToken
      };

      let mr: gitlab.GitLabMergeRequest;
      try {
        mr = await mergeMergeRequest(auth, { iid, squash: body.squash, mergeCommitMessage: body.mergeCommitMessage });
      } catch (err) {
        return { success: false, error: { code: "GITLAB_MERGE_FAILED", message: "合并 MR 失败", details: String(err) } };
      }

      // best-effort: refresh MR state after merge (some GitLab instances are eventually consistent)
      try {
        mr = await getMergeRequest(auth, { iid });
      } catch {
        // ignore
      }

      const updated = await deps.prisma.artifact.update({
        where: { id: mrArtifact.id },
        data: {
          content: {
            ...content,
            state: mr.state,
            merge_status: mr.merge_status,
            detailed_merge_status: mr.detailed_merge_status
          } as any
        }
      });

      if (String(mr.state).toLowerCase() === "merged") {
        await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "done" } }).catch(() => {});
        await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }).catch(() => {});
      }

      return { success: true, data: { mr: updated } };
    });

    server.post("/:id/prompt", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ text: z.string().min(1) });
      const { id } = paramsSchema.parse(request.params);
      const { text } = bodySchema.parse(request.body);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { agent: true, issue: true, artifacts: { orderBy: { createdAt: "desc" } } }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      await deps.prisma.event.create({
        data: {
          id: uuidv7(),
          runId: id,
          source: "user",
          type: "user.message",
          payload: { text } as any
        }
      });

      if (!deps.sendToAgent) {
        return {
          success: false,
          error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" }
        };
      }

      try {
        const recentEvents = await deps.prisma.event.findMany({
          where: { runId: id },
          orderBy: { timestamp: "desc" },
          take: 200
        });
        const context = buildContextFromRun({ run, issue: run.issue, events: recentEvents });

        await deps.sendToAgent(run.agent.proxyId, {
          type: "prompt_run",
          run_id: id,
          prompt: text,
          session_id: run.acpSessionId ?? undefined,
          context,
          cwd: run.workspacePath ?? undefined
        });
      } catch (error) {
        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送消息到 Agent 失败",
            details: String(error)
          }
        };
      }

      return { success: true, data: { ok: true } };
    });

    server.post("/:id/cancel", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.update({
        where: { id },
        data: { status: "cancelled", completedAt: new Date() }
      });

      await deps.prisma.issue
        .update({ where: { id: run.issueId }, data: { status: "cancelled" } })
        .catch(() => {});
      await deps.prisma.agent
        .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
        .catch(() => {});

      return { success: true, data: { run } };
    });

    server.post("/:id/complete", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.update({
        where: { id },
        data: { status: "completed", completedAt: new Date() }
      });

      await deps.prisma.issue.update({ where: { id: run.issueId }, data: { status: "reviewing" } }).catch(() => {});
      await deps.prisma.agent
        .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
        .catch(() => {});

      return { success: true, data: { run } };
    });
  };
}
