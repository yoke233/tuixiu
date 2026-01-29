import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  CliRuntime,
  assertCliAvailable,
  rmForce,
  type ContainerCli,
} from "../src/sandbox/cliRuntime.js"; // ← 按你的实际路径改

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

function readLines(stream: NodeJS.ReadableStream, onLine: (l: string) => void) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    buf += String(d ?? "");
    while (true) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = get();
    if (v !== undefined) return v;
    await delay(25);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

function takeOne<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  const idx = arr.findIndex(pred);
  if (idx < 0) return undefined;
  const [v] = arr.splice(idx, 1);
  return v;
}

describe("container_oci (CliRuntime/CRI e2e)", () => {
  const enabled = process.env.ACP_PROXY_DOCKER_E2E === "1";

  it.runIf(enabled)(
    "init + JSON-RPC over stdio works via CLI (write file + exec node)",
    async () => {
      const cli = (process.env.ACP_PROXY_CONTAINER_CLI || "docker").trim() as ContainerCli;
      const image = (process.env.ACP_PROXY_E2E_IMAGE || "tuixiu-codex-acp:local").trim();

      await assertCliAvailable(cli);

      const name = `e2e-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
      await rmForce(cli, name).catch(() => {});

      const agentCode = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.jsonrpc !== "2.0") return;

  const id = msg.id;
  const method = String(msg.method || "");
  const params = msg.params || {};

  if (method === "initialize") {
    const pv = typeof params.protocolVersion === "number" ? params.protocolVersion : 1;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: pv,
        agentInfo: { name: "mock-acp-agent", version: "0.0.0" },
        authMethods: [],
        agentCapabilities: { loadSession: false }
      }
    });
    return;
  }

  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "s1" } });
    return;
  }

  if (method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: String(params.sessionId || "s1"),
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "2" }
        }
      }
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
});
`;

      // ✅ 关键：写入文件，再 exec node，这样 node stdin 才是容器 stdin（可接收后续 JSON-RPC）
      const script = `
set -e
mkdir -p /workspace
cd /workspace

echo "INIT_ENV=$TEST_ENV" >&2

cat > /tmp/agent.js <<'EOF'
${agentCode}
EOF

exec node /tmp/agent.js
`;

      const runtime = new CliRuntime(cli);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const jsonMsgs: JsonRpc[] = [];

      const run = runtime.runInteractive({
        name,
        image,
        env: { TEST_ENV: "ok" },
        cmd: ["sh", "-lc", script], // node:20-slim 里一定有 sh
      });

      const exitPromise = new Promise<number | null>((resolve) => {
        run.proc.once("exit", (c) => resolve(c ?? null));
        run.proc.once("error", () => resolve(1));
      });

      const cleanup = async () => {
        try {
          run.kill();
        } catch {}
        await rmForce(cli, name).catch(() => {});
      };

      try {
        readLines(run.proc.stdout, (l) => {
          stdoutLines.push(l);
          try {
            const o = JSON.parse(l);
            if (o?.jsonrpc === "2.0") jsonMsgs.push(o);
          } catch {}
        });
        readLines(run.proc.stderr, (l) => stderrLines.push(l));

        // 等 init 或 提前退出（二选一），避免“盲等超时”
        await Promise.race([
          (async () => {
            await waitFor(() => stderrLines.find((l) => l.includes("INIT_ENV=ok")), 20_000);
          })(),
          (async () => {
            const code = await exitPromise;
            throw new Error(
              `container exited early: code=${code}\n` +
                `stderr(last 80):\n${stderrLines.slice(-80).join("\n")}\n` +
                `stdout(last 80):\n${stdoutLines.slice(-80).join("\n")}`,
            );
          })(),
        ]);

        // initialize
        run.proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1 },
          }) + "\n",
        );

        const initRes = await waitFor(
          () => takeOne(jsonMsgs, (m) => m.id === 1 && !!m.result),
          20_000,
        );
        expect((initRes as any).result.agentInfo.name).toBe("mock-acp-agent");

        // session/new
        run.proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: {},
          }) + "\n",
        );

        const sRes = await waitFor(
          () =>
            takeOne(
              jsonMsgs,
              (m) => m.id === 2 && typeof (m as any).result?.sessionId === "string",
            ),
          20_000,
        );
        expect((sRes as any).result.sessionId).toBe("s1");

        // prompt -> chunk
        run.proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: { sessionId: "s1", prompt: [{ type: "text", text: "1+1=?" }] },
          }) + "\n",
        );

        const chunk = await waitFor(
          () =>
            takeOne(
              jsonMsgs,
              (m) =>
                (m as any).method === "session/update" &&
                (m as any).params?.update?.sessionUpdate === "agent_message_chunk",
            ),
          20_000,
        );
        expect(String((chunk as any).params.update.content.text)).toContain("2");
      } catch (e) {
        throw new Error(
          `${String(e)}\n\n` +
            `cli=${cli} image=${image} name=${name}\n\n` +
            `stderr(last 80):\n${stderrLines.slice(-80).join("\n")}\n\n` +
            `stdout(last 80):\n${stdoutLines.slice(-80).join("\n")}`,
        );
      } finally {
        await cleanup();
      }
    },
    120_000,
  );
});
