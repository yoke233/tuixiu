import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function takeMessage(messages, predicate) {
  const idx = messages.findIndex((m) => predicate(m));
  if (idx < 0) return null;
  const picked = messages.splice(idx, 1)[0];
  return picked ?? null;
}

async function waitForMessage(messages, predicate, timeoutMs, exitRef) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitRef.info) {
      throw new Error("proxy exited early with code " + String(exitRef.info.code));
    }
    const found = takeMessage(messages, predicate);
    if (found) return found;
    await delay(50);
  }
  throw new Error("timeout after " + String(timeoutMs) + "ms");
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const configPath = path.join(repoRoot, "config.toml");
  const configRaw = await fs.readFile(configPath, "utf8");

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (!port) throw new Error("failed to allocate WebSocket port");

  const orchestratorUrl = "ws://127.0.0.1:" + String(port);

  const lines = configRaw.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("orchestrator_url")) {
      lines[i] = "orchestrator_url = " + JSON.stringify(orchestratorUrl);
      found = true;
      break;
    }
  }
  if (!found) {
    lines.unshift("orchestrator_url = " + JSON.stringify(orchestratorUrl));
  }
  const nextConfig = lines.join("\n");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-proxy-index-e2e-"));
  const tmpConfigPath = path.join(tmpDir, "config.toml");
  await fs.writeFile(tmpConfigPath, nextConfig, "utf8");

  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

  const proxyEnv = { ...process.env };
  for (const key of Object.keys(proxyEnv)) {
    if (key.startsWith("ACP_PROXY_")) delete proxyEnv[key];
  }

  const proxyProc = spawn(process.execPath, [tsxCli, "src/index.ts", "--config", tmpConfigPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: proxyEnv,
    windowsHide: true,
  });

  let proxyStdout = "";
  let proxyStderr = "";
  proxyProc.stdout.setEncoding("utf8");
  proxyProc.stderr.setEncoding("utf8");
  proxyProc.stdout.on("data", (d) => (proxyStdout += String(d ?? "")));
  proxyProc.stderr.on("data", (d) => (proxyStderr += String(d ?? "")));

  const exitRef = { info: null };
  proxyProc.once("exit", (code, signal) => {
    exitRef.info = { code: code ?? null, signal: signal ?? null };
  });
  proxyProc.once("error", () => {
    exitRef.info = { code: 1, signal: null };
  });

  const messages = [];
  let agentWs = null;
  let resolveConnected = null;
  const connected = new Promise((resolve) => {
    resolveConnected = resolve;
  });

  wss.on("connection", (ws) => {
    if (!agentWs) {
      agentWs = ws;
      resolveConnected(ws);
      resolveConnected = null;
    }
    ws.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (err) {
        void err;
      }
    });
  });

  const runId = "run-" + String(Date.now());
  const instanceName = "tuixiu-run-" + runId;

  const cleanup = async () => {
    try {
      if (agentWs) agentWs.close();
    } catch (err) {
      void err;
    }
    try {
      wss.close();
    } catch (err) {
      void err;
    }
    try {
      if (proxyProc.exitCode === null) proxyProc.kill();
    } catch (err) {
      void err;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  };

  try {
    await Promise.race([
      connected,
      delay(20000).then(() => {
        throw new Error("timeout waiting for acp-proxy connection");
      }),
    ]);

    await waitForMessage(
      messages,
      (m) => m && typeof m === "object" && m.type === "register_agent",
      20000,
      exitRef,
    );

    agentWs.send(
      JSON.stringify({
        type: "acp_open",
        run_id: runId,
        instance_name: instanceName,
      }),
    );

    const opened = await waitForMessage(
      messages,
      (m) =>
        m &&
        typeof m === "object" &&
        m.type === "acp_opened" &&
        String(m.run_id || "") === runId,
      240000,
      exitRef,
    );

    if (!opened.ok) {
      throw new Error("acp_opened failed: " + String(opened.error || "unknown"));
    }

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
      (m) =>
        m &&
        typeof m === "object" &&
        m.type === "prompt_update" &&
        String(m.run_id || "") === runId &&
        String(m.prompt_id || "") === "p1" &&
        m.update &&
        m.update.sessionUpdate === "agent_message_chunk" &&
        m.update.content &&
        m.update.content.type === "text" &&
        typeof m.update.content.text === "string",
      240000,
      exitRef,
    );

    const answer = String(chunk.update.content.text || "").trim();

    const promptRes = await waitForMessage(
      messages,
      (m) =>
        m &&
        typeof m === "object" &&
        m.type === "prompt_result" &&
        String(m.run_id || "") === runId &&
        String(m.prompt_id || "") === "p1" &&
        typeof m.ok === "boolean",
      240000,
      exitRef,
    );

    agentWs.send(
      JSON.stringify({
        type: "sandbox_control",
        run_id: runId,
        instance_name: instanceName,
        action: "remove",
      }),
    );

    await waitForMessage(
      messages,
      (m) => m && typeof m === "object" && m.type === "sandbox_control_result",
      60000,
      exitRef,
    ).catch((err) => {
      void err;
    });

    console.log("ACP reply:", answer);
    console.log("prompt_result:", JSON.stringify(promptRes));
  } catch (err) {
    const extra = [
      "proxy stdout:\n" + proxyStdout.trim(),
      "proxy stderr:\n" + proxyStderr.trim(),
    ].join("\n\n");
    throw new Error(String(err) + "\n\n" + extra);
  } finally {
    await cleanup();
  }

  if (exitRef.info && exitRef.info.code !== 0) {
    throw new Error("acp-proxy exited early with code " + String(exitRef.info.code));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
