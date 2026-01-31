import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { Approval } from "../../../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  active: boolean;
  approvals: Approval[];
  loading: boolean;
  busyId: string;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
};

export function ApprovalsSection(props: Props) {
  const { active, approvals, loading, busyId, onApprove, onReject } = props;

  const [actionFilter, setActionFilter] = useState<string>("");
  const [query, setQuery] = useState("");

  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of approvals) set.add(String(a.action ?? ""));
    return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [approvals]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return approvals.filter((a) => {
      if (actionFilter && a.action !== actionFilter) return false;
      if (!q) return true;
      const hay = [a.action, a.issueTitle, a.issueId, a.runId, a.requestedBy]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [actionFilter, approvals, query]);

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>审批队列</h2>
          <div className="muted">当前 {filtered.length} 条{approvals.length !== filtered.length ? `（共 ${approvals.length} 条）` : ""}</div>
        </div>
        <div className="row gap" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="label" style={{ margin: 0 }}>
            Action
            <Select value={actionFilter ? actionFilter : "__all__"} onValueChange={(v) => setActionFilter(v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="全部" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部</SelectItem>
                {actionOptions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="label" style={{ margin: 0 }}>
            搜索
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="issue / run / user…" />
          </label>
        </div>
      </div>

      {filtered.length ? (
        <ul className="list">
          {filtered.map((a) => (
            <li key={a.id} className="listItem">
              <div className="row spaceBetween">
                <div>
                  <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <code>{a.action}</code>
                    <Badge variant="secondary">{a.status}</Badge>
                    <span className="muted">{a.issueTitle ?? a.issueId ?? a.runId}</span>
                  </div>
                  {a.runId ? (
                    <div className="muted" style={{ marginTop: 6 }}>
                      runId: <code>{a.runId}</code>
                    </div>
                  ) : null}
                </div>
                <div className="row gap">
                  <Button variant="link" size="sm" asChild>
                    <Link to={a.issueId ? `/issues/${a.issueId}` : "/issues"}>打开</Link>
                  </Button>
                  <Button type="button" size="sm" onClick={() => void onApprove(a.id)} disabled={loading || busyId === a.id}>
                    批准
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => void onReject(a.id)}
                    disabled={loading || busyId === a.id}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                {a.requestedBy ? `请求人：${a.requestedBy}` : "请求人：—"}
                {a.requestedAt ? ` · 请求时间：${new Date(a.requestedAt).toLocaleString()}` : ""}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">暂无待审批动作</div>
      )}
    </section>
  );
}
