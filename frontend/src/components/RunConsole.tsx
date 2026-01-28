import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Event } from "../types";

import { buildConsoleItems } from "./runConsole/buildConsoleItems";
import { ConsoleDetailsBlock } from "./runConsole/ConsoleDetailsBlock";
import { exitToBadgeClass, getToolTitle, kindToBadgeClass, priorityToBadgeClass, statusToBadgeClass } from "./runConsole/toolCallInfo";

export function RunConsole(props: { events: Event[] }) {
  const defaultVisibleCount = 160;
  const loadMoreStep = 200;

  const items = useMemo(() => {
    return buildConsoleItems(props.events);
  }, [props.events]);

  const [visibleCount, setVisibleCount] = useState(defaultVisibleCount);
  const [showAll, setShowAll] = useState(false);
  const pendingScrollRestoreRef = useRef<{ height: number; top: number } | null>(null);

  const visibleItems = useMemo(() => {
    if (showAll) return items;
    if (items.length <= visibleCount) return items;
    return items.slice(items.length - visibleCount);
  }, [items, showAll, visibleCount]);
  const hiddenCount = items.length - visibleItems.length;

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

  if (!items.length) return <div className="muted">暂无输出（无日志）</div>;

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
              if (el) pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setVisibleCount((prev) => Math.min(items.length, prev + loadMoreStep));
            }}
          >
            显示更多
          </button>
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => {
              const el = ref.current;
              if (el) pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setShowAll(true);
            }}
          >
            显示全部
          </button>
        </div>
      ) : showAll && items.length > defaultVisibleCount ? (
        <div className="consoleTrimBar">
          <span className="consoleTrimText">已显示全部 {items.length} 条日志</span>
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
            { completed: 0, in_progress: 0, pending: 0 }
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
                  {counts.in_progress ? <span className="badge orange">in_progress {counts.in_progress}</span> : null}
                  {counts.pending ? <span className="badge gray">pending {counts.pending}</span> : null}
                </>
              }
              bodyClassName="planBody"
              body={
                <div className="planList">
                  {entries.map((e, idx) => (
                    <div key={`${idx}-${e.status}-${e.content}`} className="planItem">
                      <span className={statusToBadgeClass(e.status)}>{e.status}</span>
                      {e.priority ? <span className={priorityToBadgeClass(e.priority)}>{e.priority}</span> : null}
                      <span className="planContent">{e.content}</span>
                    </div>
                  ))}
                </div>
              }
            />
          );
        }
        if (item.role === "user" && item.kind === "chunk" && item.chunkType === "user_message") {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">New Session</span>
                  <span className="toolSummaryTitle"></span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "agent" && item.kind === "chunk" && item.chunkType === "agent_thought") {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              bordered
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
        if (item.role === "system" && item.toolCallInfo) {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">TOOL</span>
                  {item.toolCallInfo.kind ? (
                    <span className={kindToBadgeClass(item.toolCallInfo.kind)}>{item.toolCallInfo.kind}</span>
                  ) : null}
                  {item.toolCallInfo.status ? (
                    <span className={statusToBadgeClass(item.toolCallInfo.status)}>{item.toolCallInfo.status}</span>
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
