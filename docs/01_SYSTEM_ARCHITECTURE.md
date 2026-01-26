# 系统架构文档

## 1. 整体架构

### 1.1 三层架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 1: 用户界面层                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  任务看板    │  │  任务详情    │  │  Agent 监控      │  │
│  │  (List View) │  │  (Detail)    │  │  (Dashboard)     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │             │
│         └─────────────────┴───────────────────┘             │
│                           │                                 │
│                   HTTP/WebSocket API                        │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                    Layer 2: 业务逻辑层                        │
│                   (Orchestrator 后端)                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                  核心模块                               │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │ │
│  │  │任务调度 │  │状态管理 │  │事件聚合 │  │产物跟踪 │  │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                 │
│  ┌────────────────────────┴─────────────────────────────┐  │
│  │                  数据访问层                           │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │  │
│  │  │Issue DAO│  │Run DAO  │  │Agent DAO│  │Event DAO│ │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │  │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                 │
│  ┌────────────────────────┴─────────────────────────────┐  │
│  │                  外部集成层                           │  │
│  │  ┌─────────────┐          ┌─────────────────────┐   │  │
│  │  │ GitLab API  │          │ WebSocket Gateway   │   │  │
│  │  │  Connector  │          │  (Agent Connection) │   │  │
│  │  └─────────────┘          └─────────────────────┘   │  │
│  └────────────────────────────────────────────────────────┘ │
└───────────┬─────────────────────────┬───────────────────────┘
            │                         │
            │ GitLab                  │ WebSocket
            │ Webhooks                │ (bidirectional)
            │                         │
┌───────────┴─────────┐    ┌──────────┴──────────────────────┐
│  External Service   │    │   Layer 3: Agent 执行层          │
│  (GitLab Server)    │    │   (ACP Proxy - 本地部署)         │
│                     │    │  ┌───────────────────────────┐  │
│  - Merge Requests   │    │  │  协议转换引擎              │  │
│  - CI Pipelines     │    │  │  (WebSocket ↔ stdio)      │  │
│  - Webhooks         │    │  └───────┬───────────────────┘  │
└─────────────────────┘    │          │ stdio (JSON-RPC)     │
                           │          │                       │
                           │  ┌───────┴───────────────────┐  │
                           │  │  Agent 进程管理器          │  │
                           │  │  (Process Manager)        │  │
                           │  └───────┬───────────────────┘  │
                           │          │ subprocess           │
                           │          ↓                       │
                           │  ┌───────────────────────────┐  │
                           │  │  Codex CLI Agent          │  │
                           │  │  (子进程运行)             │  │
                           │  └───────────────────────────┘  │
                           └─────────────────────────────────┘
```

### 1.2 数据流图

#### 流程 1: 创建任务到执行

```
[用户]
   │
   │ 1. POST /api/issues
   ↓
[Web UI]
   │
   │ 2. HTTP Request
   ↓
[Orchestrator]
   │
   │ 3. Save to DB
   ↓
[PostgreSQL]
   │
   │ 4. Create Run
   ↓
[Orchestrator - Scheduler]
   │
   │ 5. Select Agent (first online)
   ↓
[Orchestrator - WebSocket Gateway]
   │
   │ 6. Send Task Message
   │    {type: "execute_task", run_id: "...", prompt: "..."}
   ↓
[ACP Proxy] (via WebSocket)
   │
   │ 7. Convert to JSON-RPC
   ↓
[Codex CLI] (via stdin)
   │
   │ 8. Process and Execute
   ↓
[Codex outputs to stdout]
   │
   │ 9. Parse JSON-RPC Response
   ↓
[ACP Proxy]
   │
   │ 10. Send to Orchestrator
   │     {type: "agent_update", run_id: "...", content: "..."}
   ↓
[Orchestrator - WebSocket Gateway]
   │
   │ 11. Save Event
   ↓
[PostgreSQL]
   │
   │ 12. Push to Web UI
   ↓
[Web UI] (via WebSocket)
   │
   │ 13. Update Timeline
   ↓
[用户看到实时进度]
```

#### 流程 2: Agent 创建 PR

```
[Codex CLI]
   │
   │ 1. git push origin branch
   ↓
[GitLab Server]
   │
   │ 2. Codex outputs: "Branch created: xxx"
   ↓
[ACP Proxy] (parse stdout)
   │
   │ 3. Send to Orchestrator
   │    {type: "branch_created", branch: "..."}
   ↓
[Orchestrator]
   │
   │ 4. Call GitLab API
   │    POST /projects/:id/merge_requests
   ↓
[GitLab Server]
   │
   │ 5. PR Created
   ↓
[Orchestrator]
   │
   │ 6. Save Artifact (type: 'pr')
   │ 7. Create Event (type: 'git.pr.created')
   │ 8. Update Run status → 'waiting_ci'
   ↓
[PostgreSQL]
   │
   │ 9. Push to Web UI
   ↓
[Web UI]
   │
   │ 10. Display PR Link
   ↓
[用户点击跳转到 GitLab]
```

#### 流程 3: CI 结果回写

```
[GitLab CI]
   │
   │ 1. Pipeline Started
   ↓
[GitLab Webhook]
   │
   │ 2. POST /webhooks/gitlab
   │    {event: "pipeline", status: "running", ...}
   ↓
[Orchestrator - Webhook Handler]
   │
   │ 3. Validate Secret Token
   │ 4. Parse Event
   ↓
[Orchestrator]
   │
   │ 5. Create Event (type: 'ci.check.started')
   ↓
[PostgreSQL]
   │
   │ ... CI 运行 ...
   │
[GitLab CI]
   │
   │ 6. Pipeline Success/Failure
   ↓
[GitLab Webhook]
   │
   │ 7. POST /webhooks/gitlab
   │    {event: "pipeline", status: "success", ...}
   ↓
[Orchestrator - Webhook Handler]
   │
   │ 8. Update Run status
   │ 9. Create Event (type: 'ci.check.passed')
   ↓
[PostgreSQL]
   │
   │ 10. Push to Web UI
   ↓
[Web UI]
   │
   │ 11. Show Green Check ✅
   ↓
[用户可以合并 PR]
```

---

## 2. 核心组件详解

### 2.1 Orchestrator (后端)

#### 职责

1. **任务管理**: Issue CRUD、Run 生命周期管理
2. **调度引擎**: 选择合适的 Agent 执行任务
3. **状态管理**: 维护 Run 的状态机
4. **事件聚合**: 收集并存储来自 Agent、GitLab、CI 的事件
5. **API 服务**: 对外提供 RESTful API 和 WebSocket 接口
6. **GitLab 集成**: 调用 GitLab API、接收 Webhook

#### 关键模块

##### 模块 1: API Layer

```
路由定义:
  POST   /api/issues          - 创建任务
  GET    /api/issues          - 列表
  GET    /api/issues/:id      - 详情
  PATCH  /api/issues/:id      - 更新
  DELETE /api/issues/:id      - 删除

  POST   /api/runs            - 创建执行实例
  GET    /api/runs/:id        - 查询状态
  GET    /api/runs/:id/events - 获取事件时间线
  POST   /api/runs/:id/cancel - 取消执行

  POST   /api/agents/register - Agent 注册
  GET    /api/agents          - 列表
  POST   /api/agents/:id/heartbeat - 心跳

  POST   /webhooks/gitlab     - GitLab Webhook 入口

  WebSocket:
    /ws/agent     - Agent 连接
    /ws/client    - Web UI 连接
```

##### 模块 2: Scheduler (调度器)

```
核心逻辑:
  1. 监听 Issue 创建事件
  2. 创建 Run 记录
  3. 选择 Agent:
     - 获取所有在线 Agent
     - 过滤掉负载已满的
     - 选择第一个（MVP 简单策略）
  4. 通过 WebSocket 发送任务
  5. 更新 Run 状态 → 'pending'

伪代码:
  async function scheduleTask(issue_id) {
    const issue = await Issue.findById(issue_id);
    const run = await Run.create({
      issue_id: issue.id,
      status: 'pending'
    });

    const agents = await Agent.findAllOnline();
    const availableAgents = agents.filter(a => a.current_load < a.max_concurrent);

    if (availableAgents.length === 0) {
      throw new Error("No available agent");
    }

    const selectedAgent = availableAgents[0];

    await sendTaskToAgent(selectedAgent.id, {
      run_id: run.id,
      prompt: generatePrompt(issue)
    });

    await run.update({ agent_id: selectedAgent.id, status: 'running' });
  }
```

##### 模块 3: State Machine (状态机)

```
Run 状态定义:
  - pending         (已创建，等待 Agent)
  - running         (Agent 正在执行)
  - waiting_ci      (等待 CI 检查)
  - completed       (成功完成)
  - failed          (执行失败)
  - cancelled       (用户取消)

状态转换规则:
  pending → running         (Agent 开始执行)
  running → waiting_ci      (PR 已创建)
  waiting_ci → completed    (CI 通过 + 用户合并 PR)
  running → failed          (Agent 报错 or 超时)
  * → cancelled             (用户主动取消)

事件触发状态变更:
  - agent_started        → pending → running
  - pr_created           → running → waiting_ci
  - ci_passed            → (不改变状态，只记录)
  - pr_merged            → waiting_ci → completed
  - agent_error          → running → failed
  - timeout              → running → failed
```

##### 模块 4: Event Aggregator (事件聚合器)

```
事件来源:
  1. Agent (via WebSocket)
  2. GitLab (via Webhook)
  3. System (内部触发)

事件存储:
  每个事件存储为 Event 记录:
    - run_id
    - timestamp
    - source (acp / gitlab / system)
    - type (见后文枚举)
    - payload (JSON)

查询优化:
  - 索引: (run_id, timestamp)
  - 分页: 每页 50 条
  - 实时推送: 通过 WebSocket 推送给 Web UI
```

##### 模块 5: GitLab Connector

```
功能:
  1. API 调用:
     - 创建 PR
     - 查询 PR 状态
     - 查询 CI Pipeline

  2. Webhook 处理:
     - 验证 Secret Token
     - 解析事件类型
     - 触发状态变更

配置:
  - gitlab_url: "https://gitlab.example.com"
  - access_token: "glpat-xxxxxxxxxxxx"
  - webhook_secret: "random-secret-string"

关键 API 调用:
  创建 PR（GitLab Merge Request）:
    POST /api/v4/projects/:project_id/merge_requests
    Body: {
      source_branch: "acp/issue-123/run-456",
      target_branch: "main",
      title: "[ACP] Fix user login bug",
      description: "Issue #123\n\n验收标准:\n- ...",
      remove_source_branch: true
    }

  查询 Pipeline:
    GET /api/v4/projects/:project_id/pipelines/:pipeline_id
    Response: {
      id: 12345,
      status: "success" | "failed" | "running",
      ...
    }
```

---

### 2.2 ACP Proxy (本地代理)

#### 职责

1. **连接管理**: 维护与 Orchestrator 的 WebSocket 长连接
2. **协议转换**: WebSocket 消息 ↔ JSON-RPC over stdio
3. **进程管理**: 启动/停止/重启 Codex CLI 子进程
4. **心跳保活**: 定期发送心跳，报告在线状态
5. **日志记录**: 本地记录所有交互日志

#### 关键模块

##### 模块 1: WebSocket Client

```
连接流程:
  1. 启动时自动连接到 Orchestrator
  2. 发送注册消息:
     {
       "type": "register_agent",
       "agent_id": "codex-local-1",
       "capabilities": ["javascript", "python"],
       "max_concurrent": 2
     }
  3. 接收确认:
     {
       "type": "register_ack",
       "success": true
     }

重连策略:
  - 连接断开后，使用指数退避重连
  - 延迟: 5s → 10s → 20s → 40s (最大 60s)
  - 最多重试: 无限次（除非用户主动停止）

心跳:
  - 每 30 秒发送一次:
    {
      "type": "heartbeat",
      "agent_id": "codex-local-1",
      "current_load": 1,
      "uptime": 3600
    }
```

##### 模块 2: Protocol Bridge (协议桥接)

```
WebSocket → JSON-RPC:
  输入 (from Orchestrator):
    {
      "type": "execute_task",
      "run_id": "run-123",
      "session_id": "sess-abc",
      "prompt": "Implement user login feature"
    }

  转换为 (写入 Codex stdin):
    {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "session/prompt",
      "params": {
        "sessionId": "sess-abc",
        "prompt": [
          {
            "type": "text",
            "text": "Implement user login feature"
          }
        ]
      }
    }

JSON-RPC → WebSocket:
  输入 (from Codex stdout):
    {
      "jsonrpc": "2.0",
      "method": "session/update",
      "params": {
        "sessionId": "sess-abc",
        "update": {
          "type": "agentMessage",
          "content": [
            {
              "type": "text",
              "text": "I'm analyzing the auth module..."
            }
          ]
        }
      }
    }

  转换为 (发送到 Orchestrator):
    {
      "type": "agent_update",
      "run_id": "run-123",
      "content": {
        "text": "I'm analyzing the auth module...",
        "timestamp": "2026-01-25T10:30:00Z"
      }
    }
```

##### 模块 3: Process Manager (进程管理器)

```
启动 Codex:
  cmd := exec.Command("codex", "--acp")

  stdin, _ := cmd.StdinPipe()
  stdout, _ := cmd.StdoutPipe()
  stderr, _ := cmd.StderrPipe()

  cmd.Start()

监听输出:
  - 创建 goroutine 读取 stdout
  - 使用 bufio.Scanner 按行读取（JSON-RPC 以换行符分隔）
  - 解析为 JSON 对象
  - 转发到 Orchestrator

错误处理:
  - 如果 Codex 进程意外退出（exit code != 0）
    → 记录错误日志
    → 通知 Orchestrator (agent_error)

  - 如果 Codex 15 分钟无输出
    → 发送 SIGTERM (cmd.Process.Signal(syscall.SIGTERM))
    → 等待 5 秒
    → 仍未退出则 SIGKILL (cmd.Process.Kill())
    → 通知 Orchestrator (timeout)
```

---

### 2.3 Web UI (前端)

#### 技术栈

- React 18 + TypeScript
- Ant Design 5（组件库）
- Axios（HTTP 客户端）
- Socket.io-client（WebSocket）
- React Router（路由）

#### 页面结构

##### 页面 1: 任务列表 (`/issues`)

```
布局:
  ┌────────────────────────────────────────┐
  │  Header: Logo + "创建任务" 按钮        │
  ├────────────────────────────────────────┤
  │  Table:                                │
  │  ┌──────┬──────────┬────────┬────────┐ │
  │  │ ID   │ 标题     │ 状态   │ Agent  │ │
  │  ├──────┼──────────┼────────┼────────┤ │
  │  │ #123 │ 登录功能 │ 运行中 │ codex-1│ │
  │  │ #122 │ 文档修复 │ 完成   │ codex-1│ │
  │  │ ...  │ ...      │ ...    │ ...    │ │
  │  └──────┴──────────┴────────┴────────┘ │
  └────────────────────────────────────────┘

交互:
  - 点击行 → 跳转到详情页
  - 点击"创建任务" → 弹出表单 Modal
```

##### 页面 2: 任务详情 (`/issues/:id`)

```
布局:
  ┌────────────────────────────────────────┐
  │  Header: 返回 | #123 登录功能 | [运行中]│
  ├────────────────────────────────────────┤
  │  Left Panel (60%):                     │
  │  ┌──────────────────────────────────┐  │
  │  │  任务描述                         │  │
  │  │  验收标准: 1. ... 2. ...         │  │
  │  ├──────────────────────────────────┤  │
  │  │  时间线 (实时滚动):              │  │
  │  │  10:30 Agent 开始执行             │  │
  │  │  10:31 正在分析代码...            │  │
  │  │  10:32 创建分支: acp/123/run-456 │  │
  │  │  10:35 PR 已创建: !456           │  │
  │  │  10:40 CI 运行中...               │  │
  │  └──────────────────────────────────┘  │
  │                                        │
  │  Right Panel (40%):                    │
  │  ┌──────────────────────────────────┐  │
  │  │  产物:                            │  │
  │  │  - PR: !456 [查看] ✅             │  │
  │  │  - 分支: acp/123/run-456         │  │
  │  ├──────────────────────────────────┤  │
  │  │  Agent 信息:                      │  │
  │  │  - ID: codex-local-1             │  │
  │  │  - 状态: 在线                     │  │
  │  ├──────────────────────────────────┤  │
  │  │  操作:                            │  │
  │  │  [取消任务] [查看日志]           │  │
  │  └──────────────────────────────────┘  │
  └────────────────────────────────────────┘

实时更新:
  - 连接 WebSocket: /ws/client?run_id=run-456
  - 收到消息后追加到时间线
  - 自动滚动到底部
```

##### 页面 3: Agent 监控 (`/agents`)

```
布局:
  ┌────────────────────────────────────────┐
  │  Header: Agent 监控                    │
  ├────────────────────────────────────────┤
  │  Cards Grid:                           │
  │  ┌───────────────┐  ┌───────────────┐ │
  │  │ codex-local-1 │  │ codex-local-2 │ │
  │  │ 🟢 在线       │  │ 🔴 离线       │ │
  │  │ 负载: 1/2     │  │ 负载: 0/2     │ │
  │  │ 当前任务:     │  │ 空闲          │ │
  │  │ - #123 运行中 │  │               │ │
  │  └───────────────┘  └───────────────┘ │
  └────────────────────────────────────────┘

数据源:
  - HTTP: GET /api/agents (每 5 秒轮询)
  - 或 WebSocket: /ws/agents (实时推送)
```

---

## 3. 数据模型

### 3.1 核心表结构

#### Table: projects

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repo_url VARCHAR(500) NOT NULL,
  scm_type VARCHAR(20) NOT NULL DEFAULT 'gitlab',
  default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
  gitlab_project_id INTEGER,
  gitlab_access_token TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

索引:
  - PRIMARY KEY (id)
  - UNIQUE (gitlab_project_id)
```

#### Table: issues

```sql
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  acceptance_criteria JSONB,  -- Array of strings
  constraints JSONB,          -- Array of strings
  test_requirements TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  assigned_agent_id UUID REFERENCES agents(id),
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

索引:
  - PRIMARY KEY (id)
  - INDEX (project_id, status)
  - INDEX (assigned_agent_id)
```

#### Table: runs

```sql
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id),
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

索引:
  - PRIMARY KEY (id)
  - INDEX (issue_id)
  - INDEX (agent_id, status)
  - INDEX (acp_session_id)
```

#### Table: agents

```sql
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'local',
  proxy_id VARCHAR(100),
  capabilities JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'offline',
  current_load INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 2,
  last_heartbeat TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

索引:
  - PRIMARY KEY (id)
  - UNIQUE (proxy_id)
  - INDEX (status, current_load)
```

#### Table: events

```sql
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id),
  source VARCHAR(50) NOT NULL,  -- 'acp' | 'gitlab' | 'system'
  type VARCHAR(100) NOT NULL,
  payload JSONB,
  metadata JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

索引:
  - PRIMARY KEY (id)
  - INDEX (run_id, timestamp DESC)
  - INDEX (type)
```

#### Table: artifacts

```sql
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id),
  type VARCHAR(50) NOT NULL,  -- 'branch' | 'pr' | 'patch'
  content JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

索引:
  - PRIMARY KEY (id)
  - INDEX (run_id, type)
```

### 3.2 数据关系图

```
projects (1) ──────────────────────> (N) issues
                                           │
                                           │ (1)
                                           │
                                           ↓
                                         (N) runs
                                           │
                                           ├──────> (N) events
                                           │
                                           └──────> (N) artifacts

agents (1) ────────────────────────────> (N) runs
```

---

## 4. 技术选型对比

### 4.1 后端框架

| 框架                  | 优点                                    | 缺点                    | 推荐度     |
| --------------------- | --------------------------------------- | ----------------------- | ---------- |
| **Node.js + Express** | 生态丰富、异步 I/O 性能好、社区活跃     | 类型安全需要 TypeScript | ⭐⭐⭐⭐   |
| **Node.js + Fastify** | 比 Express 更快、内置 TypeScript 支持   | 社区较小                | ⭐⭐⭐⭐⭐ |
| **Python + FastAPI**  | 开发速度快、自动生成 API 文档、类型提示 | 性能略逊于 Node.js      | ⭐⭐⭐⭐   |

**推荐**: Fastify + TypeScript（性能 + 类型安全）

### 4.2 ORM

| ORM                     | 优点                               | 缺点                | 推荐度     |
| ----------------------- | ---------------------------------- | ------------------- | ---------- |
| **TypeORM**             | 成熟、支持多数据库、装饰器语法     | 配置复杂            | ⭐⭐⭐⭐   |
| **Prisma**              | 类型安全、自动生成客户端、迁移简单 | 不支持所有 SQL 特性 | ⭐⭐⭐⭐⭐ |
| **SQLAlchemy** (Python) | 功能强大、灵活                     | 学习曲线陡峭        | ⭐⭐⭐     |

**推荐**: Prisma（开发效率高）

### 4.3 WebSocket 库

| 库            | 优点                         | 缺点                       | 推荐度     |
| ------------- | ---------------------------- | -------------------------- | ---------- |
| **ws**        | 轻量、性能好、原生 WebSocket | 功能简单、需要手动处理重连 | ⭐⭐⭐⭐   |
| **Socket.io** | 功能丰富、自动重连、房间支持 | 体积大、协议复杂           | ⭐⭐⭐⭐⭐ |

**推荐**: Socket.io（功能完善）

---

## 5. 部署架构

### 5.1 开发环境 (Docker Compose)

```yaml
version: "3.8"

services:
  # 后端 Orchestrator
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/acp_system
      - GITLAB_URL=https://gitlab.example.com
      - GITLAB_ACCESS_TOKEN=glpat-xxx
    depends_on:
      - postgres

  # PostgreSQL
  postgres:
    image: postgres:14
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=acp_system
    volumes:
      - postgres_data:/var/lib/postgresql/data

  # 前端 Web UI
  frontend:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - backend

volumes:
  postgres_data:
```

### 5.2 生产环境（单机 Docker）

```
[云服务器 - 1 台]
  ├── Nginx (反向代理)
  │     ├── /api → Backend
  │     ├── /ws  → Backend WebSocket
  │     └── /    → Frontend
  ├── Backend (Docker 容器)
  ├── Frontend (Docker 容器)
  └── PostgreSQL (Docker 容器 + 数据卷)

[用户本地电脑 - N 台]
  └── ACP Proxy (原生程序 / Docker)
        └── 连接到云服务器 WebSocket
```

### 5.3 未来扩展（Kubernetes）

```
[K8s Cluster]
  ├── Deployment: backend (3 replicas)
  ├── Deployment: frontend (2 replicas)
  ├── StatefulSet: postgres (1 replica + PV)
  ├── Service: backend-api (ClusterIP)
  ├── Service: backend-ws (NodePort)
  └── Ingress: 统一入口
```

---

## 6. 安全考虑

### 6.1 认证与授权

**MVP 阶段（简化）**:

- 前端无需登录（信任内网）
- Agent 连接使用固定 Token

**未来增强**:

- 前端：JWT Token + OAuth
- Agent：动态 Token + 证书

### 6.2 网络隔离

**Proxy → Orchestrator**:

- 使用 TLS/WSS (WebSocket Secure)
- 验证服务器证书

**Orchestrator → GitLab**:

- Personal Access Token 存储在环境变量
- 不写入代码或配置文件

### 6.3 数据安全

**敏感数据**:

- GitLab Token: 加密存储（AES-256）
- Webhook Secret: 存储在环境变量

**日志脱敏**:

- 不记录 Token 明文
- 不记录用户密码

---

## 7. 监控与日志

### 7.1 日志级别

```
ERROR   - 系统错误（需要立即处理）
WARN    - 警告（如 Agent 离线、CI 失败）
INFO    - 重要事件（如任务创建、PR 创建）
DEBUG   - 调试信息（如 WebSocket 消息详情）
```

### 7.2 日志格式（结构化 JSON）

```json
{
  "timestamp": "2026-01-25T10:30:00Z",
  "level": "INFO",
  "component": "Scheduler",
  "message": "Task assigned to agent",
  "metadata": {
    "run_id": "run-123",
    "agent_id": "codex-local-1"
  }
}
```

### 7.3 关键指标（未来 Grafana Dashboard）

- 任务成功率（Success Rate）
- 平均执行时间（Avg Execution Time）
- Agent 在线数量（Online Agents）
- 系统 QPS（Requests Per Second）
- WebSocket 连接数（Active Connections）

---

## 下一步

阅读 **02_ENVIRONMENT_SETUP.md** 开始环境准备。
