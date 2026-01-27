import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GitAuthMode = "https_pat" | "ssh";

export type GitAuthProject = {
  repoUrl: string;
  scmType?: string | null;
  gitAuthMode?: string | null;
  githubAccessToken?: string | null;
  gitlabAccessToken?: string | null;
};

function inferGitAuthMode(project: GitAuthProject): GitAuthMode {
  const explicit = String(project.gitAuthMode ?? "").trim().toLowerCase();
  if (explicit === "https_pat") return "https_pat";
  if (explicit === "ssh") return "ssh";

  const url = String(project.repoUrl ?? "").trim().toLowerCase();
  if (url.startsWith("http://") || url.startsWith("https://")) return "https_pat";
  return "ssh";
}

function inferHttpsUsername(project: GitAuthProject): string {
  const scm = String(project.scmType ?? "").trim().toLowerCase();
  if (scm === "gitlab" || scm === "codeup") return "oauth2";
  return "x-access-token";
}

function pickPatToken(project: GitAuthProject): string | null {
  const scm = String(project.scmType ?? "").trim().toLowerCase();
  if (scm === "github") return project.githubAccessToken?.trim() || null;
  if (scm === "gitlab" || scm === "codeup") return project.gitlabAccessToken?.trim() || null;
  return project.githubAccessToken?.trim() || project.gitlabAccessToken?.trim() || null;
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
        "case \"$prompt\" in",
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
  if (!isWin) await chmod(scriptPath, 0o700).catch(() => {});

  return { scriptPath, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

export async function createGitProcessEnv(project: GitAuthProject): Promise<{
  gitAuthMode: GitAuthMode;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const gitAuthMode = inferGitAuthMode(project);
  if (gitAuthMode !== "https_pat") {
    return {
      gitAuthMode,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      cleanup: async () => {},
    };
  }

  const token = pickPatToken(project);
  if (!token) {
    throw new Error("gitAuthMode=https_pat 但未配置 accessToken");
  }
  const username = inferHttpsUsername(project);
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

