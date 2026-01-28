import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

async function main() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("wss address invalid");
  const orchestratorUrl = `ws://127.0.0.1:${addr.port}`;

  const cfgPath = path.join(tmpdir(), `acp-proxy-smoke-${Date.now()}-${Math.random()}.json`);
  const workspace = path.join(tmpdir(), `acp-proxy-smoke-ws-${Date.now()}-${Math.random()}`);
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
          image: "alpine:latest",
          workingDir: "/workspace",
        },
        agent: { id: `acp-proxy-smoke-${Date.now()}`, max_concurrent: 1 },
        heartbeat_seconds: 1,
        mock_mode: false,
        agent_command: ["npx", "--yes", "@zed-industries/codex-acp"],
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

  const sock = await new Promise<any>((resolve, reject) => {
    wss.once("connection", (ws) => resolve(ws));
    wss.once("error", (err) => reject(err));
  });

  const reg = await new Promise<string>((resolve, reject) => {
    sock.once("message", (data: any) => resolve(data.toString()));
    sock.once("error", (err: any) => reject(err));
  });

  console.log("[smoke] orchestrator received:", reg);

  sock.close();
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
