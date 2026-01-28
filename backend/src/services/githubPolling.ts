import type { PrismaDeps } from "../deps.js";
import * as github from "../integrations/github.js";
import { uuidv7 } from "../utils/uuid.js";
import { TaskEngineError, createTaskFromTemplate } from "./taskEngine.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_OVERLAP_SECONDS = 120;

const DEFAULT_ISSUE_TASK_TEMPLATE_KEY = "quick.dev.full";
const DEFAULT_PR_TASK_TEMPLATE_KEY = "quick.pr.review";

function enqueueByKey(queue: Map<string, Promise<void>>, key: string, task: () => Promise<void>): Promise<void> {
  const prev = queue.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (queue.get(key) === next) queue.delete(key);
    });
  queue.set(key, next);
  return next;
}

function truthyString(value: string | undefined): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const items = labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (!label || typeof label !== "object") return null;
      const name = (label as any).name;
      return typeof name === "string" ? name.trim() : null;
    })
    .filter((x): x is string => Boolean(x));

  // 稳定比较：去重 + 排序
  const uniq = new Set<string>();
  for (const x of items) {
    const v = x.trim();
    if (v) uniq.add(v);
  }
  return Array.from(uniq).sort((a, b) => a.localeCompare(b));
}

function normalizeStringArrayJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const uniq = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) uniq.add(t);
  }
  return Array.from(uniq).sort((a, b) => a.localeCompare(b));
}

function normalizeCursorWithOverlap(cursor: Date | null, overlapSeconds: number): string | null {
  if (!cursor) return null;
  const overlapMs = Math.max(0, Math.floor(overlapSeconds)) * 1000;
  const ms = cursor.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(Math.max(0, ms - overlapMs)).toISOString();
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function upsertGitHubIssue(deps: { prisma: PrismaDeps; log: Logger }, opts: {
  projectId: string;
  external: github.GitHubIssue;
  now: Date;
}): Promise<{ issueId: string; created: boolean; updated: boolean }> {
  const externalId = String(opts.external.id);
  const existing = await deps.prisma.issue.findFirst({
    where: { projectId: opts.projectId, externalProvider: "github", externalId },
  });

  const externalState = String(opts.external.state ?? "");
  const externalLabels = normalizeGitHubLabels(opts.external.labels);

  if (!existing) {
    const created = await deps.prisma.issue.create({
      data: {
        id: uuidv7(),
        projectId: opts.projectId,
        title: opts.external.title,
        description: opts.external.body ?? null,
        status: "pending",
        externalProvider: "github",
        externalId,
        externalNumber: opts.external.number,
        externalUrl: opts.external.html_url,
        externalState,
        externalLabels,
        lastSyncedAt: opts.now,
        createdBy: "github_poll",
      } as any,
      select: { id: true },
    });
    return { issueId: (created as any).id, created: true, updated: true };
  }

  const prevLabels = normalizeStringArrayJson((existing as any).externalLabels);
  const nextLabels = externalLabels;
  const labelsChanged = JSON.stringify(prevLabels) !== JSON.stringify(nextLabels);

  const prevTitle = String((existing as any).title ?? "");
  const prevDesc = (existing as any).description ?? null;
  const prevState = String((existing as any).externalState ?? "");
  const prevUrl = String((existing as any).externalUrl ?? "");
  const prevNumber = Number((existing as any).externalNumber ?? 0);

  const titleChanged = prevTitle !== opts.external.title;
  const descChanged = prevDesc !== (opts.external.body ?? null);
  const stateChanged = prevState !== externalState;
  const urlChanged = prevUrl !== opts.external.html_url;
  const numberChanged = prevNumber !== opts.external.number;

  const shouldResetStatus =
    String((existing as any).status ?? "") !== "pending" &&
    ["done", "failed", "cancelled"].includes(String((existing as any).status ?? "")) &&
    externalState.toLowerCase() === "open";

  const updated =
    titleChanged ||
    descChanged ||
    stateChanged ||
    urlChanged ||
    numberChanged ||
    labelsChanged ||
    shouldResetStatus;

  if (!updated) {
    return { issueId: (existing as any).id, created: false, updated: false };
  }

  const nextStatus = shouldResetStatus ? "pending" : undefined;
  const res = await deps.prisma.issue.update({
    where: { id: (existing as any).id },
    data: {
      title: opts.external.title,
      description: opts.external.body ?? null,
      ...(nextStatus ? { status: nextStatus } : null),
      externalNumber: opts.external.number,
      externalUrl: opts.external.html_url,
      externalState,
      externalLabels,
      lastSyncedAt: opts.now,
    } as any,
    select: { id: true },
  });
  return { issueId: (res as any).id, created: false, updated: true };
}

async function upsertGitHubPullRequestAsIssue(
  deps: { prisma: PrismaDeps; log: Logger },
  opts: { projectId: string; external: github.GitHubPullRequest; now: Date },
): Promise<{ issueId: string; created: boolean; updated: boolean }> {
  const externalId = String(opts.external.id);
  const existing = await deps.prisma.issue.findFirst({
    where: { projectId: opts.projectId, externalProvider: "github", externalId },
  });

  const merged = Boolean((opts.external as any).merged_at);
  const prState = merged ? "merged" : String(opts.external.state ?? "");
  const title = `[PR #${opts.external.number}] ${opts.external.title}`;
  const body = typeof opts.external.body === "string" ? opts.external.body : "";
  const headRef = String((opts.external as any).head?.ref ?? "").trim();
  const headSha = String((opts.external as any).head?.sha ?? "").trim();
  const baseRef = String((opts.external as any).base?.ref ?? "").trim();
  const descParts = [
    `GitHub Pull Request：#${opts.external.number}`,
    opts.external.html_url ? `URL: ${opts.external.html_url}` : "",
    baseRef ? `Base: ${baseRef}` : "",
    headRef ? `Head: ${headRef}${headSha ? ` (${headSha.slice(0, 12)})` : ""}` : "",
    "",
    body.trim(),
  ].filter(Boolean);
  const description = descParts.join("\n");

  const labels = ["_github_pr"];
  const externalLabels = labels;

  if (!existing) {
    const created = await deps.prisma.issue.create({
      data: {
        id: uuidv7(),
        projectId: opts.projectId,
        title,
        description: description || null,
        status: "pending",
        labels,
        externalProvider: "github",
        externalId,
        externalNumber: opts.external.number,
        externalUrl: opts.external.html_url,
        externalState: prState,
        externalLabels,
        lastSyncedAt: opts.now,
        createdBy: "github_poll_pr",
      } as any,
      select: { id: true },
    });
    return { issueId: (created as any).id, created: true, updated: true };
  }

  const prevTitle = String((existing as any).title ?? "");
  const prevDesc = (existing as any).description ?? null;
  const prevState = String((existing as any).externalState ?? "");
  const prevUrl = String((existing as any).externalUrl ?? "");
  const prevNumber = Number((existing as any).externalNumber ?? 0);
  const prevLabels = normalizeStringArrayJson((existing as any).labels);

  const updated =
    prevTitle !== title ||
    prevDesc !== (description || null) ||
    prevState !== prState ||
    prevUrl !== opts.external.html_url ||
    prevNumber !== opts.external.number ||
    JSON.stringify(prevLabels) !== JSON.stringify(labels);

  if (!updated) {
    return { issueId: (existing as any).id, created: false, updated: false };
  }

  const res = await deps.prisma.issue.update({
    where: { id: (existing as any).id },
    data: {
      title,
      description: description || null,
      labels,
      externalNumber: opts.external.number,
      externalUrl: opts.external.html_url,
      externalState: prState,
      externalLabels,
      lastSyncedAt: opts.now,
    } as any,
    select: { id: true },
  });
  return { issueId: (res as any).id, created: false, updated: true };
}

async function findGitHubRunByPrNumber(
  prisma: PrismaDeps,
  opts: { projectId: string; prNumber: number },
): Promise<{ id: string } | null> {
  const prNumber = Number(opts.prNumber ?? 0);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;

  const find = (prisma as any)?.run?.findFirst;
  if (typeof find !== "function") return null;

  return await (prisma as any).run
    .findFirst({
      where: {
        scmProvider: "github",
        scmPrNumber: prNumber,
        issue: { is: { projectId: opts.projectId } } as any,
      } as any,
      orderBy: { startedAt: "desc" } as any,
      select: { id: true } as any,
    })
    .catch(() => null);
}

async function updateGitHubRunScmFromPoll(
  prisma: PrismaDeps,
  opts: { runId: string; pr: github.GitHubPullRequest; now: Date },
): Promise<void> {
  const update = (prisma as any)?.run?.update;
  if (typeof update !== "function") return;

  const prNumber = Number((opts.pr as any).number ?? 0);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return;

  const prUrl = String((opts.pr as any).html_url ?? "").trim();
  const merged = Boolean((opts.pr as any).merged_at);
  const stateRaw = String((opts.pr as any).state ?? "").trim().toLowerCase();
  const prState = merged ? "merged" : stateRaw === "closed" ? "closed" : "open";
  const headSha = String((opts.pr as any).head?.sha ?? "").trim();

  await update({
    where: { id: String(opts.runId) } as any,
    data: {
      scmProvider: "github",
      scmPrNumber: prNumber,
      scmPrUrl: prUrl || null,
      scmPrState: prState as any,
      scmHeadSha: headSha || null,
      scmUpdatedAt: opts.now,
    } as any,
  }).catch(() => {});
}

async function createDefaultTaskForIssue(deps: { prisma: PrismaDeps; log: Logger }, opts: {
  issueId: string;
  templateKey: string;
  kind: "issue" | "pr";
  postCreate?: (task: any) => Promise<void>;
}): Promise<void> {
  try {
    const existing = await deps.prisma.task.findFirst({
      where: { issueId: opts.issueId } as any,
      select: { id: true },
    });
    if (existing) return;

    const task = await createTaskFromTemplate({ prisma: deps.prisma }, opts.issueId, { templateKey: opts.templateKey });
    await deps.prisma.task
      .update({
        where: { id: (task as any).id },
        data: { metadata: { source: "github_poll", kind: opts.kind } as any } as any,
      })
      .catch(() => {});

    if (opts.postCreate) await opts.postCreate(task);
  } catch (err) {
    if (err instanceof TaskEngineError) {
      deps.log("github poll create task failed", { issueId: opts.issueId, code: err.code, details: err.details });
      return;
    }
    deps.log("github poll create task failed", { issueId: opts.issueId, err: String(err) });
  }
}

export async function syncGitHubProjectOnce(
  deps: {
    prisma: PrismaDeps;
    log: Logger;
    github?: {
      parseRepo?: typeof github.parseGitHubRepo;
      listIssues?: typeof github.listIssues;
      listPullRequests?: typeof github.listPullRequests;
    };
  },
  project: any,
  opts: { overlapSeconds: number },
): Promise<void> {
  const scm = String(project?.scmType ?? "").trim().toLowerCase();
  if (scm !== "github") return;

  const enabled = Boolean(project?.githubPollingEnabled);
  if (!enabled) return;

  const token = String(project?.githubAccessToken ?? "").trim();
  if (!token) return;

  const parseRepo = deps.github?.parseRepo ?? github.parseGitHubRepo;
  const listIssues = deps.github?.listIssues ?? github.listIssues;
  const listPullRequests = deps.github?.listPullRequests ?? github.listPullRequests;

  const parsed = parseRepo(String(project?.repoUrl ?? ""));
  if (!parsed) return;

  const auth: github.GitHubAuth = {
    apiBaseUrl: parsed.apiBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: token,
  };

  const now = new Date();
  const cursor = project?.githubPollingCursor instanceof Date ? (project.githubPollingCursor as Date) : parseIsoDate(project?.githubPollingCursor);
  const since = normalizeCursorWithOverlap(cursor, opts.overlapSeconds);

  // issues
  {
    const perPage = 100;
    let page = 1;
    while (true) {
      const items = await listIssues(auth, { state: "all", perPage, page, ...(since ? { since } : null), includePullRequests: true });
      if (!items.length) break;

      for (const external of items) {
        if ((external as any)?.pull_request) continue;
        const res = await upsertGitHubIssue(deps, { projectId: project.id, external, now });
        if (res.created) {
          await createDefaultTaskForIssue(deps, { issueId: res.issueId, templateKey: DEFAULT_ISSUE_TASK_TEMPLATE_KEY, kind: "issue" });
        }
      }

      if (items.length < perPage) break;
      page += 1;
      if (page > 50) break;
    }
  }

  // pull requests
  {
    const perPage = 100;
    let page = 1;
    const sinceDate = since ? new Date(since) : null;
    while (true) {
      const items = await listPullRequests(auth, { state: "all", sort: "updated", direction: "desc", perPage, page });
      if (!items.length) break;

      for (const pr of items) {
        const prUpdatedAt = parseIsoDate((pr as any).updated_at);
        if (sinceDate && prUpdatedAt && prUpdatedAt.getTime() < sinceDate.getTime()) {
          // 列表按 updated desc 排序，后续只会更老
          page = Number.POSITIVE_INFINITY;
          break;
        }

        const prNumber = Number((pr as any).number ?? 0);
        const run = await findGitHubRunByPrNumber(deps.prisma, { projectId: project.id, prNumber });
        if (run) {
          await updateGitHubRunScmFromPoll(deps.prisma, { runId: run.id, pr, now });
          continue;
        }

        const res = await upsertGitHubPullRequestAsIssue(deps, { projectId: project.id, external: pr, now });
        if (res.created) {
          await createDefaultTaskForIssue(deps, {
            issueId: res.issueId,
            templateKey: DEFAULT_PR_TASK_TEMPLATE_KEY,
            kind: "pr",
            postCreate: async (task) => {
              const baseBranch = String((pr as any).base?.ref ?? "").trim();
              if (baseBranch) {
                await deps.prisma.task.update({ where: { id: (task as any).id }, data: { baseBranch } as any }).catch(() => {});
              }

              const steps = Array.isArray((task as any).steps) ? ((task as any).steps as any[]) : [];
              const first = steps.find((s) => Number(s?.order) === 1) ?? steps[0] ?? null;
              if (!first) return;

              const prev = first.params && typeof first.params === "object" ? (first.params as any) : {};
              const prNumber = Number((pr as any).number ?? 0);
              const prUrl = String((pr as any).html_url ?? "").trim();
              const headBranch = String((pr as any).head?.ref ?? "").trim();
              const headSha = String((pr as any).head?.sha ?? "").trim();
              const githubPr = {
                provider: "github",
                owner: parsed.owner,
                repo: parsed.repo,
                apiBaseUrl: parsed.apiBaseUrl,
                number: prNumber,
                url: prUrl,
                baseBranch: baseBranch || null,
                headBranch: headBranch || null,
                headSha: headSha || null,
              };

              await deps.prisma.step
                .update({
                  where: { id: first.id },
                  data: { params: { ...prev, mode: prev.mode ?? "ai", githubPr } as any } as any,
                })
                .catch(() => {});
            },
          });
        }
      }

      if (page === Number.POSITIVE_INFINITY) break;
      if (items.length < perPage) break;
      page += 1;
      if (page > 50) break;
    }
  }

  await deps.prisma.project.update({
    where: { id: project.id },
    data: { githubPollingCursor: now } as any,
  });
}

const projectQueue = new Map<string, Promise<void>>();

export function startGitHubPollingLoop(opts: {
  prisma: PrismaDeps;
  intervalSeconds?: number;
  overlapSeconds?: number;
  log?: Logger;
}) {
  if (process.env.NODE_ENV === "test") return;
  if (truthyString(process.env.GITHUB_POLLING_DISABLED)) return;

  const log = opts.log ?? (() => {});
  const intervalMs = Math.max(10, Math.floor(opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)) * 1000;
  const overlapSeconds = Math.max(0, Math.floor(opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS));

  const runOnce = async () => {
    const projects = await opts.prisma.project
      .findMany({
        where: { githubPollingEnabled: true } as any,
        orderBy: { createdAt: "asc" },
      })
      .catch((err: unknown) => {
        log("github poll list projects failed", { err: String(err) });
        return [];
      });

    for (const project of projects as any[]) {
      if (!project?.id) continue;
      if (projectQueue.has(project.id)) continue;
      void enqueueByKey(projectQueue, project.id, async () => {
        try {
          await syncGitHubProjectOnce({ prisma: opts.prisma, log }, project, { overlapSeconds });
        } catch (err) {
          log("github poll crashed", { projectId: project.id, err: String(err) });
        }
      });
    }
  };

  void runOnce();

  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
}
