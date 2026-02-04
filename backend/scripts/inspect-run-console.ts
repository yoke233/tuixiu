/**
 * 读取 DB 里的 Run events，并按前端 RunConsole 的规则“模拟渲染”：
 * - buildConsoleItems（合并 chunk / tool_call_update 等）
 * - 默认过滤：隐藏 sandbox_instance_status、隐藏 “可用命令”块
 * - 默认只展示最新 160 条（与前端一致）
 *
 * 用法（仓库根目录）：
 *   Push-Location backend
 *   pnpm exec tsx scripts/inspect-run-console.ts <runId> [limit]
 *   Pop-Location
 */

import "dotenv/config";

import { PrismaClient } from "@prisma/client";

import type { Event as UiEvent } from "../../frontend/src/types";
import { buildConsoleItems } from "../../frontend/src/components/runConsole/buildConsoleItems";
import { parseSandboxInstanceStatusText } from "../../frontend/src/utils/sandboxStatus";

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function truncate(text: string, max = 240): string {
  const s = String(text ?? "").replace(/\s+$/g, "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatLine(item: any): string {
  const ts = String(item.timestamp ?? "");
  const role = String(item.role ?? "system");

  if (item.permissionRequest) {
    const pr = item.permissionRequest;
    const rid = String(pr.requestId ?? "");
    const sid = String(pr.sessionId ?? "");
    const optCount = Array.isArray(pr.options) ? pr.options.length : 0;
    return `${ts} ${role} [permission_request] requestId=${rid} sessionId=${sid} options=${optCount}`;
  }

  if (item.plan) {
    const entries = Array.isArray(item.plan.entries) ? item.plan.entries : [];
    const counts = entries.reduce(
      (acc: any, e: any) => {
        const st = typeof e?.status === "string" ? e.status : "pending";
        if (st === "completed") acc.completed += 1;
        else if (st === "in_progress") acc.in_progress += 1;
        else acc.pending += 1;
        return acc;
      },
      { completed: 0, in_progress: 0, pending: 0 },
    );
    return `${ts} ${role} [plan] completed=${counts.completed} in_progress=${counts.in_progress} pending=${counts.pending}`;
  }

  const kind = String(item.kind ?? "block");
  const chunkType = item.chunkType ? `:${String(item.chunkType)}` : "";
  const head = `${ts} ${role} ${kind}${chunkType}`;

  const text = String(item.text ?? "");
  if (!text.trim()) return `${head} (empty)`;

  // 让 JSON 的 sandbox_instance_status 更好读一点（哪怕它通常会被过滤掉）
  const parsedSandbox = parseSandboxInstanceStatusText(text);
  if (parsedSandbox) {
    return `${head} sandbox_status=${parsedSandbox.status} provider=${parsedSandbox.provider ?? ""} lastError=${parsedSandbox.lastError ?? ""}`;
  }

  return `${head} ${truncate(text)}`;
}

async function main() {
  const runId = String(process.argv[2] ?? "").trim();
  if (!runId) {
    console.error("用法: pnpm exec tsx scripts/inspect-run-console.ts <runId> [limit]");
    process.exit(1);
  }
  const limit = clampInt(process.argv[3], 800, 1, 5000);
  const defaultVisibleCount = 160;

  const prisma = new PrismaClient();
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true, errorMessage: true, startedAt: true, completedAt: true },
    });
    if (!run) {
      console.error(`Run 不存在: ${runId}`);
      process.exit(1);
    }

    const events = await prisma.event.findMany({
      where: { runId },
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    const uiEvents: UiEvent[] = events.map((e) => ({
      id: String(e.id),
      runId: String(e.runId),
      source: e.source as any,
      type: String(e.type),
      payload: (e as any).payload ?? undefined,
      timestamp: (e as any).timestamp instanceof Date ? (e as any).timestamp.toISOString() : String((e as any).timestamp),
    }));

    const items = buildConsoleItems(uiEvents);
    const baseFilteredItems = items.filter((item: any) => {
      if (item.role !== "system") return true;
      if (item.isStatus) return false;
      if (item.detailsTitle && String(item.detailsTitle).startsWith("可用命令")) return false;
      if (!item.text) return true;
      return !parseSandboxInstanceStatusText(String(item.text));
    });

    const hasHiddenOnly = items.length > 0 && baseFilteredItems.length === 0;

    const visibleItems =
      baseFilteredItems.length <= defaultVisibleCount
        ? baseFilteredItems
        : baseFilteredItems.slice(baseFilteredItems.length - defaultVisibleCount);
    const hiddenOldCount = baseFilteredItems.length - visibleItems.length;
    const hiddenStatusCount = items.length - baseFilteredItems.length;

    console.log(
      JSON.stringify(
        {
          run: {
            id: run.id,
            status: run.status,
            startedAt: (run.startedAt as any)?.toISOString?.() ?? run.startedAt,
            completedAt: (run.completedAt as any)?.toISOString?.() ?? run.completedAt,
            errorMessage: run.errorMessage ?? null,
          },
          counts: {
            eventsFetched: events.length,
            consoleItems: items.length,
            visibleAfterFilter: baseFilteredItems.length,
            hiddenStatusOrCommands: hiddenStatusCount,
            hiddenOldByTrim: hiddenOldCount,
          },
          ui: {
            defaultVisibleCount,
            hasHiddenOnly,
          },
        },
        null,
        2,
      ),
    );

    console.log("\n--- console (default view) ---");
    for (const item of visibleItems) {
      console.log(formatLine(item));
    }

    if (hasHiddenOnly) {
      console.log("\n(提示) 该 Run 目前只有 sandbox 状态类事件；前端会提示“显示状态事件”。");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

void main().catch((err) => {
  console.error(String(err instanceof Error ? err.stack ?? err.message : err));
  process.exit(1);
});
