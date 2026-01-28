export type WorkspaceNoticeMode = "default" | "hidden" | "custom";

export function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

