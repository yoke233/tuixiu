const SHOW_ARCHIVED_ISSUES_KEY = "showArchivedIssues";
const SELECTED_PROJECT_ID_KEY = "selectedProjectId";

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

export function getLastSelectedProjectId(): string {
  try {
    return localStorage.getItem(SELECTED_PROJECT_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setLastSelectedProjectId(projectId: string) {
  const id = projectId.trim();
  try {
    if (!id) {
      localStorage.removeItem(SELECTED_PROJECT_ID_KEY);
      return;
    }
    localStorage.setItem(SELECTED_PROJECT_ID_KEY, id);
  } catch {
    // ignore
  }
}

