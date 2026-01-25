# 组件实现要点

本文档详细说明各核心组件的实现细节、接口定义、数据结构和关键算法。

---

## 1. 数据库设计详解

### 1.1 完整 Schema

```sql
-- ============================================
-- 数据库: acp_system
-- 版本: 1.0
-- 说明: ACP 驱动的研发协作系统
-- ============================================

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 表: projects (项目)
-- ============================================
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  repo_url VARCHAR(500) NOT NULL,
  scm_type VARCHAR(20) NOT NULL DEFAULT 'gitlab',
  default_branch VARCHAR(100) NOT NULL DEFAULT 'main',

  -- GitLab 特定字段
  gitlab_project_id INTEGER UNIQUE,
  gitlab_access_token TEXT,
  gitlab_webhook_secret VARCHAR(255),

  -- 分支保护策略
  branch_protection JSONB DEFAULT '{
    "require_review_count": 1,
    "require_ci_pass": true
  }',

  -- Agent 调度策略
  agent_allocation_strategy VARCHAR(20) DEFAULT 'auto',

  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_projects_gitlab_id ON projects(gitlab_project_id);

-- 触发器：更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 表: issues (任务)
-- ============================================
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- 基本信息
  title VARCHAR(255) NOT NULL,
  description TEXT,

  -- 验收标准（数组）
  acceptance_criteria JSONB DEFAULT '[]',
  -- 约束条件（数组）
  constraints JSONB DEFAULT '[]',
  -- 测试要求
  test_requirements TEXT,

  -- 状态
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- CHECK (status IN ('pending', 'running', 'reviewing', 'done', 'failed', 'cancelled')),

  -- 分配
  assigned_agent_id UUID REFERENCES agents(id),

  -- 元数据
  created_by VARCHAR(100),
  labels JSONB DEFAULT '[]',
  priority INTEGER DEFAULT 0,

  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_issues_project_status ON issues(project_id, status);
CREATE INDEX idx_issues_assigned_agent ON issues(assigned_agent_id);
CREATE INDEX idx_issues_status ON issues(status);

CREATE TRIGGER issues_updated_at
BEFORE UPDATE ON issues
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 表: agents (执行者)
-- ============================================
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- 基本信息
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'local',
  -- CHECK (type IN ('local', 'remote')),

  -- 连接信息
  proxy_id VARCHAR(100) UNIQUE,
  gateway_id VARCHAR(100),

  -- 能力标签
  capabilities JSONB DEFAULT '{
    "languages": [],
    "frameworks": [],
    "tools": []
  }',

  -- 状态
  status VARCHAR(50) NOT NULL DEFAULT 'offline',
  -- CHECK (status IN ('online', 'offline', 'degraded', 'suspended')),

  -- 负载
  current_load INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 2,

  -- 健康检查
  last_heartbeat TIMESTAMP,
  health_check_interval INTEGER DEFAULT 30,

  -- 统计
  stats JSONB DEFAULT '{
    "total_runs": 0,
    "success_count": 0,
    "failure_count": 0,
    "avg_duration_seconds": 0
  }',

  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_agents_status_load ON agents(status, current_load);
CREATE INDEX idx_agents_proxy_id ON agents(proxy_id);
CREATE INDEX idx_agents_last_heartbeat ON agents(last_heartbeat);

CREATE TRIGGER agents_updated_at
BEFORE UPDATE ON agents
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 表: runs (执行实例)
-- ============================================
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),

  -- ACP 会话信息
  acp_session_id VARCHAR(100),

  -- 工作空间
  workspace_type VARCHAR(20) DEFAULT 'local',
  workspace_path VARCHAR(500),
  branch_name VARCHAR(200),

  -- 状态
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- 可能的状态: pending, running, waiting_ci, completed, failed, cancelled

  -- 时间
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  duration_seconds INTEGER,

  -- 失败信息
  failure_reason VARCHAR(100),
  error_message TEXT,

  -- 元数据
  metadata JSONB DEFAULT '{}',

  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_runs_issue ON runs(issue_id);
CREATE INDEX idx_runs_agent_status ON runs(agent_id, status);
CREATE INDEX idx_runs_session ON runs(acp_session_id);
CREATE INDEX idx_runs_status ON runs(status);

CREATE TRIGGER runs_updated_at
BEFORE UPDATE ON runs
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- 自动计算 duration
CREATE OR REPLACE FUNCTION calculate_run_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND NEW.started_at IS NOT NULL THEN
    NEW.duration_seconds = EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER runs_calculate_duration
BEFORE UPDATE ON runs
FOR EACH ROW
WHEN (NEW.completed_at IS NOT NULL)
EXECUTE FUNCTION calculate_run_duration();

-- ============================================
-- 表: events (事件时间线)
-- ============================================
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  -- 事件来源
  source VARCHAR(50) NOT NULL,
  -- 'acp' | 'gitlab' | 'system' | 'user'

  -- 事件类型
  type VARCHAR(100) NOT NULL,
  -- 见下方枚举定义

  -- 事件数据
  payload JSONB,

  -- 元数据
  metadata JSONB DEFAULT '{}',

  -- 时间戳
  timestamp TIMESTAMP DEFAULT NOW()
);

-- 索引（重要：查询性能）
CREATE INDEX idx_events_run_time ON events(run_id, timestamp DESC);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_source ON events(source);

-- ============================================
-- 表: artifacts (产物)
-- ============================================
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,

  -- 产物类型
  type VARCHAR(50) NOT NULL,
  -- 'branch' | 'mr' | 'patch' | 'report' | 'ci_result'

  -- 产物内容
  content JSONB NOT NULL,

  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_artifacts_run_type ON artifacts(run_id, type);

-- ============================================
-- 视图: 任务详情（带统计）
-- ============================================
CREATE VIEW issue_details AS
SELECT
  i.*,
  p.name AS project_name,
  p.repo_url,
  a.name AS agent_name,
  r.id AS current_run_id,
  r.status AS run_status,
  r.started_at AS run_started_at,
  r.completed_at AS run_completed_at,
  (SELECT COUNT(*) FROM events WHERE run_id = r.id) AS event_count,
  (SELECT COUNT(*) FROM artifacts WHERE run_id = r.id) AS artifact_count
FROM issues i
LEFT JOIN projects p ON i.project_id = p.id
LEFT JOIN agents a ON i.assigned_agent_id = a.id
LEFT JOIN runs r ON r.issue_id = i.id AND r.status NOT IN ('completed', 'failed', 'cancelled')
ORDER BY i.created_at DESC;

-- ============================================
-- 初始化数据
-- ============================================

-- 插入默认项目
INSERT INTO projects (name, repo_url, gitlab_project_id, default_branch)
VALUES ('Demo Project', 'https://gitlab.example.com/user/demo-project', 123, 'main')
ON CONFLICT DO NOTHING;
```

### 1.2 事件类型枚举

```typescript
// EventType 枚举定义
export enum EventType {
  // ACP 相关事件
  ACP_SESSION_STARTED = "acp.session.started",
  ACP_PROMPT_SENT = "acp.prompt.sent",
  ACP_UPDATE_RECEIVED = "acp.update.received",
  ACP_TOOL_CALL = "acp.tool.call",
  ACP_PERMISSION_REQUESTED = "acp.permission.requested",
  ACP_SESSION_COMPLETED = "acp.session.completed",
  ACP_SESSION_FAILED = "acp.session.failed",

  // Git 相关事件
  GIT_BRANCH_CREATED = "git.branch.created",
  GIT_COMMIT_PUSHED = "git.commit.pushed",
  GIT_MR_CREATED = "git.mr.created",
  GIT_MR_UPDATED = "git.mr.updated",
  GIT_MR_MERGED = "git.mr.merged",
  GIT_MR_CLOSED = "git.mr.closed",

  // CI 相关事件
  CI_CHECK_STARTED = "ci.check.started",
  CI_CHECK_RUNNING = "ci.check.running",
  CI_CHECK_PASSED = "ci.check.passed",
  CI_CHECK_FAILED = "ci.check.failed",
  CI_CHECK_CANCELLED = "ci.check.cancelled",

  // Review 相关事件
  REVIEW_COMMENT_ADDED = "review.comment.added",
  REVIEW_CHANGES_REQUESTED = "review.changes.requested",
  REVIEW_APPROVED = "review.approved",

  // 系统相关事件
  SYSTEM_AGENT_ASSIGNED = "system.agent.assigned",
  SYSTEM_RUN_CREATED = "system.run.created",
  SYSTEM_RUN_STARTED = "system.run.started",
  SYSTEM_RUN_RETRIED = "system.run.retried",
  SYSTEM_RUN_CANCELLED = "system.run.cancelled",
  SYSTEM_RUN_FAILED = "system.run.failed",
  SYSTEM_ERROR = "system.error",
}
```

### 1.3 数据关系图

```
                    ┌─────────────┐
                    │  projects   │
                    └──────┬──────┘
                           │ 1
                           │
                           │ N
                    ┌──────▼──────┐
                    │   issues    │
                    └──────┬──────┘
                           │ 1
                           │
                           │ N
                    ┌──────▼──────┐
              ┌─────│    runs     │─────┐
              │     └──────┬──────┘     │
              │            │            │
              │ N          │ N          │ N
              │            │            │
       ┌──────▼──────┐ ┌──▼──────┐ ┌───▼─────┐
       │   events    │ │artifacts│ │ agents  │
       └─────────────┘ └─────────┘ └─────────┘
```

---

## 2. API 接口定义

### 2.1 RESTful API 规范

#### 基础 URL

```
http://localhost:3000/api
```

#### 通用响应格式

**成功响应**:

```json
{
  "success": true,
  "data": { ... }
}
```

**错误响应**:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": { ... }
  }
}
```

### 2.2 Issues API

#### 创建 Issue

```http
POST /api/issues
Content-Type: application/json

{
  "title": "Fix user login bug",
  "description": "Users cannot login with email",
  "acceptance_criteria": [
    "Users can login with email",
    "Error messages are clear",
    "Password validation works"
  ],
  "constraints": [
    "Do not modify auth module API"
  ],
  "test_requirements": "Add unit tests for all changes"
}
```

**响应**:

```json
{
  "success": true,
  "data": {
    "issue": {
      "id": "uuid-here",
      "title": "Fix user login bug",
      "status": "pending",
      "created_at": "2026-01-25T10:00:00Z"
    }
  }
}
```

#### 获取 Issue 列表

```http
GET /api/issues?status=pending&limit=20&offset=0
```

**响应**:

```json
{
  "success": true,
  "data": {
    "issues": [...],
    "total": 45,
    "limit": 20,
    "offset": 0
  }
}
```

#### 获取 Issue 详情

```http
GET /api/issues/:id
```

**响应**:

```json
{
  "success": true,
  "data": {
    "issue": {
      "id": "...",
      "title": "...",
      "runs": [
        {
          "id": "...",
          "status": "running",
          "agent_name": "codex-local-1"
        }
      ]
    }
  }
}
```

### 2.3 Runs API

#### 获取 Run 详情

```http
GET /api/runs/:id
```

#### 获取 Run 事件时间线

```http
GET /api/runs/:id/events?limit=100
```

**响应**:

```json
{
  "success": true,
  "data": {
    "events": [
      {
        "id": "...",
        "type": "acp.update.received",
        "payload": {
          "text": "Analyzing codebase..."
        },
        "timestamp": "2026-01-25T10:30:00Z"
      },
      ...
    ]
  }
}
```

#### 取消 Run

```http
POST /api/runs/:id/cancel
```

### 2.4 Agents API

#### 注册 Agent（内部接口，通过 WebSocket）

```typescript
// WebSocket 消息格式
{
  type: 'register_agent',
  agent: {
    id: 'codex-local-1',
    name: 'Codex Local Agent 1',
    capabilities: {
      languages: ['javascript', 'python'],
      frameworks: ['react', 'fastapi'],
      tools: ['git', 'npm']
    },
    max_concurrent: 2
  }
}
```

#### 获取 Agent 列表

```http
GET /api/agents
```

**响应**:

```json
{
  "success": true,
  "data": {
    "agents": [
      {
        "id": "...",
        "name": "codex-local-1",
        "status": "online",
        "current_load": 1,
        "max_concurrent_runs": 2,
        "last_heartbeat": "2026-01-25T10:35:00Z"
      }
    ]
  }
}
```

#### 心跳（内部接口，通过 WebSocket）

```typescript
{
  type: 'heartbeat',
  agent_id: 'codex-local-1',
  current_load: 1,
  uptime: 3600
}
```

---

## 3. 核心算法实现

### 3.1 Agent 选择算法

```typescript
interface Agent {
  id: string;
  status: "online" | "offline" | "degraded" | "suspended";
  current_load: number;
  max_concurrent_runs: number;
  capabilities: {
    languages: string[];
    frameworks: string[];
    tools: string[];
  };
  stats: {
    total_runs: number;
    success_count: number;
    failure_count: number;
  };
}

interface Issue {
  title: string;
  description: string;
  acceptance_criteria: string[];
}

/**
 * Agent 选择算法（带能力匹配）
 */
function selectAgent(agents: Agent[], issue: Issue): Agent {
  // 1. 过滤：只保留在线且未满载的 Agent
  const availableAgents = agents.filter(
    (agent) =>
      agent.status === "online" &&
      agent.current_load < agent.max_concurrent_runs,
  );

  if (availableAgents.length === 0) {
    throw new Error("No available agent");
  }

  // 2. 提取 Issue 所需的技术栈关键词
  const requiredTechs = extractTechnologies(issue);

  // 3. 为每个 Agent 计算匹配分数
  const scoredAgents = availableAgents.map((agent) => ({
    agent,
    score: calculateMatchScore(agent, requiredTechs),
  }));

  // 4. 排序：分数高的优先，分数相同则负载低的优先
  scoredAgents.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.agent.current_load - b.agent.current_load;
  });

  // 5. 返回最佳匹配
  return scoredAgents[0].agent;
}

/**
 * 从 Issue 中提取技术栈关键词
 */
function extractTechnologies(issue: Issue): string[] {
  const text = [issue.title, issue.description, ...issue.acceptance_criteria]
    .join(" ")
    .toLowerCase();

  const keywords: string[] = [];

  // 语言检测
  const languages = [
    "javascript",
    "python",
    "java",
    "go",
    "rust",
    "typescript",
  ];
  languages.forEach((lang) => {
    if (text.includes(lang)) keywords.push(lang);
  });

  // 框架检测
  const frameworks = [
    "react",
    "vue",
    "angular",
    "django",
    "fastapi",
    "express",
  ];
  frameworks.forEach((fw) => {
    if (text.includes(fw)) keywords.push(fw);
  });

  // 工具检测
  const tools = ["docker", "kubernetes", "git", "npm"];
  tools.forEach((tool) => {
    if (text.includes(tool)) keywords.push(tool);
  });

  return keywords;
}

/**
 * 计算 Agent 能力匹配分数
 */
function calculateMatchScore(agent: Agent, requiredTechs: string[]): number {
  let score = 0;

  const allCapabilities = [
    ...agent.capabilities.languages,
    ...agent.capabilities.frameworks,
    ...agent.capabilities.tools,
  ].map((c) => c.toLowerCase());

  // 每个匹配的技术栈 +10 分
  requiredTechs.forEach((tech) => {
    if (allCapabilities.includes(tech)) {
      score += 10;
    }
  });

  // 考虑历史成功率（最多 +5 分）
  if (agent.stats.total_runs > 0) {
    const successRate = agent.stats.success_count / agent.stats.total_runs;
    score += successRate * 5;
  }

  // 负载惩罚（负载越高，扣分越多）
  const loadRatio = agent.current_load / agent.max_concurrent_runs;
  score -= loadRatio * 3;

  return score;
}
```

### 3.2 Run 状态机

```typescript
/**
 * Run 状态定义
 */
type RunStatus =
  | "pending" // 已创建，等待 Agent
  | "running" // Agent 正在执行
  | "waiting_ci" // 等待 CI 检查
  | "completed" // 成功完成
  | "failed" // 执行失败
  | "cancelled"; // 用户取消

/**
 * 状态转换事件
 */
type StatusEvent =
  | "agent_started"
  | "mr_created"
  | "ci_passed"
  | "mr_merged"
  | "agent_error"
  | "timeout"
  | "user_cancel";

/**
 * 状态转换表
 */
const STATE_TRANSITIONS: Record<
  RunStatus,
  Partial<Record<StatusEvent, RunStatus>>
> = {
  pending: {
    agent_started: "running",
    user_cancel: "cancelled",
  },
  running: {
    mr_created: "waiting_ci",
    agent_error: "failed",
    timeout: "failed",
    user_cancel: "cancelled",
  },
  waiting_ci: {
    mr_merged: "completed",
    user_cancel: "cancelled",
  },
  completed: {},
  failed: {},
  cancelled: {},
};

/**
 * 状态转换函数
 */
async function transitionRunStatus(
  runId: string,
  event: StatusEvent,
): Promise<void> {
  // 1. 获取当前状态
  const run = await Run.findById(runId);
  const currentStatus = run.status as RunStatus;

  // 2. 查找目标状态
  const targetStatus = STATE_TRANSITIONS[currentStatus][event];

  if (!targetStatus) {
    console.warn(`Invalid transition: ${currentStatus} + ${event}`);
    return;
  }

  // 3. 更新状态
  await Run.update({ id: runId }, { status: targetStatus });

  // 4. 记录事件
  await Event.create({
    run_id: runId,
    source: "system",
    type: `system.status_changed`,
    payload: {
      from: currentStatus,
      to: targetStatus,
      event,
    },
  });

  // 5. 触发后续动作
  await handleStatusChange(runId, targetStatus);
}

/**
 * 状态变更后的处理
 */
async function handleStatusChange(
  runId: string,
  newStatus: RunStatus,
): Promise<void> {
  const run = await Run.findById(runId);

  switch (newStatus) {
    case "completed":
      // 更新 Issue 状态为 done
      await Issue.update({ id: run.issue_id }, { status: "done" });

      // 更新 Agent 负载
      await Agent.update(
        { id: run.agent_id },
        { current_load: db.raw("current_load - 1") },
      );
      break;

    case "failed":
      // 更新 Issue 状态为 failed
      await Issue.update({ id: run.issue_id }, { status: "failed" });

      // 更新 Agent 负载
      await Agent.update(
        { id: run.agent_id },
        { current_load: db.raw("current_load - 1") },
      );

      // 生成失败诊断（未来实现）
      // await generateDiagnosisPacket(runId);
      break;

    case "cancelled":
      // 更新 Agent 负载
      await Agent.update(
        { id: run.agent_id },
        { current_load: db.raw("current_load - 1") },
      );
      break;
  }
}
```

### 3.3 事件聚合算法

```typescript
/**
 * 聚合 Run 的事件时间线
 */
async function aggregateRunEvents(runId: string): Promise<TimelineItem[]> {
  // 1. 获取所有事件
  const events = await Event.findAll({
    where: { run_id: runId },
    order: [["timestamp", "ASC"]],
  });

  // 2. 分组：将连续的相同类型事件合并
  const timeline: TimelineItem[] = [];
  let currentGroup: Event[] = [];

  events.forEach((event, index) => {
    const isGroupable = isGroupableEvent(event.type);

    if (
      isGroupable &&
      currentGroup.length > 0 &&
      isSameGroup(currentGroup[0], event)
    ) {
      // 加入当前组
      currentGroup.push(event);
    } else {
      // 结束当前组，开始新组
      if (currentGroup.length > 0) {
        timeline.push(createTimelineItem(currentGroup));
      }
      currentGroup = [event];
    }
  });

  // 处理最后一组
  if (currentGroup.length > 0) {
    timeline.push(createTimelineItem(currentGroup));
  }

  return timeline;
}

/**
 * 判断事件是否可分组
 */
function isGroupableEvent(eventType: string): boolean {
  // ACP 更新事件可以分组
  return eventType === EventType.ACP_UPDATE_RECEIVED;
}

/**
 * 判断两个事件是否属于同一组
 */
function isSameGroup(event1: Event, event2: Event): boolean {
  // 时间间隔小于 5 秒
  const timeDiff = Math.abs(
    event2.timestamp.getTime() - event1.timestamp.getTime(),
  );
  return timeDiff < 5000;
}

/**
 * 创建时间线项
 */
function createTimelineItem(events: Event[]): TimelineItem {
  if (events.length === 1) {
    return {
      timestamp: events[0].timestamp,
      type: events[0].type,
      content: events[0].payload,
      count: 1,
    };
  } else {
    // 多个事件合并
    return {
      timestamp: events[0].timestamp,
      type: events[0].type,
      content: {
        messages: events.map((e) => e.payload.text || ""),
        collapsed: true,
      },
      count: events.length,
    };
  }
}

interface TimelineItem {
  timestamp: Date;
  type: string;
  content: any;
  count: number;
}
```

---

## 4. 服务层实现

### 4.1 Scheduler Service

```typescript
/**
 * 任务调度服务
 */
export class SchedulerService {
  /**
   * 调度 Issue 到 Agent
   */
  async scheduleIssue(issueId: string): Promise<Run> {
    // 1. 获取 Issue
    const issue = await Issue.findById(issueId);
    if (!issue) {
      throw new Error("Issue not found");
    }

    // 2. 选择 Agent
    const agents = await Agent.findAll({
      where: { status: "online" },
    });

    const selectedAgent = selectAgent(agents, issue);

    // 3. 创建 Run
    const sessionId = `sess-${uuidv4()}`;
    const branchName = `acp/issue-${issue.id}/run-${uuidv4().slice(0, 8)}`;

    const run = await Run.create({
      issue_id: issue.id,
      agent_id: selectedAgent.id,
      acp_session_id: sessionId,
      branch_name: branchName,
      status: "pending",
    });

    // 4. 生成 Prompt
    const prompt = this.generatePrompt(issue, branchName);

    // 5. 发送任务给 Agent
    await WebSocketGateway.sendToAgent(selectedAgent.id, {
      type: "execute_task",
      run_id: run.id,
      session_id: sessionId,
      prompt,
    });

    // 6. 更新状态
    await Issue.update(
      { id: issue.id },
      { assigned_agent_id: selectedAgent.id },
    );
    await Agent.update(
      { id: selectedAgent.id },
      { current_load: db.raw("current_load + 1") },
    );

    // 7. 记录事件
    await Event.create({
      run_id: run.id,
      source: "system",
      type: EventType.SYSTEM_RUN_CREATED,
      payload: { agent_id: selectedAgent.id },
    });

    return run;
  }

  /**
   * 生成 Agent Prompt
   */
  private generatePrompt(issue: Issue, branchName: string): string {
    return `
# 任务: ${issue.title}

## 描述
${issue.description}

## 验收标准
${issue.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

${
  issue.constraints.length > 0
    ? `
## 约束条件
${issue.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}
`
    : ""
}

${
  issue.test_requirements
    ? `
## 测试要求
${issue.test_requirements}
`
    : ""
}

## 工作分支
请在分支 \`${branchName}\` 上完成开发。

完成后请创建 Merge Request 到 main 分支。
    `.trim();
  }
}
```

### 4.2 GitLab Service

```typescript
/**
 * GitLab API 服务
 */
export class GitLabService {
  private baseUrl: string;
  private token: string;

  constructor() {
    this.baseUrl = process.env.GITLAB_URL + "/api/v4";
    this.token = process.env.GITLAB_ACCESS_TOKEN;
  }

  /**
   * 创建 Merge Request
   */
  async createMergeRequest(params: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<MergeRequest> {
    const response = await fetch(
      `${this.baseUrl}/projects/${params.projectId}/merge_requests`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_branch: params.sourceBranch,
          target_branch: params.targetBranch,
          title: params.title,
          description: params.description,
          remove_source_branch: true,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      id: data.id,
      iid: data.iid,
      web_url: data.web_url,
      state: data.state,
    };
  }

  /**
   * 获取 MR 状态
   */
  async getMergeRequest(
    projectId: number,
    mrIid: number,
  ): Promise<MergeRequest> {
    const response = await fetch(
      `${this.baseUrl}/projects/${projectId}/merge_requests/${mrIid}`,
      {
        headers: { "PRIVATE-TOKEN": this.token },
      },
    );

    const data = await response.json();

    return {
      id: data.id,
      iid: data.iid,
      web_url: data.web_url,
      state: data.state,
      pipeline: data.pipeline
        ? {
            id: data.pipeline.id,
            status: data.pipeline.status,
          }
        : undefined,
    };
  }
}

interface MergeRequest {
  id: number;
  iid: number;
  web_url: string;
  state: "opened" | "closed" | "merged";
  pipeline?: {
    id: number;
    status: string;
  };
}
```

---

## 5. WebSocket 网关实现

### 5.1 连接管理

```typescript
/**
 * WebSocket 网关
 */
export class WebSocketGateway {
  private static agentConnections = new Map<string, WebSocket>();
  private static clientConnections = new Map<string, WebSocket>();

  /**
   * 初始化 WebSocket 服务器
   */
  static init(server: FastifyInstance) {
    // Agent 连接
    server.get("/ws/agent", { websocket: true }, (connection, req) => {
      this.handleAgentConnection(connection);
    });

    // Web UI 连接
    server.get("/ws/client", { websocket: true }, (connection, req) => {
      this.handleClientConnection(connection);
    });
  }

  /**
   * 处理 Agent 连接
   */
  private static handleAgentConnection(connection: WebSocketConnection) {
    let agentId: string | null = null;

    connection.socket.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case "register_agent":
            agentId = await this.handleAgentRegister(connection, message);
            break;
          case "heartbeat":
            await this.handleHeartbeat(message);
            break;
          case "agent_update":
            await this.handleAgentUpdate(message);
            break;
          case "branch_created":
            await this.handleBranchCreated(message);
            break;
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    connection.socket.on("close", () => {
      if (agentId) {
        this.handleAgentDisconnect(agentId);
      }
    });
  }

  /**
   * 处理 Agent 注册
   */
  private static async handleAgentRegister(
    connection: WebSocketConnection,
    message: any,
  ): Promise<string> {
    const agentId = message.agent.id;

    // 1. 存储连接
    this.agentConnections.set(agentId, connection.socket);

    // 2. 更新数据库
    await Agent.upsert({
      id: agentId,
      name: message.agent.name,
      proxy_id: agentId,
      capabilities: message.agent.capabilities,
      max_concurrent_runs: message.agent.max_concurrent,
      status: "online",
      last_heartbeat: new Date(),
    });

    // 3. 发送确认
    connection.socket.send(
      JSON.stringify({
        type: "register_ack",
        success: true,
      }),
    );

    console.log(`✅ Agent registered: ${agentId}`);

    return agentId;
  }

  /**
   * 发送任务给 Agent
   */
  static async sendToAgent(agentId: string, message: any): Promise<void> {
    const ws = this.agentConnections.get(agentId);

    if (!ws) {
      throw new Error(`Agent ${agentId} not connected`);
    }

    ws.send(JSON.stringify(message));
  }

  /**
   * 广播给所有 Web UI 客户端
   */
  static broadcastToClients(message: any): void {
    this.clientConnections.forEach((ws) => {
      ws.send(JSON.stringify(message));
    });
  }
}
```

---

## 6. 错误处理策略

### 6.1 错误分类

```typescript
/**
 * 自定义错误类型
 */
export class ACPError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
    this.name = "ACPError";
  }
}

// 具体错误类型
export class AgentNotFoundError extends ACPError {
  constructor(agentId: string) {
    super("AGENT_NOT_FOUND", `Agent ${agentId} not found`);
  }
}

export class NoAvailableAgentError extends ACPError {
  constructor() {
    super("NO_AVAILABLE_AGENT", "No available agent to handle the task");
  }
}

export class GitLabAPIError extends ACPError {
  constructor(message: string, details: any) {
    super("GITLAB_API_ERROR", message, details);
  }
}
```

### 6.2 全局错误处理器

```typescript
/**
 * Fastify 错误处理器
 */
server.setErrorHandler((error, request, reply) => {
  // 记录错误
  server.log.error(error);

  // ACPError
  if (error instanceof ACPError) {
    return reply.status(400).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  // 未知错误
  return reply.status(500).send({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
});
```

---

## 7. 日志规范

### 7.1 结构化日志

```typescript
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

// 使用示例
logger.info({ issueId, agentId }, "Task scheduled");
logger.error({ error, runId }, "Run failed");
logger.debug({ message }, "WebSocket message received");
```

### 7.2 日志级别

- **ERROR**: 系统错误，需要立即处理
- **WARN**: 警告信息，如 Agent 离线、CI 失败
- **INFO**: 重要事件，如任务创建、MR 创建
- **DEBUG**: 调试信息，如 WebSocket 消息详情

---

## 下一步

阅读 **04_ACP_INTEGRATION_SPEC.md** 了解 ACP 协议集成的详细实现。
