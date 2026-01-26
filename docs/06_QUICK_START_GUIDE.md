# 快速开始实施手册

本文档整合了组件实现、部署和测试的关键要点，让你能快速启动 MVP。

---

## 第一步：启动数据库 + Prisma 迁移（10 分钟）

本仓库数据库层使用 **Prisma ORM**（见 `backend/prisma/schema.prisma`），迁移通过 `prisma migrate` 自动生成/执行，**不需要手写 SQL**。

### 1) 启动 PostgreSQL（Docker Compose）

```powershell
docker compose up -d
```

### 2) 配置后端环境变量

```powershell
Copy-Item backend/.env.example backend/.env
```

### 3) 执行迁移（创建/更新表结构）

```powershell
cd backend
pnpm prisma:migrate
```

---

## 第二步：后端 Orchestrator (1 天)

### 启动后端（Fastify + Prisma）

仓库已在 `backend/` 中实现 Orchestrator（REST API + WebSocket Gateway + Prisma ORM），直接启动即可：

```powershell
cd backend
pnpm dev
```

验证（Windows/pwsh 注意使用 `curl.exe` 并关闭代理）：

```powershell
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/projects
```

> 下方的“关键代码片段”属于文档示例，真实实现以仓库代码为准。

### 最小可用代码结构

```
backend/
├── src/
│   ├── index.ts              # 入口
│   ├── config.ts             # 配置
│   ├── db.ts                 # 数据库连接
│   ├── routes/
│   │   ├── issues.ts         # Issue API
│   │   ├── runs.ts           # Run API
│   │   ├── agents.ts         # Agent API
│   │   └── webhooks.ts       # GitLab Webhook
│   ├── services/
│   │   ├── scheduler.ts      # 任务调度器
│   │   └── gitlab.ts         # GitLab API 客户端
│   └── websocket/
│       ├── gateway.ts        # WebSocket 服务器
│       └── handlers.ts       # 消息处理器
└── package.json
```

### 关键代码片段

#### `src/index.ts` (入口)

```typescript
import fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import dotenv from "dotenv";

import issueRoutes from "./routes/issues";
import runRoutes from "./routes/runs";
import agentRoutes from "./routes/agents";
import webhookRoutes from "./routes/webhooks";
import { initWebSocketGateway } from "./websocket/gateway";

dotenv.config();

const server = fastify({ logger: true });

// 中间件
server.register(cors);
server.register(websocket);

// 路由
server.register(issueRoutes, { prefix: "/api/issues" });
server.register(runRoutes, { prefix: "/api/runs" });
server.register(agentRoutes, { prefix: "/api/agents" });
server.register(webhookRoutes, { prefix: "/webhooks" });

// WebSocket
initWebSocketGateway(server);

// 启动
const start = async () => {
  try {
    await server.listen({
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
    });
    console.log("Server running on http://localhost:3000");
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
```

#### `src/db.ts` (数据库连接)

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export default pool;
```

#### `src/routes/issues.ts` (Issue API)

```typescript
import { FastifyInstance } from "fastify";
import { query } from "../db";
import { scheduleTask } from "../services/scheduler";

export default async function (server: FastifyInstance) {
  // 创建 Issue
  server.post("/", async (request, reply) => {
    const { title, description, acceptance_criteria } = request.body as any;

    const result = await query(
      `INSERT INTO issues (title, description, acceptance_criteria, project_id) 
       VALUES ($1, $2, $3, (SELECT id FROM projects LIMIT 1))
       RETURNING *`,
      [title, description, JSON.stringify(acceptance_criteria)],
    );

    const issue = result.rows[0];

    // 自动调度任务
    await scheduleTask(issue.id);

    return { success: true, issue };
  });

  // 列表
  server.get("/", async (request, reply) => {
    const result = await query("SELECT * FROM issues ORDER BY created_at DESC");
    return { issues: result.rows };
  });

  // 详情
  server.get("/:id", async (request, reply) => {
    const { id } = request.params as any;
    const result = await query("SELECT * FROM issues WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Issue not found" });
    }

    return { issue: result.rows[0] };
  });
}
```

#### `src/services/scheduler.ts` (调度器)

```typescript
import { query } from "../db";
import { v4 as uuidv4 } from "uuid";
import { sendTaskToAgent } from "../websocket/gateway";

export async function scheduleTask(issueId: string) {
  // 1. 查询 Issue
  const issueResult = await query("SELECT * FROM issues WHERE id = $1", [
    issueId,
  ]);
  const issue = issueResult.rows[0];

  // 2. 选择可用的 Agent
  const agentResult = await query(
    `SELECT * FROM agents 
     WHERE status = 'online' 
     AND current_load < max_concurrent_runs 
     LIMIT 1`,
  );

  if (agentResult.rows.length === 0) {
    throw new Error("No available agent");
  }

  const agent = agentResult.rows[0];

  // 3. 创建 Run
  const sessionId = `sess-${uuidv4()}`;
  const branchName = `acp/issue-${issue.id}/run-${uuidv4().slice(0, 8)}`;

  const runResult = await query(
    `INSERT INTO runs (issue_id, agent_id, acp_session_id, branch_name, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [issue.id, agent.id, sessionId, branchName],
  );

  const run = runResult.rows[0];

  // 4. 发送任务给 Agent
  const prompt = `
任务: ${issue.title}

描述: ${issue.description}

验收标准:
${issue.acceptance_criteria.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n")}

请在分支 ${branchName} 上完成开发，并创建 Merge Request。
  `;

  await sendTaskToAgent(agent.id, {
    run_id: run.id,
    session_id: sessionId,
    prompt,
  });

  // 5. 更新状态
  await query(`UPDATE runs SET status = 'running' WHERE id = $1`, [run.id]);
  await query(
    `UPDATE agents SET current_load = current_load + 1 WHERE id = $1`,
    [agent.id],
  );

  console.log(`✅ Task scheduled: Run ${run.id} → Agent ${agent.id}`);

  return run;
}
```

#### `src/websocket/gateway.ts` (WebSocket 网关)

```typescript
import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";

const agentConnections = new Map<string, WebSocket>();

export function initWebSocketGateway(server: FastifyInstance) {
  server.get("/ws/agent", { websocket: true }, (connection, req) => {
    console.log("Agent connected");

    let agentId: string | null = null;

    connection.socket.on("message", async (data) => {
      const message = JSON.parse(data.toString());

      if (message.type === "register_agent") {
        agentId = message.agent.id;
        agentConnections.set(agentId, connection.socket);

        // 更新数据库
        await query(
          `INSERT INTO agents (id, name, proxy_id, capabilities, status, max_concurrent_runs)
           VALUES ($1, $2, $3, $4, 'online', $5)
           ON CONFLICT (proxy_id) DO UPDATE SET status = 'online', last_heartbeat = NOW()`,
          [
            agentId,
            message.agent.name,
            agentId,
            JSON.stringify(message.agent.capabilities),
            message.agent.max_concurrent,
          ],
        );

        connection.socket.send(
          JSON.stringify({
            type: "register_ack",
            success: true,
          }),
        );

        console.log(`✅ Agent registered: ${agentId}`);
      } else if (message.type === "heartbeat") {
        await query(`UPDATE agents SET last_heartbeat = NOW() WHERE id = $1`, [
          message.agent_id,
        ]);
      } else if (message.type === "agent_update") {
        // 保存事件
        await query(
          `INSERT INTO events (run_id, source, type, payload)
           VALUES ($1, 'acp', 'acp.update', $2)`,
          [message.run_id, JSON.stringify(message.content)],
        );

        // TODO: 推送给 Web UI
      } else if (message.type === "branch_created") {
        await handleBranchCreated(message);
      }
    });

    connection.socket.on("close", () => {
      if (agentId) {
        agentConnections.delete(agentId);
        query(`UPDATE agents SET status = 'offline' WHERE id = $1`, [agentId]);
        console.log(`Agent disconnected: ${agentId}`);
      }
    });
  });
}

export async function sendTaskToAgent(agentId: string, task: any) {
  const ws = agentConnections.get(agentId);
  if (!ws) {
    throw new Error("Agent not connected");
  }

  ws.send(
    JSON.stringify({
      type: "execute_task",
      ...task,
    }),
  );
}

async function handleBranchCreated(message: any) {
  // 调用 GitLab API 创建 MR（见 GitLab 集成文档）
  // ...
}
```

---

## 第三步：ACP Proxy (半天)

### 完整实现（Node/TypeScript）

Proxy 已切换为 Node/TypeScript 版本（基于 `@agentclientprotocol/sdk`），用于更完整地跟进 ACP 能力（如 `session/load`、Session Modes 等）。

> 旧版 Go Proxy 已从仓库移除，以下以 Node/TypeScript 版本为准。

### 项目结构

```
acp-proxy/
├── src/index.ts               # 主入口（WS ↔ ACP）
├── src/acpBridge.ts           # ACP SDK 桥接（spawn + ndjson）
├── src/config.ts              # 配置管理
├── src/semaphore.ts           # 并发控制
├── config.json                # 配置文件
└── package.json               # 依赖管理
```

### 快速开始（Windows/pwsh）

```powershell
cd acp-proxy
Copy-Item config.json.example config.json
notepad config.json
pnpm dev
```

> 说明：若本机 `codex` CLI 不支持 `--acp`，Proxy 默认使用 `npx --yes @zed-industries/codex-acp` 启动 ACP Agent。

---

## 第四步：前端 Web UI (1 天)

### 快速启动（React + Vite）

前端已在 `frontend/` 中实现（Issue 列表 / 详情 / 创建 + WS 实时刷新），直接启动即可：

```powershell
cd frontend
pnpm dev
```

默认地址：`http://localhost:5173`

---

## 第五步：端到端测试 (半天)

### 测试用例

```powershell
# 0) 先创建 Project（数据库里没有 Project 时创建 Issue 会返回 NO_PROJECT）
curl.exe --noproxy 127.0.0.1 -X POST http://localhost:3000/api/projects `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"Demo\",\"repoUrl\":\"https://example.com/repo.git\"}'

# 可选：如需在 Web 端“一键创建 MR/PR”，请在创建 Project 时配置 SCM 信息
# - GitLab: scmType=gitlab + gitlabProjectId + gitlabAccessToken
# - GitHub: scmType=github + githubAccessToken
# 例如：
# curl.exe --noproxy 127.0.0.1 -X POST http://localhost:3000/api/projects `
#   -H "Content-Type: application/json" `
#   -d '{\"name\":\"Demo\",\"repoUrl\":\"https://github.com/octo-org/octo-repo.git\",\"scmType\":\"github\",\"defaultBranch\":\"main\",\"githubAccessToken\":\"ghp_xxx\"}'

# 1) 创建 Issue（有在线 Agent 时会自动创建 Run 并下发 execute_task）
curl.exe --noproxy 127.0.0.1 -X POST http://localhost:3000/api/issues `
  -H "Content-Type: application/json" `
  -d '{\"title\":\"修复 README 拼写错误\",\"description\":\"README 中有多个拼写错误\",\"acceptanceCriteria\":[\"修复所有拼写错误\"]}'

# 2) 查看 Agent 列表（Proxy 连接后应为 online）
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/agents

# 3) 查询 Issue / Run / Events
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/issues/{issue_id}
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/runs/{run_id}
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/runs/{run_id}/events
```

---

## 常见问题排查

### 1. Agent 连接失败

**检查**:

```powershell
# Orchestrator 是否运行
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/issues

# WebSocket 是否可访问（无需全局安装）
npx --yes wscat -c ws://localhost:3000/ws/agent
```

### 2. Codex 无输出

**检查**:

```powershell
# 手动测试 ACP Agent（若本机 codex CLI 不支持 --acp）
'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' | npx --yes @zed-industries/codex-acp

# Proxy 默认打印到控制台；如你把输出重定向到文件：
Get-Content -Wait .\\proxy.log
```

### 3. MR 未创建

**检查**:

```powershell
# GitLab Token 是否正确（后续 GitLab 集成时使用）
curl.exe -H "PRIVATE-TOKEN: $env:GITLAB_ACCESS_TOKEN" "$env:GITLAB_URL/api/v4/projects/$env:GITLAB_PROJECT_ID"

# Proxy 是否检测到 "branch created"（如你把输出重定向到文件）
Select-String -Path .\\proxy.log -Pattern "branch created" -CaseSensitive:$false
```

---

## 下一步优化

MVP 运行后，按以下顺序优化:

1. **Web UI 实时更新**（WebSocket 推送）
2. **Review 闭环**（评论聚合 + 返工）
3. **失败诊断**（自动收集日志）
4. **重试/接管**（一键操作）
5. **监控告警**（Grafana Dashboard）

---

**祝顺利！🚀**
