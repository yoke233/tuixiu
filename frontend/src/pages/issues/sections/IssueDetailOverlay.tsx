import { Outlet } from "react-router-dom";

import type { IssueListController } from "../useIssueListController";

export function IssueDetailOverlay(props: { model: IssueListController }) {
  const { closeDetail, hasDetail, outletContext } = props.model;
  if (!hasDetail) return null;

  return (
    <div
      className="modalOverlay issueDetailOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Issue 详情"
      onClick={closeDetail}
    >
      <div className="issueDetailDrawer" onClick={(e) => e.stopPropagation()}>
        <Outlet context={outletContext} />
      </div>
    </div>
  );
}

