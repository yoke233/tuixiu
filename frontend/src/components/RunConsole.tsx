import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Event } from "../types";

import { buildConsoleItems } from "./runConsole/buildConsoleItems";
import { ConsoleDetailsBlock } from "./runConsole/ConsoleDetailsBlock";
import {
  exitToBadgeClass,
  getToolTitle,
  kindToBadgeClass,
  priorityToBadgeClass,
  statusToBadgeClass,
} from "./runConsole/toolCallInfo";
import { parseSandboxInstanceStatusText } from "../utils/sandboxStatus";

const INIT_STAGE_LABELS: Record<string, string> = {
  auth: "鉴权准备",
  clone: "项目拉取",
  checkout: "切换分支",
  ready: "环境就绪",
};

const INIT_STATUS_LABELS: Record<string, string> = {
  start: "开始",
  progress: "进行中",
  done: "完成",
  error: "失败",
};

function initStatusClass(status: string): string {
  if (status === "done") return "badge green";
  if (status === "start") return "badge blue";
  if (status === "progress") return "badge orange";
  if (status === "error" || status === "failed") return "badge red";
  return "badge gray";
}

function extractPermissionReason(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") return null;

  const tc = toolCall as any;
  const content = tc.content;
  if (!Array.isArray(content) || !content.length) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const inner = (item as any).content;
    if (inner && typeof inner === "object" && typeof inner.text === "string") {
      const t = inner.text.trim();
      if (t) parts.push(t);
    } else if (typeof (item as any).text === "string") {
      const t = String((item as any).text).trim();
      if (t) parts.push(t);
    }
  }

  if (!parts.length) return null;
  return parts.join("\n");
}

type PermissionDecision = { outcome: "selected" | "cancelled"; optionId?: string };
type PermissionUiProps = {
  isAdmin?: boolean;
  resolvingRequestId?: string | null;
  resolvedRequestIds?: Set<string>;
  onDecide?: (input: { requestId: string; sessionId: string } & PermissionDecision) => void;
};

export function RunConsole(props: {
  events: Event[];
  liveEventIds?: Set<string>;
  permission?: PermissionUiProps;
}) {
  const defaultVisibleCount = 160;
  const loadMoreStep = 200;

  const items = useMemo(() => {
    return buildConsoleItems(props.events, { liveEventIds: props.liveEventIds });
  }, [props.events, props.liveEventIds]);
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (item.role !== "system") return true;
      if (item.detailsTitle && item.detailsTitle.startsWith("可用命令")) return false;
      if (!item.text) return true;
      return !parseSandboxInstanceStatusText(item.text);
    });
  }, [items]);

  const [visibleCount, setVisibleCount] = useState(defaultVisibleCount);
  const [showAll, setShowAll] = useState(false);
  const pendingScrollRestoreRef = useRef<{ height: number; top: number } | null>(null);

  const visibleItems = useMemo(() => {
    if (showAll) return filteredItems;
    if (filteredItems.length <= visibleCount) return filteredItems;
    return filteredItems.slice(filteredItems.length - visibleCount);
  }, [filteredItems, showAll, visibleCount]);
  const hiddenCount = filteredItems.length - visibleItems.length;

  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    lastScrollTopRef.current = el.scrollTop;

    const updateStickiness = () => {
      const currentScrollTop = el.scrollTop;
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      if (currentScrollTop < previousScrollTop) {
        stickToBottomRef.current = false;
        return;
      }

      const distance = el.scrollHeight - currentScrollTop - el.clientHeight;
      stickToBottomRef.current = distance <= 1;
    };

    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => el.removeEventListener("scroll", updateStickiness);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;

    const delta = el.scrollHeight - pending.height;
    el.scrollTop = pending.top + delta;
  }, [showAll, visibleItems.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;

    if (typeof (el as any).scrollTo === "function") {
      (el as any).scrollTo({ top: el.scrollHeight });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleItems]);

  if (!filteredItems.length) return <div className="muted">暂无输出（无日志）</div>;

  return (
    <div ref={ref} className="console" role="log" aria-label="运行输出">
      {hiddenCount > 0 ? (
        <div className="consoleTrimBar">
          <span className="consoleTrimText">已隐藏 {hiddenCount} 条旧日志</span>
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => {
              const el = ref.current;
              if (el)
                pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setVisibleCount((prev) => Math.min(filteredItems.length, prev + loadMoreStep));
            }}
          >
            显示更多
          </button>
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => {
              const el = ref.current;
              if (el)
                pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setShowAll(true);
            }}
          >
            显示全部
          </button>
        </div>
      ) : showAll && filteredItems.length > defaultVisibleCount ? (
        <div className="consoleTrimBar">
          <span className="consoleTrimText">已显示全部 {filteredItems.length} 条日志</span>
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => {
              stickToBottomRef.current = true;
              setShowAll(false);
              setVisibleCount(defaultVisibleCount);
            }}
          >
            仅显示最新 {defaultVisibleCount} 条
          </button>
        </div>
      ) : null}

      {visibleItems.map((item) => {
        if (item.role === "system" && item.plan) {
          const entries = item.plan.entries;
          const counts = entries.reduce(
            (acc, e) => {
              if (e.status === "completed") acc.completed += 1;
              else if (e.status === "in_progress") acc.in_progress += 1;
              else acc.pending += 1;
              return acc;
            },
            { completed: 0, in_progress: 0, pending: 0 },
          );
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              defaultOpen
              summary={
                <>
                  <span className="badge gray">PLAN</span>
                  <span className="toolSummaryTitle">
                    计划（{counts.completed}/{entries.length}）
                  </span>
                  {counts.in_progress ? (
                    <span className="badge orange">in_progress {counts.in_progress}</span>
                  ) : null}
                  {counts.pending ? (
                    <span className="badge gray">pending {counts.pending}</span>
                  ) : null}
                </>
              }
              bodyClassName="planBody"
              body={
                <div className="planList">
                  {entries.map((e, idx) => (
                    <div key={`${idx}-${e.status}-${e.content}`} className="planItem">
                      <span className={statusToBadgeClass(e.status)}>{e.status}</span>
                      {e.priority ? (
                        <span className={priorityToBadgeClass(e.priority)}>{e.priority}</span>
                      ) : null}
                      <span className="planContent">{e.content}</span>
                    </div>
                  ))}
                </div>
              }
            />
          );
        }
        if (item.role === "system" && item.initStep) {
          const stageLabel = INIT_STAGE_LABELS[item.initStep.stage] ?? item.initStep.stage;
          const statusLabel = INIT_STATUS_LABELS[item.initStep.status] ?? item.initStep.status;
          return (
            <div key={item.id} className="consoleItem system consoleInitStep">
              <span className="badge gray">INIT</span>
              <span className={initStatusClass(item.initStep.status)}>{statusLabel}</span>
              <span className="toolSummaryTitle">{stageLabel}</span>
              {item.initStep.message ? (
                <span className="consoleInitMessage">{item.initStep.message}</span>
              ) : null}
            </div>
          );
        }
        if (item.role === "system" && item.permissionRequest) {
          const req = item.permissionRequest;
          const toolCall = req.toolCall as any;
          const title =
            typeof toolCall?.title === "string" && toolCall.title.trim()
              ? toolCall.title.trim()
              : "工具调用权限";
          const kind =
            typeof toolCall?.kind === "string" && toolCall.kind.trim() ? toolCall.kind.trim() : null;
          const reason = extractPermissionReason(toolCall);
          const busy = props.permission?.resolvingRequestId === req.requestId;
          const resolved = props.permission?.resolvedRequestIds?.has(req.requestId) ?? false;
          const isAdmin = props.permission?.isAdmin ?? false;
          const canDecide = Boolean(props.permission?.onDecide) && isAdmin && !busy && !resolved;
          const titleHint = !props.permission?.onDecide
            ? "当前页面未启用审批操作"
            : !isAdmin
              ? "需要管理员权限"
              : resolved
                ? "已处理"
                : busy
                  ? "处理中…"
                  : "";

          return (
            <div
              key={item.id}
              className="consoleItem system"
              style={{ display: "grid", gap: 6, whiteSpace: "normal" }}
            >
              <div className="row gap" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="badge orange">PERMISSION</span>
                {kind ? <span className={kindToBadgeClass(kind)}>{kind}</span> : null}
                {resolved ? (
                  <span className="badge green">resolved</span>
                ) : busy ? (
                  <span className="badge orange">processing</span>
                ) : (
                  <span className="badge gray">pending</span>
                )}
                <span className="toolSummaryTitle">{title}</span>
              </div>

              <div className="muted" style={{ fontSize: 12 }}>
                requestId={req.requestId}
                {req.promptId ? ` · prompt=${req.promptId}` : ""}
              </div>

              {reason ? (
                <div className="pre" style={{ marginTop: 0 }}>
                  {reason}
                </div>
              ) : null}

              <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                {req.options.map((o) => {
                  const label = (o.name ?? "").trim() || (o.kind ?? "").trim() || o.optionId;
                  const secondary = String(o.kind ?? "").startsWith("reject");
                  return (
                    <button
                      key={o.optionId}
                      type="button"
                      className={secondary ? "buttonSecondary" : undefined}
                      disabled={!canDecide}
                      title={titleHint}
                      onClick={() =>
                        props.permission?.onDecide?.({
                          requestId: req.requestId,
                          sessionId: req.sessionId,
                          outcome: "selected",
                          optionId: o.optionId,
                        })
                      }
                    >
                      {label}
                    </button>
                  );
                })}

                {!req.options.length ? (
                  <button
                    type="button"
                    className="buttonSecondary"
                    disabled={!canDecide}
                    title={titleHint}
                    onClick={() =>
                      props.permission?.onDecide?.({
                        requestId: req.requestId,
                        sessionId: req.sessionId,
                        outcome: "cancelled",
                      })
                    }
                  >
                    取消
                  </button>
                ) : null}

                {!props.permission?.onDecide ? (
                  <span className="muted">（当前页面未接入审批按钮）</span>
                ) : !isAdmin ? (
                  <span className="muted">仅管理员可审批</span>
                ) : resolved ? (
                  <span className="muted">已处理</span>
                ) : null}
              </div>
            </div>
          );
        }
        if (item.role === "user" && item.kind === "chunk" && item.chunkType === "user_message") {
          return (
            <div key={item.id} className={`consoleItem ${item.role}`}>
              <span className="consoleNewTag" title="new" aria-label="new">
                !
              </span>
              <span>{item.text}</span>
            </div>
          );
        }
        if (item.role === "agent" && item.kind === "chunk" && item.chunkType === "agent_thought") {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              bordered
              defaultOpen={Boolean(item.live)}
              summary={
                <>
                  <span className="badge gray">THINK</span>
                  <span className="toolSummaryTitle">思考</span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "system" && item.detailsTitle) {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">INFO</span>
                  <span className="toolSummaryTitle">{item.detailsTitle}</span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "system") {
          const sandbox = parseSandboxInstanceStatusText(item.text);
          if (sandbox) return null;
        }
        if (item.role === "system" && item.toolCallInfo) {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">TOOL</span>
                  {item.toolCallInfo.kind ? (
                    <span className={kindToBadgeClass(item.toolCallInfo.kind)}>
                      {item.toolCallInfo.kind}
                    </span>
                  ) : null}
                  {item.toolCallInfo.status ? (
                    <span className={statusToBadgeClass(item.toolCallInfo.status)}>
                      {item.toolCallInfo.status}
                    </span>
                  ) : null}
                  {typeof item.toolCallInfo.exitCode === "number" ? (
                    <span className={exitToBadgeClass(item.toolCallInfo.exitCode)}>
                      exit {item.toolCallInfo.exitCode}
                    </span>
                  ) : null}
                  <span className="toolSummaryTitle">{getToolTitle(item.toolCallInfo)}</span>
                </>
              }
              body={item.text}
            />
          );
        }
        return (
          <div key={item.id} className={`consoleItem ${item.role}`}>
            {item.role === "user" ? `你: ${item.text}` : item.text}
          </div>
        );
      })}
    </div>
  );
}
