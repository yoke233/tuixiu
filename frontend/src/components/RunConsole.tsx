import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Event } from "@/types";

import { Button } from "@/components/ui/button";
import { buildConsoleItems } from "@/components/runConsole/buildConsoleItems";
import { RunConsoleItem } from "@/components/runConsole/RunConsoleItem";
import type { PermissionUiProps } from "@/components/runConsole/types";
import { parseSandboxInstanceStatusText } from "@/utils/sandboxStatus";

export function RunConsole(props: {
  events: Event[];
  liveEventIds?: Set<string>;
  permission?: PermissionUiProps;
  showStatusEvents?: boolean;
}) {
  const defaultVisibleCount = 160;
  const loadMoreStep = 200;

  const items = useMemo(() => {
    return buildConsoleItems(props.events, { liveEventIds: props.liveEventIds });
  }, [props.events, props.liveEventIds]);
  const baseFilteredItems = useMemo(() => {
    return items.filter((item) => {
      if (item.role !== "system") return true;
      // 状态/调试类事件默认隐藏（可通过 UI 开关查看）。规则定义见 eventToConsoleItem.ts
      if (item.isStatus) return false;
      if (item.detailsTitle && item.detailsTitle.startsWith("可用命令")) return false;
      if (!item.text) return true;
      return !parseSandboxInstanceStatusText(item.text);
    });
  }, [items]);
  const showStatusEvents = props.showStatusEvents === true;
  const filteredItems = showStatusEvents ? items : baseFilteredItems;
  const hasHiddenOnly = !showStatusEvents && items.length > 0 && baseFilteredItems.length === 0;

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

  if (!filteredItems.length) {
    return (
      <div className="muted">
        <div>暂无输出（无日志）</div>
        {hasHiddenOnly ? (
          <div className="row gap" style={{ marginTop: 8, alignItems: "center" }}>
            <span>当前仅有状态事件（默认隐藏）</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={ref} className="console" role="log" aria-label="运行输出">
      {hiddenCount > 0 ? (
        <div className="consoleTrimBar">
          <span className="consoleTrimText">已隐藏 {hiddenCount} 条旧日志</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const el = ref.current;
              if (el)
                pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setVisibleCount((prev) => Math.min(filteredItems.length, prev + loadMoreStep));
            }}
          >
            显示更多
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const el = ref.current;
              if (el)
                pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
              setShowAll(true);
            }}
          >
            显示全部
          </Button>
        </div>
      ) : showAll && filteredItems.length > defaultVisibleCount ? (
        <div className="consoleTrimBar">
          <span className="consoleTrimText">已显示全部 {filteredItems.length} 条日志</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              stickToBottomRef.current = true;
              setShowAll(false);
              setVisibleCount(defaultVisibleCount);
            }}
          >
            仅显示最新 {defaultVisibleCount} 条
          </Button>
        </div>
      ) : null}

      {visibleItems.map((item) => (
        <RunConsoleItem key={item.id} item={item} permission={props.permission} />
      ))}
    </div>
  );
}
