import { Outlet } from "react-router-dom";

import type { IssueListController } from "../useIssueListController";

export function IssueDetailOverlay(props: { model: IssueListController }) {
  const { closeDetail, hasDetail, outletContext, isMobile } = props.model;
  if (!hasDetail) return null;

  if (isMobile) {
    return (
      <div className="issueDetailFull">
        <Outlet context={outletContext} />
      </div>
    );
  }

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
