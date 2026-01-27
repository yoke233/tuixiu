import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import * as github from "../integrations/github.js";

function parseIssueNumberFromUrl(url: string): number | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    const issuesIdx = parts.findIndex((p) => p.toLowerCase() === "issues");
    if (issuesIdx === -1) return null;
    const next = parts[issuesIdx + 1] ?? "";
    const n = Number(next);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  } catch {
    return null;
  }
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (!label || typeof label !== "object") return null;
      const name = (label as any).name;
      return typeof name === "string" ? name.trim() : null;
    })
    .filter((x): x is string => Boolean(x));
}

export function makeGitHubIssueRoutes(deps: {
  prisma: PrismaDeps;
  parseRepo?: typeof github.parseGitHubRepo;
  listIssues?: typeof github.listIssues;
  getIssue?: typeof github.getIssue;
  onIssueUpserted?: (issueId: string, reason: string) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const parseRepo = deps.parseRepo ?? github.parseGitHubRepo;
    const listIssues = deps.listIssues ?? github.listIssues;
    const getIssue = deps.getIssue ?? github.getIssue;

    server.get("/:projectId/github/issues", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const querySchema = z.object({
        state: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.coerce.number().int().positive().max(100).default(50),
        page: z.coerce.number().int().positive().default(1),
      });
      const { projectId } = paramsSchema.parse(request.params);
      const { state, limit, page } = querySchema.parse(request.query);

      const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }
      if (!project.githubAccessToken) {
        return { success: false, error: { code: "NO_GITHUB_CONFIG", message: "Project 未配置 GitHub token" } };
      }

      const parsed = parseRepo(project.repoUrl);
      if (!parsed) {
        return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 解析 GitHub owner/repo" } };
      }

      const auth: github.GitHubAuth = {
        apiBaseUrl: parsed.apiBaseUrl,
        owner: parsed.owner,
        repo: parsed.repo,
        accessToken: project.githubAccessToken,
      };

      try {
        const items = await listIssues(auth, { state, page, perPage: limit });
        const issues = items.map((i) => ({
          id: String(i.id),
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
          labels: i.labels ?? [],
          updatedAt: i.updated_at ?? null,
        }));
        return { success: true, data: { issues, page, limit } };
      } catch (err) {
        return {
          success: false,
          error: { code: "GITHUB_API_FAILED", message: "获取 GitHub Issues 失败", details: String(err) },
        };
      }
    });

    server.post("/:projectId/github/issues/import", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const bodySchema = z
        .object({
          number: z.coerce.number().int().positive().optional(),
          url: z.string().min(1).optional(),
        })
        .refine((v) => Boolean(v.number || v.url), { message: "number/url 至少提供一个" });

      const { projectId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }
      if (!project.githubAccessToken) {
        return { success: false, error: { code: "NO_GITHUB_CONFIG", message: "Project 未配置 GitHub token" } };
      }

      const parsed = parseRepo(project.repoUrl);
      if (!parsed) {
        return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 repoUrl 解析 GitHub owner/repo" } };
      }

      const issueNumber = body.number ?? (body.url ? parseIssueNumberFromUrl(body.url) : null);
      if (!issueNumber) {
        return { success: false, error: { code: "BAD_ISSUE", message: "无法解析 Issue number" } };
      }

      const auth: github.GitHubAuth = {
        apiBaseUrl: parsed.apiBaseUrl,
        owner: parsed.owner,
        repo: parsed.repo,
        accessToken: project.githubAccessToken,
      };

      let external: github.GitHubIssue;
      try {
        external = await getIssue(auth, { issueNumber });
      } catch (err) {
        return {
          success: false,
          error: { code: "GITHUB_API_FAILED", message: "获取 GitHub Issue 失败", details: String(err) },
        };
      }

      const externalId = String(external.id);
      const existing = await deps.prisma.issue.findFirst({
        where: { projectId, externalProvider: "github", externalId },
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
      });
      if (existing) {
        deps.onIssueUpserted?.((existing as any).id, "github_import");
        return { success: true, data: { issue: existing, imported: false } };
      }

      const created = await deps.prisma.issue.create({
        data: {
          id: uuidv7(),
          projectId,
          title: external.title,
          description: external.body ?? null,
          status: "pending",
          externalProvider: "github",
          externalId,
          externalNumber: external.number,
          externalUrl: external.html_url,
          externalState: String(external.state ?? ""),
          externalLabels: normalizeGitHubLabels(external.labels),
          lastSyncedAt: new Date(),
          createdBy: "github_import",
        },
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
      });

      deps.onIssueUpserted?.((created as any).id, "github_import");
      return { success: true, data: { issue: created, imported: true } };
    });
  };
}

