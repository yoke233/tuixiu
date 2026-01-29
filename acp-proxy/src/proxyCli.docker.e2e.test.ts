import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

async function spawnCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => (stdout += String(d ?? "")));
  child.stderr?.on("data", (d) => (stderr += String(d ?? "")));

  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (c) => resolve(c ?? null));
    child.once("error", () => resolve(1));
  });

  return { code, stdout, stderr };
}

async function dockerRmForce(name: string): Promise<void> {
  await spawnCapture("docker", ["rm", "-f", name]).catch(() => {});
}

async function waitForWssListening(wss: WebSocketServer, timeoutMs: number): Promise<void> {
  try {
    const addr = wss.address();
    if (addr) return;
  } catch {
    // ignore
  }

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", (err) => reject(err));
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`timeout waiting for WebSocketServer listening (${timeoutMs}ms)`);
    }),
  ]);
}

async function waitForWsConnection(
  connected: Promise<WebSocket>,
  timeoutMs: number,
): Promise<WebSocket> {
  return await Promise.race([
    connected,
    delay(timeoutMs).then(() => {
      throw new Error(`timeout waiting for ws connection (${timeoutMs}ms)`);
    }),
  ]);
}

function takeMessage<T extends Record<string, unknown>>(
  messages: unknown[],
  predicate: (m: any) => m is T,
): T | null {
  const idx = messages.findIndex((m) => predicate(m));
  if (idx < 0) return null;
  const [picked] = messages.splice(idx, 1);
  return (picked as any) ?? null;
}

async function waitForMessage<T extends Record<string, unknown>>(
  messages: unknown[],
  predicate: (m: any) => m is T,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = takeMessage(messages, predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe("proxyCli (docker e2e)", () => {
  const enabled = process.env.ACP_PROXY_DOCKER_E2E === "1";

  it.runIf(enabled)(
    "container_oci entrypoint: init + JSON-RPC bridge works",
    async () => {
      const dockerVersion = await spawnCapture("docker", ["version"]);
      if (dockerVersion.code !== 0) {
        throw new Error(
          `docker 不可用：${`${dockerVersion.stdout}\n${dockerVersion.stderr}`.trim()}`,
        );
      }

      const image = "tuixiu-codex-acp:local";

      const agentCode = [
        'const readline = require("node:readline");',
        "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
        'function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }',
        'rl.on("line", (line) => {',
        "  let msg;",
        "  try { msg = JSON.parse(line); } catch { return; }",
        '  if (!msg || msg.jsonrpc !== "2.0") return;',
        "  const id = msg.id;",
        '  const method = String(msg.method || "");',
        "  const params = msg.params || {};",
        "  if (id === undefined || id === null) return;",
        '  if (method === "initialize") {',
        '    const pv = typeof params.protocolVersion === "number" ? params.protocolVersion : 1;',
        "    send({",
        '      jsonrpc: "2.0",',
        "      id,",
        "      result: {",
        "        protocolVersion: pv,",
        '        agentInfo: { name: "mock-acp-agent", version: "0.0.0" },',
        "        authMethods: [],",
        "        agentCapabilities: {",
        "          loadSession: false,",
        "          mcpCapabilities: { http: false, sse: false },",
        "          promptCapabilities: { audio: false, embeddedContext: false, image: false },",
        "        },",
        "      },",
        "    });",
        "    return;",
        "  }",
        '  if (method === "session/new") {',
        '    send({ jsonrpc: "2.0", id, result: { sessionId: "s1" } });',
        "    return;",
        "  }",
        '  if (method === "session/prompt") {',
        '    const sessionId = String(params.sessionId || "s1");',
        "    const blocks = Array.isArray(params.prompt) ? params.prompt : [];",
        "    const text = blocks",
        '      .map((b) => (b && b.type === "text" ? String(b.text || "") : ""))',
        '      .join("\\n");',
        '    const answer = /1\\s*\\+\\s*1/.test(text) ? "2" : "ok";',
        "    send({",
        '      jsonrpc: "2.0",',
        '      method: "session/update",',
        "      params: {",
        "        sessionId,",
        "        update: {",
        '          sessionUpdate: "agent_message_chunk",',
        '          content: { type: "text", text: answer },',
        "        },",
        "      },",
        "    });",
        '    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });',
        "    return;",
        "  }",
        '  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });',
        "});",
      ].join("\n");

      const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
      const tsxCli = path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs");

      const runId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const instanceName = `tuixiu-run-${runId}`;

      const tmp = await mkdtemp(path.join(tmpdir(), "acp-proxy-docker-e2e-"));

      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const messages: unknown[] = [];
      let agentWs: WebSocket | null = null;
      let resolveConnected: ((ws: WebSocket) => void) | null = null;
      const connected = new Promise<WebSocket>((resolve) => {
        resolveConnected = resolve;
      });

      wss.on("connection", (ws) => {
        if (!agentWs) {
          agentWs = ws;
          resolveConnected?.(ws);
          resolveConnected = null;
        }
        ws.on("message", (data) => {
          try {
            messages.push(JSON.parse(data.toString()));
          } catch {
            // ignore
          }
        });
      });

      let proxyProc: ReturnType<typeof spawn> | null = null;
      let proxyStdout = "";
      let proxyStderr = "";

      const cleanup = async () => {
        try {
          agentWs?.close();
        } catch {}
        try {
          wss.close();
        } catch {}
        try {
          if (proxyProc && proxyProc.exitCode === null) {
            proxyProc.kill();
          }
        } catch {}
        await dockerRmForce(instanceName);
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      };

      await dockerRmForce(instanceName);

      try {
        await waitForWssListening(wss, 20_000);
        const port = (wss.address() as any).port as number;
        const orchestratorUrl = `ws://127.0.0.1:${port}`;

        const configPath = path.join(tmp, "config.toml");
        const configToml = [
          `orchestrator_url = ${JSON.stringify(orchestratorUrl)}`,
          'auth_token = ""',
          "heartbeat_seconds = 1",
          "mock_mode = false",
          `agent_command = ${JSON.stringify(["node", "-e", agentCode])}`,
          "",
          "[sandbox]",
          "terminalEnabled = true",
          'provider = "container_oci"',
          'runtime = "docker"',
          `image = ${JSON.stringify(image)}`,
          'workingDir = "/workspace"',
          "",
          "[agent]",
          'id = "e2e-agent"',
          'name = "e2e-agent"',
          "max_concurrent = 1",
        ].join("\n");
        await writeFile(configPath, configToml, "utf8");

        const proxyEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") proxyEnv[k] = v;
        }
        for (const k of Object.keys(proxyEnv)) {
          if (k.startsWith("ACP_PROXY_")) delete proxyEnv[k];
        }

        proxyProc = spawn(process.execPath, [tsxCli, "src/index.ts", "--config", configPath], {
          cwd: pkgRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: proxyEnv,
          windowsHide: true,
        });
        proxyProc.stdout?.setEncoding("utf8");
        proxyProc.stderr?.setEncoding("utf8");
        proxyProc.stdout?.on("data", (d) => (proxyStdout += String(d ?? "")));
        proxyProc.stderr?.on("data", (d) => (proxyStderr += String(d ?? "")));

        agentWs = await waitForWsConnection(connected, 20_000);

        const reg = await waitForMessage(
          messages,
          (m): m is { type: "register_agent" } =>
            !!m && typeof m === "object" && (m as any).type === "register_agent",
          20_000,
        );
        expect(reg.type).toBe("register_agent");

        agentWs.send(
          JSON.stringify({
            type: "acp_open",
            run_id: runId,
            instance_name: instanceName,
            init: {
              script: 'echo "INIT_ENV=$TEST_ENV" >&2',
              timeout_seconds: 60,
              env: { TEST_ENV: "ok" },
            },
          }),
        );

        const initLine = await waitForMessage(
          messages,
          (m): m is { type: "agent_update"; run_id: string; content: any } =>
            !!m &&
            typeof m === "object" &&
            (m as any).type === "agent_update" &&
            String((m as any).run_id ?? "") === runId &&
            typeof (m as any).content?.text === "string" &&
            String((m as any).content.text).includes("INIT_ENV=ok"),
          90_000,
        );
        expect(String(initLine.content.text)).toContain("INIT_ENV=ok");

        const opened = await waitForMessage(
          messages,
          (m): m is { type: "acp_opened"; run_id: string; ok: boolean; error?: string } =>
            !!m &&
            typeof m === "object" &&
            (m as any).type === "acp_opened" &&
            String((m as any).run_id ?? "") === runId,
          90_000,
        );
        if (!opened.ok) {
          const initResult = takeMessage(
            messages,
            (m): m is { type: "agent_update"; run_id: string; content: any } =>
              !!m &&
              typeof m === "object" &&
              (m as any).type === "agent_update" &&
              String((m as any).run_id ?? "") === runId &&
              (m as any).content?.type === "init_result",
          );
          throw new Error(
            `acp_opened failed: ${opened.error ?? "unknown"}\n` +
              `init_result: ${initResult ? JSON.stringify(initResult.content) : "missing"}`,
          );
        }
        expect(opened.ok).toBe(true);

        agentWs.send(
          JSON.stringify({
            type: "prompt_send",
            run_id: runId,
            prompt_id: "p1",
            prompt: [{ type: "text", text: "1+1=?" }],
          }),
        );

        const chunk = await waitForMessage(
          messages,
          (m): m is { type: "prompt_update"; run_id: string; prompt_id: string; update: any } =>
            !!m &&
            typeof m === "object" &&
            (m as any).type === "prompt_update" &&
            String((m as any).run_id ?? "") === runId &&
            String((m as any).prompt_id ?? "") === "p1" &&
            (m as any).update?.sessionUpdate === "agent_message_chunk" &&
            (m as any).update?.content?.type === "text" &&
            typeof (m as any).update?.content?.text === "string",
          30_000,
        );
        expect(chunk.update.content.text).toContain("2");

        const promptRes = await waitForMessage(
          messages,
          (m): m is {
            type: "prompt_result";
            run_id: string;
            prompt_id: string;
            ok: boolean;
            session_id?: string | null;
            stop_reason?: string | null;
          } =>
            !!m &&
            typeof m === "object" &&
            (m as any).type === "prompt_result" &&
            String((m as any).run_id ?? "") === runId &&
            String((m as any).prompt_id ?? "") === "p1" &&
            typeof (m as any).ok === "boolean",
          30_000,
        );
        expect(promptRes.ok).toBe(true);
        expect(promptRes.session_id).toBe("s1");
        expect(promptRes.stop_reason).toBe("end_turn");

        agentWs.send(
          JSON.stringify({
            type: "sandbox_control",
            run_id: runId,
            instance_name: instanceName,
            action: "remove",
          }),
        );
        const removed = await waitForMessage(
          messages,
          (m): m is { type: "sandbox_control_result"; ok: boolean; status?: string } =>
            !!m && typeof m === "object" && (m as any).type === "sandbox_control_result",
          30_000,
        );
        expect(removed.ok).toBe(true);
        expect(removed.status).toBe("missing");
      } catch (err) {
        const extra = [
          `proxy stdout:\n${proxyStdout.trim()}`,
          `proxy stderr:\n${proxyStderr.trim()}`,
        ].join("\n\n");
        throw new Error(`${String(err)}\n\n${extra}`);
      } finally {
        await cleanup();
      }
    },
    150_000,
  );
});
