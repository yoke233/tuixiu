import type { Issue } from "@/types";

export type IssuesOutletContext = {
  onIssueUpdated?: (issue: Issue) => void;
};

