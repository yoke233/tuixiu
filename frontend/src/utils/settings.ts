const SHOW_ARCHIVED_ISSUES_KEY = "showArchivedIssues";

export function getShowArchivedIssues(): boolean {
  try {
    const raw = localStorage.getItem(SHOW_ARCHIVED_ISSUES_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

export function setShowArchivedIssues(show: boolean) {
  try {
    localStorage.setItem(SHOW_ARCHIVED_ISSUES_KEY, show ? "1" : "0");
  } catch {
    // ignore
  }
}

