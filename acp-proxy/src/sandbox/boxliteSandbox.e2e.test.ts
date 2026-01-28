import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { parse as parseToml } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { BoxliteSandbox } from "./boxliteSandbox.js";

async function tryHasKvm(): Promise<boolean> {
  try {
    await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matcher: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
    if (matcher(buf)) return buf;
  }
  return buf;
}

async function pickSandboxImageFromConfig(): Promise<string | null> {
  const candidates = [
    process.env.ACP_PROXY_BOXLITE_E2E_CONFIG?.trim(),
    path.join(process.cwd(), "config.toml"),
    path.join(process.cwd(), "config.json"),
    path.join(process.cwd(), "acp-proxy", "config.toml"),
    path.join(process.cwd(), "acp-proxy", "config.json"),
    path.join(process.cwd(), "acp-proxy", "config.toml.example"),
  ].filter((p): p is string => !!p);

  const cfgPath = candidates.find((p) => existsSync(p)) ?? null;
  if (!cfgPath) return null;

  const raw = await readFile(cfgPath, "utf8");
  const parsed =
    path.extname(cfgPath).toLowerCase() === ".toml"
      ? (parseToml(raw) as any)
      : (JSON.parse(raw) as any);
  const image = parsed?.sandbox?.image;
  return typeof image === "string" && image.trim() ? image.trim() : null;
}

describe("BoxliteSandbox (e2e)", () => {
  const enabled = process.env.ACP_PROXY_BOXLITE_E2E === "1";

  it.runIf(enabled)(
    "bridges stdin/stdout to the guest process",
    async () => {
      const image =
        process.env.ACP_PROXY_BOXLITE_E2E_IMAGE?.trim() ??
        (await pickSandboxImageFromConfig());
      if (!image) {
        throw new Error(
          "请设置 ACP_PROXY_BOXLITE_E2E_IMAGE，或在 config.json 配置 sandbox.boxlite.image",
        );
      }

      const workspace = path.join(
        tmpdir(),
        `acp-proxy-boxlite-e2e-${Date.now()}-${Math.random()}`,
      );
      const sandbox = new BoxliteSandbox({
        log: () => {},
        config: { image, workingDir: "/workspace" },
      });

      if (
        process.platform === "win32" ||
        (process.platform === "darwin" && process.arch !== "arm64")
      ) {
        await expect(
          sandbox.runProcess({
            cwd: workspace,
            command: ["node", "-e", "process.stdin.pipe(process.stdout)"],
            env: {},
          }),
        ).rejects.toThrow(/Windows|Intel|macOS/i);
        return;
      }

      if (process.platform === "linux") {
        const hasKvm = await tryHasKvm();
        if (!hasKvm) {
          throw new Error("缺少 /dev/kvm（Boxlite 需要硬件虚拟化支持）");
        }
      }

      const handle = await sandbox.runProcess({
        cwd: workspace,
        command: ["node", "-e", "process.stdin.pipe(process.stdout)"],
        env: {},
      });

      const writer = handle.stdin.getWriter();
      await writer.write(new TextEncoder().encode("ping\n"));
      await writer.releaseLock();

      const reader = handle.stdout.getReader();
      const out = await readUntil(reader, (t) => t.includes("ping\n"), 10_000);
      await reader.releaseLock();

      await handle.close();
      expect(out).toContain("ping\n");
    },
    30_000,
  );
});
