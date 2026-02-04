import type { IssueStatus } from "@/types";

export type DragPayload = {
  issueId: string;
  fromStatus: IssueStatus;
  runId?: string;
};

export type IssueBoardColumn = {
  key: IssueStatus;
  title: string;
  dot: string;
};

