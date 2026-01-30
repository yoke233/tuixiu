import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function createAskPassScript(opts: {
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
  if (!isWin) await chmod(scriptPath, 0o700).catch(() => {});

  return { scriptPath, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

export async function createHostGitEnv(env: Record<string, string>): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const auth = String(env.TUIXIU_GIT_AUTH_MODE ?? "").trim().toLowerCase();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: "0",
  };

  if (auth === "ssh") {
    if (env.TUIXIU_GIT_SSH_COMMAND?.trim()) {
      return { env: { ...baseEnv, GIT_SSH_COMMAND: env.TUIXIU_GIT_SSH_COMMAND }, cleanup: async () => {} };
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), "tuixiu-git-ssh-"));
    const keyPath =
      env.TUIXIU_GIT_SSH_KEY_PATH?.trim() || path.join(dir, "tuixiu_git_key");
    if (env.TUIXIU_GIT_SSH_KEY_B64?.trim()) {
      await writeFile(keyPath, Buffer.from(env.TUIXIU_GIT_SSH_KEY_B64, "base64"));
    } else if (env.TUIXIU_GIT_SSH_KEY?.trim()) {
      await writeFile(keyPath, `${env.TUIXIU_GIT_SSH_KEY}\n`, { encoding: "utf8" });
    }
    await chmod(keyPath, 0o600).catch(() => {});

    const cmd = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    return {
      env: { ...baseEnv, GIT_SSH_COMMAND: cmd },
      cleanup: async () => rm(dir, { recursive: true, force: true }),
    };
  }

  const password = env.TUIXIU_GIT_HTTP_PASSWORD?.trim() ?? "";
  if (!password) {
    throw new Error("缺少 TUIXIU_GIT_HTTP_PASSWORD，无法执行 git 操作");
  }
  const username = env.TUIXIU_GIT_HTTP_USERNAME?.trim() || "x-access-token";
  const { scriptPath, cleanup } = await createAskPassScript({ token: password, username });
  return {
    env: {
      ...baseEnv,
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: scriptPath,
    },
    cleanup,
  };
}
