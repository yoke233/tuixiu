import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listIssues, updateIssue } from "../../../api/issues";
import { StatusBadge } from "../../../components/StatusBadge";
import type { Issue, IssueStatus } from "../../../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ARCHIVE_STATUSES: IssueStatus[] = ["done", "failed", "cancelled"];
type ArchiveStatusFilter = "all" | "done" | "failed" | "cancelled";
type ArchiveArchivedFilter = "all" | "archived" | "unarchived";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onRefreshGlobal: () => Promise<void>;
};

export function ArchiveSection(props: Props) {
  const { active, effectiveProjectId, requireAdmin, setError, onRefreshGlobal } = props;

  const [archiveItems, setArchiveItems] = useState<Issue[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveLimit, setArchiveLimit] = useState(20);
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveStatusFilter>("all");
  const [archiveArchived, setArchiveArchived] = useState<ArchiveArchivedFilter>("all");
  const [archiveQueryDraft, setArchiveQueryDraft] = useState("");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveBusyId, setArchiveBusyId] = useState("");
  const [archiveReloadToken, setArchiveReloadToken] = useState(0);

  useEffect(() => {
    if (!active) return;
    setArchiveOffset(0);
  }, [active, effectiveProjectId]);

  useEffect(() => {
    if (!active) return;
    if (!effectiveProjectId) return;

    const statuses: IssueStatus[] = archiveStatus === "all" ? ARCHIVE_STATUSES : [archiveStatus];
    const archivedFlag = archiveArchived === "all" ? undefined : archiveArchived === "archived";

    let cancelled = false;
    setArchiveLoading(true);
    setArchiveError(null);
    void listIssues({
      projectId: effectiveProjectId,
      statuses,
      archived: archivedFlag,
      q: archiveQuery.trim() ? archiveQuery.trim() : undefined,
      limit: archiveLimit,
      offset: archiveOffset,
    })
      .then((res) => {
        if (cancelled) return;
        setArchiveItems(res.issues);
        setArchiveTotal(res.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setArchiveError(err instanceof Error ? err.message : String(err));
        setArchiveItems([]);
        setArchiveTotal(0);
      })
      .finally(() => {
        if (cancelled) return;
        setArchiveLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, archiveArchived, archiveLimit, archiveOffset, archiveQuery, archiveReloadToken, archiveStatus, effectiveProjectId]);

  const onToggleArchived = useCallback(
    async (issue: Issue) => {
      setError(null);
      if (!requireAdmin()) return;
      setArchiveBusyId(issue.id);
      try {
        const next = !issue.archivedAt;
        await updateIssue(issue.id, { archived: next });
        await onRefreshGlobal();
        setArchiveReloadToken((v) => v + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setArchiveBusyId("");
      }
    },
    [onRefreshGlobal, requireAdmin, setError],
  );

  return (
    <section className="card" style={{ gridColumn: "1 / -1" }} hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
        <div>
          <h2 style={{ marginTop: 0 }}>Issue 归档</h2>
          <div className="muted">已完成/失败/取消的 Issue（支持筛选与分页）</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setArchiveReloadToken((v) => v + 1)}
          disabled={!effectiveProjectId || archiveLoading}
        >
          刷新
        </Button>
      </div>

      {!effectiveProjectId ? (
        <div className="muted">请先创建 Project</div>
      ) : (
        <>
          <div className="row gap" style={{ alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
            <label className="label" style={{ margin: 0, flex: "1 1 260px", minWidth: 220 }}>
              关键词
              <Input
                value={archiveQueryDraft}
                onChange={(e) => setArchiveQueryDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  setArchiveOffset(0);
                  setArchiveQuery(archiveQueryDraft.trim());
                }}
                placeholder="标题关键字…"
              />
            </label>

            <label className="label" style={{ margin: 0 }}>
              状态
              <Select
                value={archiveStatus}
                onValueChange={(v) => {
                  setArchiveOffset(0);
                  setArchiveStatus(v as ArchiveStatusFilter);
                }}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部（done/failed/cancelled）</SelectItem>
                  <SelectItem value="done">done</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="cancelled">cancelled</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="label" style={{ margin: 0 }}>
              归档
              <Select
                value={archiveArchived}
                onValueChange={(v) => {
                  setArchiveOffset(0);
                  setArchiveArchived(v as ArchiveArchivedFilter);
                }}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="unarchived">未归档</SelectItem>
                  <SelectItem value="archived">已归档</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="label" style={{ margin: 0 }}>
              每页
              <Select
                value={String(archiveLimit)}
                onValueChange={(v) => {
                  setArchiveOffset(0);
                  setArchiveLimit(Number(v) || 20);
                }}
              >
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <div className="row gap">
              <Button
                type="button"
                onClick={() => {
                  setArchiveOffset(0);
                  setArchiveQuery(archiveQueryDraft.trim());
                }}
                disabled={archiveLoading}
              >
                筛选
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setArchiveOffset(0);
                  setArchiveLimit(20);
                  setArchiveStatus("all");
                  setArchiveArchived("all");
                  setArchiveQueryDraft("");
                  setArchiveQuery("");
                }}
                disabled={archiveLoading}
              >
                重置
              </Button>
            </div>
          </div>

          {archiveError ? (
            <div className="muted" style={{ marginTop: 10 }} title={archiveError}>
              归档列表加载失败：{archiveError}
            </div>
          ) : null}

          <div className="row spaceBetween" style={{ marginTop: 10 }}>
            <div className="muted">{archiveLoading ? "加载中…" : `共 ${archiveTotal} 条`}</div>
            <div className="row gap">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setArchiveOffset((v) => Math.max(0, v - archiveLimit))}
                disabled={archiveLoading || archiveOffset === 0}
              >
                上一页
              </Button>
              <span className="muted">
                {archiveTotal ? `第 ${Math.floor(archiveOffset / archiveLimit) + 1} / ${Math.max(1, Math.ceil(archiveTotal / archiveLimit))} 页` : "—"}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setArchiveOffset((v) => v + archiveLimit)}
                disabled={archiveLoading || archiveOffset + archiveLimit >= archiveTotal}
              >
                下一页
              </Button>
            </div>
          </div>

          {archiveItems.length ? (
            <div className="tableScroll">
              <table className="table tableWrap">
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>外部</th>
                    <th>状态</th>
                    <th>Run</th>
                    <th>时间</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {archiveItems.map((i) => {
                    const latestRun = i.runs?.[0] ?? null;
                    const extLabel =
                      i.externalProvider && typeof i.externalNumber === "number"
                        ? `${i.externalProvider} #${i.externalNumber}`
                        : i.externalProvider && i.externalId
                          ? `${i.externalProvider}:${i.externalId}`
                          : "";
                    return (
                      <tr key={i.id}>
                        <td>
                          <div className="cellStack">
                            <Link to={`/issues/${i.id}`} title={i.title}>
                              {i.title}
                            </Link>
                            <div className="cellSub">
                              <code title={i.id}>{i.id}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="cellStack">
                            {i.externalUrl ? (
                              <a href={i.externalUrl} target="_blank" rel="noreferrer" title={i.externalUrl}>
                                {extLabel || "外部链接"}
                              </a>
                            ) : extLabel ? (
                              <span title={extLabel}>{extLabel}</span>
                            ) : (
                              <span className="muted">-</span>
                            )}
                            {i.externalUrl ? (
                              <div className="cellSub">
                                <span title={i.externalUrl}>{i.externalUrl}</span>
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={i.status} />
                        </td>
                        <td>
                          {latestRun ? (
                            <div className="row gap" style={{ gap: 8, flexWrap: "wrap" }}>
                              <StatusBadge status={latestRun.status} />
                              <code title={latestRun.id}>{latestRun.id}</code>
                            </div>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td>
                          <div className="cellStack">
                            <div className="cellSub">创建：{new Date(i.createdAt).toLocaleString()}</div>
                            <div className="cellSub">更新：{i.updatedAt ? new Date(i.updatedAt).toLocaleString() : "-"}</div>
                            <div className="cellSub">归档：{i.archivedAt ? new Date(i.archivedAt).toLocaleString() : "-"}</div>
                          </div>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void onToggleArchived(i)}
                            disabled={archiveBusyId === i.id || archiveLoading}
                          >
                            {i.archivedAt ? "取消归档" : "归档"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : archiveLoading ? null : (
            <div className="muted" style={{ marginTop: 12 }}>
              当前筛选条件下暂无数据
            </div>
          )}
        </>
      )}
    </section>
  );
}
