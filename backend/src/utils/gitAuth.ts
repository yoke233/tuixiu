import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GitAuthMode = "https_pat" | "ssh";

export type GitAuthProject = {
  repoUrl: string | null | undefined;
  scmType?: string | null;
  gitAuthMode?: string | null;
  githubAccessToken?: string | null;
  gitlabAccessToken?: string | null;
};

export class GitAuthEnvError extends Error {
  code: string;
  details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function assertRoleGitAuthEnv(
  roleEnv: Record<string, string>,
  roleKey?: string | null,
): void {
  const label = roleKey ? `角色(${roleKey})` : "角色";
  const modeRaw = roleEnv.TUIXIU_GIT_AUTH_MODE?.trim();
  if (!modeRaw) {
    throw new GitAuthEnvError(
      "GIT_AUTH_MODE_MISSING",
      `${label} 未配置 Git 认证：缺少 TUIXIU_GIT_AUTH_MODE`,
    );
  }
  const mode = modeRaw.toLowerCase();
  if (mode === "ssh") {
    const hasSsh =
      !!roleEnv.TUIXIU_GIT_SSH_COMMAND?.trim() ||
      !!roleEnv.TUIXIU_GIT_SSH_KEY_B64?.trim() ||
      !!roleEnv.TUIXIU_GIT_SSH_KEY?.trim() ||
      !!roleEnv.TUIXIU_GIT_SSH_KEY_PATH?.trim();
    if (!hasSsh) {
      throw new GitAuthEnvError(
        "GIT_SSH_AUTH_MISSING",
        `${label} SSH 认证缺失：请配置 TUIXIU_GIT_SSH_COMMAND 或 TUIXIU_GIT_SSH_KEY(_B64/_PATH)`,
      );
    }
    return;
  }

  const hasHttpsToken =
    !!roleEnv.TUIXIU_GIT_HTTP_PASSWORD?.trim() ||
    !!roleEnv.GITHUB_TOKEN?.trim() ||
    !!roleEnv.GH_TOKEN?.trim() ||
    !!roleEnv.GITLAB_ACCESS_TOKEN?.trim() ||
    !!roleEnv.GITLAB_TOKEN?.trim();
  if (!hasHttpsToken) {
    throw new GitAuthEnvError(
      "GIT_HTTPS_AUTH_MISSING",
      `${label} HTTPS 认证缺失：请配置 TUIXIU_GIT_HTTP_PASSWORD 或 GH_TOKEN/GITHUB_TOKEN/GITLAB_ACCESS_TOKEN/GITLAB_TOKEN`,
    );
  }
}

function inferGitAuthMode(input: GitAuthProject): GitAuthMode {
  const explicit = String(input.gitAuthMode ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "https_pat") return "https_pat";
  if (explicit === "ssh") return "ssh";

  const url = String(input.repoUrl ?? "")
    .trim()
    .toLowerCase();
  if (url.startsWith("http://") || url.startsWith("https://")) return "https_pat";
  return "ssh";
}

function inferHttpsUsername(input: GitAuthProject): string {
  const scm = String(input.scmType ?? "")
    .trim()
    .toLowerCase();
  if (scm === "gitlab" || scm === "codeup") return "oauth2";
  return "x-access-token";
}

function pickPatToken(input: GitAuthProject): string | null {
  const scm = String(input.scmType ?? "")
    .trim()
    .toLowerCase();
  if (scm === "github") return input.githubAccessToken?.trim() || null;
  if (scm === "gitlab" || scm === "codeup") return input.gitlabAccessToken?.trim() || null;
  return input.githubAccessToken?.trim() || input.gitlabAccessToken?.trim() || null;
}

export function resolveGitAuthMode(input: GitAuthProject): GitAuthMode {
  return inferGitAuthMode(input);
}

export function resolveGitHttpUsername(input: GitAuthProject): string {
  return inferHttpsUsername(input);
}

export function pickGitAccessToken(input: GitAuthProject): string | null {
  return pickPatToken(input);
}

async function writeAskPassScript(opts: {
  token: string;
  username: string;
}): Promise<{ scriptPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tuixiu-git-askpass-"));
  const isWin = process.platform === "win32";
  const scriptPath = path.join(dir, isWin ? "askpass.cmd" : "askpass.sh");
  const token = opts.token;
  const username = opts.username;

  const content = isWin
    ? [
      "@echo off",
      "set prompt=%*",
      "echo %prompt% | findstr /i username >nul",
      "if %errorlevel%==0 (",
      `  echo ${username}`,
      "  exit /b 0",
      ")",
      `echo ${token}`,
      "",
    ].join("\r\n")
    : [
      "#!/bin/sh",
      `prompt="$1"`,
      'case "$prompt" in',
      "  *Username*|*username*)",
      `    printf '%s\\n' '${username}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '${token}'`,
      "    ;;",
      "esac",
      "",
    ].join("\n");

  await writeFile(scriptPath, content, { encoding: "utf8" });
  if (!isWin) await chmod(scriptPath, 0o700).catch(() => { });

  return { scriptPath, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

export async function createGitProcessEnv(input: GitAuthProject): Promise<{
  gitAuthMode: GitAuthMode;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const gitAuthMode = inferGitAuthMode(input);
  if (gitAuthMode !== "https_pat") {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    // 以 SSH 模式工作时，尽量避免宿主机注入的 askpass 影响 git 行为/弹窗。
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    delete env.GIT_SSH_ASKPASS;
    return {
      gitAuthMode,
      env,
      cleanup: async () => { },
    };
  }

  const token = pickPatToken(input);
  if (!token) {
    throw new Error("gitAuthMode=https_pat 但未配置 accessToken");
  }
  const username = inferHttpsUsername(input);
  const { scriptPath, cleanup } = await writeAskPassScript({ token, username });

  return {
    gitAuthMode,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: scriptPath,
    },
    cleanup,
  };
}
