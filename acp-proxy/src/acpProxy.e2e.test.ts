import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

function waitFor<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs),
    ),
  ]);
}

async function pickSandboxImageFromConfig(): Promise<string | null> {
  const candidates = [
    process.env.ACP_PROXY_E2E_CONFIG?.trim(),
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

function waitForMessageTypeOrExit(opts: {
  ws: WebSocket;
  proc: ReturnType<typeof spawn>;
  type: string;
  timeoutMs: number;
  getProcLogs: () => string;
}): Promise<any> {
  return waitFor(
    new Promise((resolve, reject) => {
      const onMessage = (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg?.type === opts.type) {
            cleanup();
            resolve(msg);
          }
        } catch {}
      };
      const onError = (err: any) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("orchestrator socket closed"));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `acp-proxy exited (code=${code} signal=${signal})\n${opts.getProcLogs()}`,
          ),
        );
      };
      const cleanup = () => {
        opts.ws.off("message", onMessage);
        opts.ws.off("error", onError);
        opts.ws.off("close", onClose);
        opts.proc.off("exit", onExit);
      };
      opts.ws.on("message", onMessage);
      opts.ws.on("error", onError);
      opts.ws.on("close", onClose);
      opts.proc.on("exit", onExit);
    }),
    opts.timeoutMs,
  );
}

describe("acp-proxy (e2e)", () => {
  const enabled = process.env.ACP_PROXY_E2E === "1";

  it.runIf(enabled)(
    "connects to orchestrator, registers, opens run via sandbox",
    async () => {
      const image =
        process.env.ACP_PROXY_E2E_IMAGE?.trim() ??
        (await pickSandboxImageFromConfig());
      if (!image) {
        throw new Error(
          "请设置 ACP_PROXY_E2E_IMAGE，或在 config.json 配置 sandbox.boxlite.image",
        );
      }

      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await waitFor(
        new Promise<void>((resolve, reject) => {
          wss.once("listening", () => resolve());
          wss.once("error", (err) => reject(err));
        }),
        10_000,
      );
      const addr = wss.address();
      if (!addr || typeof addr === "string")
        throw new Error("wss address invalid");
      const orchestratorUrl = `ws://127.0.0.1:${addr.port}`;

      const cfgPath = path.join(
        tmpdir(),
        `acp-proxy-e2e-${Date.now()}-${Math.random()}.json`,
      );
      const workspace = path.join(
        tmpdir(),
        `acp-proxy-e2e-ws-${Date.now()}-${Math.random()}`,
      );
      await writeFile(
        cfgPath,
        JSON.stringify(
          {
            orchestrator_url: orchestratorUrl,
            auth_token: "",
            cwd: workspace,
            sandbox: {
              terminalEnabled: false,
              provider: "container_oci",
              runtime: "docker",
              image,
              workingDir: "/workspace",
            },
            agent: { id: `acp-proxy-e2e-${Date.now()}`, max_concurrent: 1 },
            heartbeat_seconds: 1,
            mock_mode: false,
            agent_command: [
              "node",
              "-e",
              'process.stdout.write(\'{"jsonrpc":"2.0","method":"ready"}\\n\'); setTimeout(()=>{}, 60000)',
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const entryCandidates = [
        path.join(process.cwd(), "src", "index.ts"),
        path.join(process.cwd(), "acp-proxy", "src", "index.ts"),
      ];
      const entry = entryCandidates.find((p) => existsSync(p));
      if (!entry) throw new Error("acp-proxy entry not found");

      const proc = spawn(
        process.execPath,
        ["--import", "tsx", entry, "--config", cfgPath],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      let procOut = "";
      let procErr = "";
      proc.stdout?.on("data", (d) => {
        procOut += d.toString();
        if (procOut.length > 20_000) procOut = procOut.slice(-20_000);
      });
      proc.stderr?.on("data", (d) => {
        procErr += d.toString();
        if (procErr.length > 20_000) procErr = procErr.slice(-20_000);
      });
      const getProcLogs = () => `${procOut}\n${procErr}`;

      try {
        const ws = await waitFor(
          new Promise<WebSocket>((resolve, reject) => {
            wss.once("connection", (sock) => resolve(sock));
            wss.once("error", (err) => reject(err));
          }),
          10_000,
        );
        const first = await waitForMessageTypeOrExit({
          ws,
          proc,
          type: "register_agent",
          timeoutMs: 10_000,
          getProcLogs,
        });
        expect(first.agent?.id).toBeTruthy();

        const runId = "run-e2e-1";
        const openedP = waitForMessageTypeOrExit({
          ws,
          proc,
          type: "acp_opened",
          timeoutMs: 30_000,
          getProcLogs,
        });
        ws.send(
          JSON.stringify({ type: "acp_open", run_id: runId, cwd: workspace }),
        );

        const opened = await openedP;
        expect(opened.run_id).toBe(runId);

        const useDocker =
          process.platform === "win32" ||
          (process.platform === "darwin" && process.arch === "x64");

        if (useDocker) {
          const runtime = "docker";
          const check = spawnSync(
            runtime,
            ["version", "--format", "{{.Server.Version}}"],
            { stdio: "ignore", windowsHide: true, timeout: 2000 },
          );
          const dockerOk = check.status === 0;
          if (dockerOk) {
            expect(opened.ok).toBe(true);
          } else {
            expect(opened.ok).toBe(false);
            expect(String(opened.error ?? "")).toMatch(
              /docker|podman|nerdctl|container/i,
            );
          }
        } else {
          expect(opened.ok).toBe(true);
        }

        ws.close();
      } finally {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        await new Promise<void>((resolve) =>
          proc.once("exit", () => resolve()),
        ).catch(() => {});
        await new Promise<void>((resolve) => wss.close(() => resolve())).catch(
          () => {},
        );
      }
    },
    60_000,
  );
});
