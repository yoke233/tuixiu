import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

async function once<T>(emitter: any, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    emitter.once(event, (arg: any) => resolve(arg));
    emitter.once("error", (err: any) => reject(err));
  });
}

async function main() {
  const image = process.env.ACP_PROXY_SMOKE_IMAGE?.trim() ?? "alpine:latest";
  const runId = `run-smoke-${Date.now()}`;

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("wss address invalid");
  const orchestratorUrl = `ws://127.0.0.1:${addr.port}`;

  const cfgPath = path.join(tmpdir(), `acp-proxy-smoke-boxlite-${Date.now()}-${Math.random()}.json`);
  const workspace = path.join(tmpdir(), `acp-proxy-smoke-boxlite-ws-${Date.now()}-${Math.random()}`);
  await writeFile(
    cfgPath,
    JSON.stringify(
      {
        orchestrator_url: orchestratorUrl,
        auth_token: "",
        cwd: workspace,
        sandbox: {
          terminalEnabled: false,
          provider: "boxlite_oci",
          image,
          workingDir: "/workspace",
        },
        agent: { id: `acp-proxy-smoke-boxlite-${Date.now()}`, max_concurrent: 1 },
        heartbeat_seconds: 1,
        mock_mode: false,
        agent_command: ["sh", "-c", "printf '{\"jsonrpc\":\"2.0\",\"method\":\"ready\"}\\n'; sleep 120"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--config", cfgPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => process.stdout.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));

  const sock: any = await once(wss, "connection");

  const regRaw = await once<any>(sock, "message");
  const regText = regRaw.toString();
  console.log("[smoke] orchestrator received:", regText);

  sock.send(JSON.stringify({ type: "acp_open", run_id: runId, cwd: workspace }));

  for (;;) {
    const raw = await once<any>(sock, "message");
    const text = raw.toString();
    console.log("[smoke] orchestrator received:", text);
    const msg = JSON.parse(text);
    if (msg?.type === "acp_opened" && msg?.run_id === runId) {
      if (!msg.ok) throw new Error(`acp_opened not ok: ${msg.error ?? "unknown"}`);
      break;
    }
  }

  sock.send(JSON.stringify({ type: "acp_close", run_id: runId }));

  try {
    sock.close();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));

  try {
    child.kill();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
