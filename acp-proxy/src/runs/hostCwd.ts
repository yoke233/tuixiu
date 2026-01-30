import path from "node:path";

const WORKSPACE_POSIX_ROOT = "/workspace";

function isWindowsDriveAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function isWindowsUncPath(p: string): boolean {
  return p.startsWith("\\\\");
}

/**
 * host_process 下：把 orchestrator 传来的 cwd（通常是 /workspace 或其子路径）
 * 映射成宿主机真实目录（run.hostWorkspacePath）。
 *
 * - Windows：/workspace → D:\workspaces\run-xxx（codex 侧要求 Windows 绝对路径）
 * - Linux/macOS：/workspace → /root/workspaces/run-xxx（避免 /workspace 这个“虚拟目录”不存在）
 */
export function mapCwdForHostProcess(
  cwd: string,
  hostWorkspacePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const raw = String(cwd ?? "").trim();
  const root = String(hostWorkspacePath ?? "").trim();
  if (!raw) return root || raw;
  if (!root) return raw;

  // 统一处理：只要是 /workspace（或其子路径），就映射到宿主机 workspace
  const normalizedPosix = raw.startsWith("/")
    ? path.posix.normalize(raw)
    : path.posix.join(WORKSPACE_POSIX_ROOT, raw);
  if (normalizedPosix === WORKSPACE_POSIX_ROOT || normalizedPosix.startsWith(`${WORKSPACE_POSIX_ROOT}/`)) {
    const rel = path.posix.relative(WORKSPACE_POSIX_ROOT, normalizedPosix);
    const parts = rel ? rel.split("/").filter(Boolean) : [];

    if (platform === "win32") {
      return path.win32.resolve(root, ...parts);
    }
    return path.posix.resolve(root, ...parts);
  }

  if (platform === "win32") {
    if (isWindowsDriveAbsolute(raw) || isWindowsUncPath(raw)) return path.win32.normalize(raw);
    // 相对路径：按 host workspace 解析成绝对路径
    return path.win32.resolve(root, raw);
  }

  // POSIX：如果已经是绝对路径则原样，否则按 host workspace 解析
  if (path.posix.isAbsolute(raw)) return path.posix.normalize(raw);
  return path.posix.resolve(root, raw);
}
