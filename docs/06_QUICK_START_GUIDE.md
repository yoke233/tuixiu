# 快速开始实施手册

本文档整合了组件实现、部署和测试的关键要点，让你能快速启动 MVP。

---

## 第一步：核心数据库 Schema (30 分钟)

### 创建数据库迁移文件

`database/migrations/001_initial_schema.sql`:

```sql
-- Projects 表
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repo_url VARCHAR(500) NOT NULL,
  scm_type VARCHAR(20) NOT NULL DEFAULT 'gitlab',
  default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
  gitlab_project_id INTEGER UNIQUE,
  gitlab_access_token TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Issues 表
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  acceptance_criteria JSONB DEFAULT '[]',
  constraints JSONB DEFAULT '[]',
  test_requirements TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  assigned_agent_id UUID,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_issues_project_status ON issues(project_id, status);

-- Agents 表
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'local',
  proxy_id VARCHAR(100) UNIQUE,
  capabilities JSONB DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'offline',
  current_load INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 2,
  last_heartbeat TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON agents(status, current_load);

-- Runs 表
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  acp_session_id VARCHAR(100),
  workspace_path VARCHAR(500),
  branch_name VARCHAR(200),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  failure_reason VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_runs_issue ON runs(issue_id);
CREATE INDEX idx_runs_agent_status ON runs(agent_id, status);
CREATE INDEX idx_runs_session ON runs(acp_session_id);

-- Events 表
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,
  type VARCHAR(100) NOT NULL,
  payload JSONB,
  metadata JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_events_run_time ON events(run_id, timestamp DESC);
CREATE INDEX idx_events_type ON events(type);

-- Artifacts 表
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id, type);

-- 初始化一个测试项目
INSERT INTO projects (name, repo_url, gitlab_project_id)
VALUES ('Test Project', 'https://gitlab.example.com/user/test-project', 123);
```

### 执行迁移

```bash
psql -U acp_user -d acp_system -f database/migrations/001_initial_schema.sql
```

---

## 第二步：后端 Orchestrator (1 天)

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

### 完整实现（Golang）

**完整代码见**: `GOLANG_PROXY_IMPLEMENTATION.md`

### 项目结构

```
acp-proxy/
├── cmd/proxy/main.go          # 主入口
├── internal/
│   ├── config/config.go       # 配置管理
│   ├── proxy/proxy.go         # 核心逻辑
│   └── types/types.go         # 类型定义
├── config.json                # 配置文件
├── go.mod                     # 依赖管理
└── README.md
```

### 快速开始

```bash
cd acp-proxy

# 初始化项目
go mod init acp-proxy
go get github.com/gorilla/websocket

# 复制配置文件
cp config.json.example config.json
# 编辑 config.json 填入实际值

# 构建
go build -o acp-proxy cmd/proxy/main.go

# 运行
./acp-proxy
```

### 核心代码片段

```go
// 启动 Proxy
func (p *Proxy) Start() error {
    // 1. 连接 WebSocket
    if err := p.connectWebSocket(); err != nil {
        return err
    }

    // 2. 注册 Agent
    if err := p.registerAgent(); err != nil {
        return err
    }

    // 3. 启动监听 goroutines
    go p.websocketListener()
    go p.heartbeatLoop()

    <-p.stopChan
    return nil
}

// 处理任务
func (p *Proxy) handleExecuteTask(msg WebSocketMessage) {
    // 启动 Agent 子进程
    if p.agentCmd == nil {
        p.startAgentProcess()
    }

    // 转换为 JSON-RPC
    jsonrpcReq := JSONRPCMessage{
        JSONRPC: "2.0",
        Method:  "session/prompt",
        Params: map[string]interface{}{
            "sessionId": msg.SessionID,
            "prompt": []map[string]interface{}{
                {"type": "text", "text": msg.Prompt},
            },
        },
    }

    // 写入 Agent stdin
    p.writeToAgent(jsonrpcReq)
}
```

### 跨平台编译

```bash
# Windows
GOOS=windows GOARCH=amd64 go build -o acp-proxy-windows.exe cmd/proxy/main.go

# macOS
GOOS=darwin GOARCH=amd64 go build -o acp-proxy-macos cmd/proxy/main.go

# Linux
GOOS=linux GOARCH=amd64 go build -o acp-proxy-linux cmd/proxy/main.go
```

---

## 第四步：前端 Web UI (1 天)

### 简化版实现要点

只实现 3 个核心页面:

1. **任务列表** (`src/pages/IssueList.tsx`)
2. **任务详情** (`src/pages/IssueDetail.tsx`)
3. **创建任务** (Modal)

**关键代码**:

```typescript
// src/api/client.ts
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL;

export const api = axios.create({
  baseURL: API_URL,
});

export const createIssue = (data: any) => api.post("/issues", data);

export const getIssues = () => api.get("/issues");

export const getIssue = (id: string) => api.get(`/issues/${id}`);

export const getRunEvents = (runId: string) => api.get(`/runs/${runId}/events`);
```

---

## 第五步：端到端测试 (半天)

### 测试用例

```bash
# 1. 创建 Issue
curl -X POST http://localhost:3000/api/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "修复 README 拼写错误",
    "description": "README 中有多个拼写错误",
    "acceptance_criteria": [
      "修复所有拼写错误",
      "提交应该只包含 README.md 的修改"
    ]
  }'

# 2. 查看 Proxy 日志
# 应该看到: "Executing task: run-xxx"

# 3. 查看 Codex 输出（在 Proxy 日志中）
# 应该看到: "Analyzing..."

# 4. 等待 MR 创建（约 2-5 分钟）

# 5. 在 GitLab 上验证 MR 存在

# 6. CI 运行并通过

# 7. 手动合并 MR

# 8. 验证任务状态变为 Done
curl http://localhost:3000/api/issues/{issue_id}
# 应该返回: {"issue": {"status": "done", ...}}
```

---

## 常见问题排查

### 1. Agent 连接失败

**检查**:

```bash
# Orchestrator 是否运行
curl http://localhost:3000/api/issues

# WebSocket 是否可访问
wscat -c ws://localhost:3000/ws/agent
```

### 2. Codex 无输出

**检查**:

```bash
# 手动启动 Codex 测试
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | codex --acp

# 查看 Proxy 日志
tail -f proxy.log
```

### 3. MR 未创建

**检查**:

```bash
# GitLab Token 是否正确
curl -H "PRIVATE-TOKEN: $GITLAB_ACCESS_TOKEN" \
  $GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_ID

# Proxy 是否检测到 "branch created"
grep -i "branch created" proxy.log
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
