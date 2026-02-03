/**
 * 端到端小脚本：创建一个 Issue -> 启动 Run -> 连接 /ws/client 打印该 Run 的 WS 事件。
 *
 * 运行方式（在仓库根目录）：
 *   $env:TUIXIU_TOKEN = "<你的JWT>"
 *   pnpm -C backend tsx scripts/e2e-ws-run.ts
 *
 * 可选环境变量：
 *   TUIXIU_API_BASE=http://localhost:3000
 *   TUIXIU_WS_BASE=ws://localhost:3000
 *   TUIXIU_TIMEOUT_MS=720000   # 默认 12 分钟
 *   TUIXIU_POLL_MS=2500        # 轮询 run 状态间隔
 */

import WebSocket from "ws";

type ApiOk<T> = { success: true; data: T };
type ApiErr = { success: false; error: { code: string; message: string; details?: string }; data?: unknown };
type ApiResult<T> = ApiOk<T> | ApiErr;

function mustEnv(name: string): string {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

function getEnv(name: string, fallback: string): string {
  const v = String(process.env[name] ?? "").trim();
  return v || fallback;
}

function now() {
  return new Date().toISOString();
}

function redactToken(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "***");
    return u.toString();
  } catch {
    return url.replace(/token=[^&]+/g, "token=***");
  }
}

async function apiJson<T>(apiBase: string, token: string, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const url = new URL(path, apiBase).toString();
  const headers = new Headers(init?.headers ?? undefined);
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg =
      (json && typeof json === "object" && typeof (json as any).error?.message === "string"
        ? (json as any).error.message
        : text || res.statusText) || `HTTP ${res.status}`;
    return { success: false, error: { code: `HTTP_${res.status}`, message: msg }, data: json ?? text };
  }

  if (!json || typeof json !== "object" || typeof json.success !== "boolean") {
    return { success: false, error: { code: "BAD_RESPONSE", message: "返回不是预期 JSON" }, data: text };
  }
  return json as ApiResult<T>;
}

function summarizePromptUpdate(update: any): string {
  if (!update || typeof update !== "object") return "";
  const sessionUpdate =
    typeof (update as any).sessionUpdate === "string" && (update as any).sessionUpdate.trim()
      ? String((update as any).sessionUpdate).trim()
      : "";
  const content = (update as any).content;
  const contentType =
    content && typeof content === "object" && typeof (content as any).type === "string"
      ? String((content as any).type)
      : "";
  const textLen =
    content && typeof content === "object" && typeof (content as any).text === "string"
      ? (content as any).text.length
      : null;
  const parts = [];
  if (sessionUpdate) parts.push(`sessionUpdate=${sessionUpdate}`);
  if (contentType) parts.push(`content.type=${contentType}`);
  if (typeof textLen === "number") parts.push(`textLen=${textLen}`);
  return parts.join(" ");
}

function summarizeEvent(event: any): string {
  if (!event || typeof event !== "object") return "";
  const t = typeof (event as any).type === "string" ? (event as any).type : "";
  const src = typeof (event as any).source === "string" ? (event as any).source : "";
  const ts = typeof (event as any).timestamp === "string" ? (event as any).timestamp : "";

  const payload = (event as any).payload;
  const payloadType = payload && typeof payload === "object" && typeof (payload as any).type === "string"
    ? String((payload as any).type)
    : "";
  let extra = "";
  if (payloadType === "session_update") {
    const upd = (payload as any).update;
    extra = summarizePromptUpdate(upd);
  } else if (payloadType) {
    extra = `payload.type=${payloadType}`;
  }

  return [t && `type=${t}`, src && `source=${src}`, ts && `ts=${ts}`, extra].filter(Boolean).join(" ");
}

function parseRunIdFromWsMessage(msg: any): string | null {
  if (!msg || typeof msg !== "object") return null;
  if (typeof (msg as any).run_id === "string") return String((msg as any).run_id);
  const ev = (msg as any).event;
  if (ev && typeof ev === "object" && typeof (ev as any).runId === "string") return String((ev as any).runId);
  return null;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const token = mustEnv("TUIXIU_TOKEN");
  const apiBase = getEnv("TUIXIU_API_BASE", "http://localhost:3000");
  const wsBase = getEnv("TUIXIU_WS_BASE", "ws://localhost:3000");
  const timeoutMs = Number(getEnv("TUIXIU_TIMEOUT_MS", String(12 * 60 * 1000)));
  const pollMs = Number(getEnv("TUIXIU_POLL_MS", "2500"));

  const wsUrl = new URL("/ws/client", wsBase);
  wsUrl.searchParams.set("token", token);

  console.log(`[${now()}] WS 连接中: ${redactToken(wsUrl.toString())}`);
  const ws = new WebSocket(wsUrl.toString());

  let runId: string | null = null;
  let issueId: string | null = null;
  let lastMsgAt = Date.now();

  const stop = async (code = 0) => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };

  process.on("SIGINT", () => {
    console.log(`\n[${now()}] 收到 SIGINT，退出`);
    void stop(130);
  });

  ws.on("open", async () => {
    console.log(`[${now()}] WS 已连接`);

    const title = `e2e ws run ${new Date().toISOString()}`;
    const created = await apiJson<{ issue: { id: string } }>(apiBase, token, "/api/issues", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    if (!created.success) {
      console.error(`[${now()}] 创建 Issue 失败: ${created.error.code} ${created.error.message}`);
      console.error(created.error.details ?? "");
      await stop(1);
      return;
    }
    issueId = created.data.issue.id;
    console.log(`[${now()}] Issue 已创建: ${issueId} title=${JSON.stringify(title)}`);

    const started = await apiJson<{ run: { id: string; status: string } }>(apiBase, token, `/api/issues/${issueId}/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!started.success) {
      console.error(`[${now()}] 启动 Run 失败: ${started.error.code} ${started.error.message}`);
      if (started.error.details) console.error(started.error.details);
      await stop(1);
      return;
    }
    runId = started.data.run.id;
    console.log(`[${now()}] Run 已启动: ${runId} status=${started.data.run.status}`);

    const startedAt = Date.now();
    let lastStatus = started.data.run.status;

    // 轮询 run 状态，配合 WS 观察“卡住无输出”的情况。
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(pollMs);
      if (!runId) break;

      const r = await apiJson<{ run: { id: string; status: string; errorMessage?: string | null } }>(
        apiBase,
        token,
        `/api/runs/${runId}`,
      );
      if (!r.success) {
        console.error(`[${now()}] 拉取 Run 状态失败: ${r.error.code} ${r.error.message}`);
        continue;
      }
      const status = r.data.run.status;
      const errMsg = r.data.run.errorMessage ?? null;
      if (status !== lastStatus) {
        console.log(`[${now()}] Run 状态变化: ${lastStatus} -> ${status}${errMsg ? ` err=${JSON.stringify(errMsg)}` : ""}`);
        lastStatus = status;
      }

      if (["completed", "failed", "cancelled"].includes(status)) {
        console.log(`[${now()}] Run 已结束: status=${status}${errMsg ? ` err=${JSON.stringify(errMsg)}` : ""}`);
        break;
      }

      // 没消息就给个提示，方便定位“101 成功但无事件/无 IO”。
      const idleMs = Date.now() - lastMsgAt;
      if (idleMs > 30_000) {
        console.log(`[${now()}] 提示: 已 ${Math.round(idleMs / 1000)}s 未收到 WS 消息（run_id=${runId}）`);
        lastMsgAt = Date.now(); // 防止刷屏
      }
    }

    if (runId) {
      const ev = await apiJson<{ events: any[] }>(apiBase, token, `/api/runs/${runId}/events?limit=50`);
      if (ev.success) {
        console.log(`[${now()}] 拉取 Run events (最近 50 条): ${ev.data.events.length} 条`);
        for (const e of ev.data.events.slice().reverse()) {
          console.log(`[${now()}] HTTP event: ${summarizeEvent(e)}`);
        }
      } else {
        console.error(`[${now()}] 拉取 Run events 失败: ${ev.error.code} ${ev.error.message}`);
      }
    }

    await stop(0);
  });

  ws.on("message", (data) => {
    lastMsgAt = Date.now();

    const raw = typeof data === "string" ? data : data.toString();
    let msg: any = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      // ignore non-json
      return;
    }

    // 没拿到 runId 前先不刷屏（避免后台其它 run 的广播干扰）。
    if (!runId) return;

    const msgRunId = parseRunIdFromWsMessage(msg);
    if (msgRunId !== runId) return;

    const type = typeof msg.type === "string" ? msg.type : "unknown";
    if (type === "event_added") {
      console.log(`[${now()}] WS event_added: ${summarizeEvent(msg.event)}`);
      return;
    }

    if (type === "acp.prompt_update") {
      const updSummary = summarizePromptUpdate(msg.update);
      console.log(`[${now()}] WS acp.prompt_update: ${updSummary}`);
      return;
    }

    console.log(`[${now()}] WS ${type}: run_id=${runId}`);
  });

  ws.on("close", (code, reason) => {
    const r = reason ? reason.toString() : "";
    console.log(`[${now()}] WS 已关闭: code=${code}${r ? ` reason=${JSON.stringify(r)}` : ""}`);
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] WS 错误: ${err instanceof Error ? err.message : String(err)}`);
  });
}

void main().catch((err) => {
  console.error(`[${now()}] 脚本异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
