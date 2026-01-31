import { Link } from "react-router-dom";

import type { Approval } from "../../../types";
import { Button } from "@/components/ui/button";

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

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <h2 style={{ marginTop: 0 }}>审批队列</h2>
      {approvals.length ? (
        <ul className="list">
          {approvals.map((a) => (
            <li key={a.id} className="listItem">
              <div className="row spaceBetween">
                <div>
                  <code>{a.action}</code>
                  <span className="muted" style={{ marginLeft: 10 }}>
                    {a.issueTitle ?? a.issueId ?? a.runId}
                  </span>
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
                状态：{a.status}
                {a.requestedBy ? ` · 请求人：${a.requestedBy}` : ""}
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
