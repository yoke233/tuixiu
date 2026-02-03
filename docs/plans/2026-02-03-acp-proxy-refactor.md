# ACP Proxy Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一 ACP/Proxy “两条线”命名与事件契约（含 UI WS 事件名），并对 acp-proxy 做一次低风险重构：收敛 run open 编排、加强边界校验、减少超级模块耦合。

**Architecture:** 以“边界先行、内部渐进”的方式改造：先把对外事件命名统一（`acp_update`/`proxy_update` + UI `acp.update`），再把 proxy 的 open/初始化流程抽成幂等的 `ensureRunOpen()`，最后把 `runRuntime.ts` 拆分为若干单一职责模块，并在 WS/JSON-RPC 边界做结构化解析，避免 `any` 导致的隐式崩溃。

**Tech Stack:** TypeScript (Node ESM), ws, vitest；backend(Fastify + ws gateway)；frontend(React + Vite)。

---

## 背景约束（来自需求确认）

1. `prompt_send` 可能早于 `acp_open` 抵达（后端还没收到 proxy 的状态通知就发送了），proxy 必须兼容这种乱序/隐式 open。
2. `agentInputs` 后端保证永远下发，proxy 不需要再做“缺失兜底兼容”，应改为强校验并尽早报错。
3. UI 以 ACP 事件（通过 WS/DB event）驱动渲染；需要将对外事件命名改得更一致，避免 `acp.prompt_update` 这种误导性名字。

---

# Phase A: 命名一致化（对外契约先统一）

### Task 1: 将 UI WS 事件名从 `acp.prompt_update` 改为 `acp.update`

**Files:**
- Modify: `backend/src/websocket/gateway.ts`
- Test: `backend/test/websocket/gateway.test.ts`
- Modify: `backend/scripts/e2e-ws-run.ts`
- Modify: `docs/01_architecture/acp-proxy-backend-contract.md`

**Step 1: 写一个失败测试（先改测试期望）**

在 `backend/test/websocket/gateway.test.ts` 找到对 `acp.prompt_update` 的断言，将期望改成 `acp.update`：

```ts
// before: m.type === "acp.prompt_update"
expect(messages.some((m) => m.type === "acp.update")).toBe(true);
```

**Step 2: 运行测试确认失败**

Run: `pnpm -C backend test -- test/websocket/gateway.test.ts`

Expected: FAIL（因为代码仍发 `acp.prompt_update`）。

**Step 3: 最小实现改名**

在 `backend/src/websocket/gateway.ts` 把广播改成：

```ts
broadcastToClients({
  type: "acp.update",
  run_id: message.run_id,
  prompt_id: message.prompt_id ?? null,
  session_id: message.session_id ?? null,
  update: message.update,
});
```

并把任何日志/辅助函数命名里 “PromptUpdate” 逐步改为 “AcpUpdate”（可分到后续 Task，避免一次改太大）。

**Step 4: 再跑测试确认通过**

Run: `pnpm -C backend test -- test/websocket/gateway.test.ts`

Expected: PASS

**Step 5: 同步 e2e 脚本**

在 `backend/scripts/e2e-ws-run.ts` 把 `acp.prompt_update` 改为 `acp.update`（同样先改断言/日志输出即可）。

**Step 6: 提交**

```powershell
git add backend/src/websocket/gateway.ts backend/test/websocket/gateway.test.ts backend/scripts/e2e-ws-run.ts docs/01_architecture/acp-proxy-backend-contract.md
git commit -m "refactor: rename ws client event acp.prompt_update to acp.update"
```

---

### Task 2: 前端如果存在对 `acp.prompt_update` 的消费，统一改为 `acp.update`

> 说明：当前前端主要消费 `event_added`，但此 Task 作为防回归扫描与补丁，确保未来启用实时流时命名一致。

**Files:**
- Modify (if needed): `frontend/src/pages/issueDetail/useIssueDetailController.ts`
- Modify (if needed): `frontend/src/pages/session/useSessionController.ts`
- Modify (if needed): `frontend/src/hooks/useWsClient.test.tsx`

**Step 1: 全仓搜索**

Run: `rg -n "acp\\.prompt_update" frontend/src`

Expected: ideally no matches；若有则进入 Step 2。

**Step 2: 最小改名**

把匹配到的 `acp.prompt_update` 全改为 `acp.update`。

**Step 3: 跑前端测试**

Run: `pnpm -C frontend test`

Expected: PASS

**Step 4: 提交（若有改动）**

```powershell
git add frontend/src
git commit -m "refactor(frontend): follow backend ws event rename to acp.update"
```

---

# Phase B: proxy “隐式 open”编排收敛 + 边界强校验

### Task 3: 强制 `agentInputs` 必须存在（删掉旧兜底）

**Files:**
- Modify: `acp-proxy/src/handlers/handleAcpOpen.ts`
- Test: `acp-proxy/src/handlers/handlers.test.ts`
- Docs: `docs/01_architecture/acp-proxy-backend-contract.md`

**Step 1: 写失败测试**

在 `acp-proxy/src/handlers/handlers.test.ts` 增加用例：当 `acp_open.init` 不含 `agentInputs` 时，应该：
- `acp_opened.ok === false`
- 发送一条 `proxy_update` 的 `[proxy:error] ... agentInputs missing`（或结构化 error，见后续 Task）

**Step 2: 跑测试确认失败**

Run: `pnpm -C acp-proxy test -- -t "handleAcpOpen.*agentInputs"`

Expected: FAIL

**Step 3: 最小实现**

在 `acp-proxy/src/handlers/handleAcpOpen.ts` 将：
- 过去的 “missing agentInputs -> empty manifest + log” 改为直接 `throw new Error("init.agentInputs missing")`

并确保 catch 分支会：
- `sendUpdate(... { type:"text", text:"[proxy:error] ..." })`
- `ctx.send({ type:"acp_opened", ok:false, error })`

**Step 4: 跑测试确认通过**

Run: `pnpm -C acp-proxy test -- -t "handleAcpOpen.*agentInputs"`

Expected: PASS

**Step 5: 提交**

```powershell
git add acp-proxy/src/handlers/handleAcpOpen.ts acp-proxy/src/handlers/handlers.test.ts docs/01_architecture/acp-proxy-backend-contract.md
git commit -m "refactor(acp-proxy): require agentInputs in acp_open init"
```

---

### Task 4: 引入 `ensureRunOpen()`（幂等）并让 `acp_open` 与 `prompt_send` 复用

**Files:**
- Create: `acp-proxy/src/runs/ensureRunOpen.ts`
- Modify: `acp-proxy/src/handlers/handleAcpOpen.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Test: `acp-proxy/src/handlers/handlers.test.ts`

**Step 1: 写失败测试：prompt_send 先到也能稳定工作**

在 `acp-proxy/src/handlers/handlers.test.ts` 增加用例：
- 不先发 `acp_open`，直接发 `prompt_send`
- 期望：最终 `prompt_result.ok === true`
- 并且 init/initialize 只发生一次（可以通过 harness 记录 `initialize` RPC 调用次数）

**Step 2: 跑测试确认失败（或不稳定）**

Run: `pnpm -C acp-proxy test -- -t "prompt_send.*implicit open"`

Expected: FAIL 或 flaky（取决于现有 harness 能力）

**Step 3: 新增最小的 ensureRunOpen（先包一层，不急着拆 runRuntime）**

创建 `acp-proxy/src/runs/ensureRunOpen.ts`：

```ts
import type { ProxyContext } from "../proxyContext.js";
import type { RunRuntime } from "./runTypes.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";
import { runInitScript, startAgent, ensureInitialized, ensureHostWorkspaceGit } from "./runRuntime.js";
import { parseAgentInputsFromInit } from "./agentInputs.js";
import { applyAgentInputs } from "./applyAgentInputs.js";

export async function ensureRunOpen(
  ctx: ProxyContext,
  run: RunRuntime,
  opts: { init?: AgentInit & { agentInputs?: unknown }; initEnv?: Record<string, string> },
): Promise<void> {
  if (run.agent && run.initialized) return;

  const init = opts.init;
  const initEnv = opts.initEnv;

  // 可选：如果需要 git workspace，先准备 host git（保持与现行为一致）
  if (initEnv && String(initEnv.TUIXIU_REPO_URL ?? "").trim()) {
    await ensureHostWorkspaceGit(ctx, run, initEnv);
  }

  const manifest = parseAgentInputsFromInit({ env: initEnv, agentInputs: (init as any)?.agentInputs } as any);
  if (!manifest) throw new Error("init.agentInputs missing");
  await applyAgentInputs({ ctx, run, manifest });

  if (ctx.sandbox.agentMode === "exec") {
    const ok = await runInitScript(ctx, run, init);
    if (!ok) throw new Error("init_failed");
  }
  await startAgent(ctx, run, init);
  await ensureInitialized(ctx, run);
}
```

> 注意：这里先复用现有 `runRuntime.ts` 的函数，属于“收敛编排”；下一阶段再把 `runRuntime.ts` 拆小。

**Step 4: 修改 handlers 使用 ensureRunOpen**

- `acp-proxy/src/handlers/handleAcpOpen.ts`：用 `ensureRunOpen(...)` 替代重复的 init/start/initialize 逻辑
- `acp-proxy/src/handlers/handlePromptSend.ts`：同样用 `ensureRunOpen(...)`，并保持 `prompt_send` 可隐式 open

**Step 5: 跑测试确认通过**

Run: `pnpm -C acp-proxy test -- -t "handlePromptSend|handleAcpOpen|implicit open"`

Expected: PASS

**Step 6: 提交**

```powershell
git add acp-proxy/src/runs/ensureRunOpen.ts acp-proxy/src/handlers/handleAcpOpen.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/handlers/handlers.test.ts
git commit -m "refactor(acp-proxy): unify implicit open via ensureRunOpen"
```

---

### Task 5: WS 入站消息解析从 `any` 收敛为“最小强校验”

**Files:**
- Create: `acp-proxy/src/types/parseIncoming.ts`
- Modify: `acp-proxy/src/runProxyCli.ts`
- Test: `acp-proxy/src/runProxyCli.test.ts`

**Step 1: 写失败测试：坏 payload 不应触发 handler**

在 `acp-proxy/src/runProxyCli.test.ts` 增加用例：
- 发一个 `prompt_send` 但缺 `prompt_id` / `run_id`
- 期望：不会调用 `handlePromptSend`（可通过注入/spy 或观察发送的 `prompt_result`）

**Step 2: 实现 parseIncoming**

`acp-proxy/src/types/parseIncoming.ts` 提供一组 type-guard/parse 函数（不引入新依赖）：

```ts
import { isRecord } from "../utils/validate.js";
import type { IncomingMessage, PromptSendMessage, AcpOpenMessage } from "../types.js";

export function parsePromptSend(msg: unknown): PromptSendMessage | { error: string } {
  if (!isRecord(msg) || msg.type !== "prompt_send") return { error: "not prompt_send" };
  if (typeof msg.run_id !== "string" || !msg.run_id.trim()) return { error: "run_id missing" };
  if (typeof msg.prompt_id !== "string" || !msg.prompt_id.trim()) return { error: "prompt_id missing" };
  if (!Array.isArray((msg as any).prompt)) return { error: "prompt must be array" };
  return msg as PromptSendMessage;
}
```

（对 `acp_open`、`session_*`、`sandbox_control` 做同样的最小校验）

**Step 3: 修改 runProxyCli 的 dispatch**

在 `acp-proxy/src/runProxyCli.ts` 的 `onMessage`：
- 先 parse；parse 失败则 `log` 并忽略（或回 `prompt_result`/`acp_opened` 的错误，按消息类型决定）
- parse 成功再调用对应 handler

**Step 4: 跑测试确认通过**

Run: `pnpm -C acp-proxy test -- -t "runProxyCli"`

Expected: PASS

**Step 5: 提交**

```powershell
git add acp-proxy/src/types/parseIncoming.ts acp-proxy/src/runProxyCli.ts acp-proxy/src/runProxyCli.test.ts
git commit -m "refactor(acp-proxy): validate incoming ws messages before dispatch"
```

---

# Phase C: `runRuntime.ts` 拆分（降低耦合，提升可维护性）

> 这一步不要“一次性大搬家”。目标是把超级模块拆成 3-5 个稳定模块，仍保持外部 API 不变，并让测试保护住行为。

### Task 6: 提取 update 发送与结构化错误 helper

**Files:**
- Create: `acp-proxy/src/runs/updates.ts`
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/handlers/handleAcpOpen.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Test: `acp-proxy/src/handlers/handlers.test.ts`

**Step 1: 新建 `updates.ts` 并迁移 `sendUpdate/sendSandboxInstanceStatus`**

把 `sendUpdate` 以及常用的 error/text 上报封装为统一函数，例如：

```ts
export function reportProxyError(ctx: ProxyContext, runId: string, message: string) {
  sendUpdate(ctx, runId, { type: "text", text: `[proxy:error] ${message}` });
}
```

**Step 2: 替换 handlers 内的重复 `[proxy:error]` 拼接**

确保错误上报一致、可搜索、结构稳定（后续前端过滤/折叠更容易）。

**Step 3: 跑单测**

Run: `pnpm -C acp-proxy test`

Expected: PASS

**Step 4: 提交**

```powershell
git add acp-proxy/src/runs/updates.ts acp-proxy/src/runs/runRuntime.ts acp-proxy/src/handlers/handleAcpOpen.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/handlers/handlers.test.ts
git commit -m "refactor(acp-proxy): centralize proxy_update helpers"
```

---

### Task 7: 拆出 session 相关（compose/context/session/new/load）

**Files:**
- Create: `acp-proxy/src/runs/session.ts`
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Test: `acp-proxy/src/handlers/handlers.test.ts`

**Step 1: 先移动纯函数（低风险）**

把下列从 `runRuntime.ts` 移到 `session.ts`：
- `composePromptWithContext`
- `shouldRecreateSession`
- `assertPromptBlocksSupported`
- `getPromptCapabilities`

**Step 2: 再移动有副作用但边界清晰的函数**

把 `ensureSessionForPrompt` 移过去（保留签名不变），让 `handlePromptSend` 只关心“调用 session/prompt 并回 prompt_result”。

**Step 3: 跑单测**

Run: `pnpm -C acp-proxy test -- -t "handlePromptSend"`

Expected: PASS

**Step 4: 提交**

```powershell
git add acp-proxy/src/runs/session.ts acp-proxy/src/runs/runRuntime.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/handlers/handlers.test.ts
git commit -m "refactor(acp-proxy): extract session helpers from runRuntime"
```

---

### Task 8: 拆出 init/agent 启动与 bridge（保持外部行为不变）

**Files:**
- Create: `acp-proxy/src/runs/agent.ts`
- Create: `acp-proxy/src/runs/init.ts`
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Test: `acp-proxy/src/runs/runRuntime.test.ts`

**Step 1: 提取 init 执行**

把 `runInitScript` 挪到 `init.ts`，并保持：
- 仍以 `proxy_update` 上报 `[init] start/done`、`init_step`、`init_result`
- 仍做 env allowlist + secrets redact

**Step 2: 提取 agent start/close/ensureInitialized**

把 `startAgent/closeAgent/ensureInitialized/withAuthRetry` 挪到 `agent.ts`（或拆 2 个文件都可以）。

**Step 3: 跑单测**

Run: `pnpm -C acp-proxy test -- -t "runRuntime"`

Expected: PASS

**Step 4: 提交**

```powershell
git add acp-proxy/src/runs/agent.ts acp-proxy/src/runs/init.ts acp-proxy/src/runs/runRuntime.ts acp-proxy/src/runs/runRuntime.test.ts
git commit -m "refactor(acp-proxy): split runRuntime into agent/init modules"
```

---

# 收尾：全量验证与文档同步

### Task 9: 全量测试 + 文档校对

**Files:**
- Modify: `docs/01_architecture/acp-proxy-backend-contract.md`
- Modify: `docs/01_architecture/acp-integration.md`

**Step 1: 全量测试**

Run:

```powershell
pnpm -C acp-proxy test
pnpm -C backend test
pnpm -C frontend test
pnpm lint
pnpm typecheck
```

Expected: 全 PASS

**Step 2: 搜索旧命名确保没有遗留**

Run:

```powershell
rg -n "acp\\.prompt_update" -S .
rg -n "\\bprompt_update\\b|\\bagent_update\\b" -S .
```

Expected: `acp.prompt_update` 全消失；`prompt_update/agent_update` 仅允许出现在“历史归档说明”里（若你希望彻底消失，也一起改掉）。

**Step 3: 更新文档**

- 把 `/ws/client` 的实时事件名写成 `acp.update`
- 把“命名一致化”原则写清楚：proxy<->backend 用下划线 `acp_update/proxy_update`；backend->UI 用点分层 `acp.update`

**Step 4: 提交**

```powershell
git add docs/01_architecture/acp-proxy-backend-contract.md docs/01_architecture/acp-integration.md
git commit -m "docs: update ws event naming and proxy-backend contract"
```

