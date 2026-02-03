---
title: "PRD：基于 ACP 的 Agent 执行与研发协作系统（修订版）"
owner: "@tuixiu-maintainers"
status: "archived"
last_reviewed: "2026-01-27"
---

> ⚠️ **已归档 / 已过期**：本文档仅用于历史追溯，可能与当前实现不一致，请勿作为开发依据。  
> 当前请以 `docs/00_overview/index.md` 与 `docs/00_overview/roadmap.md` 为准。

# PRD：基于 ACP 的 Agent 执行与研发协作系统（修订版）

## 0. 产品定位

### 一句话定位

一个面向研发协作的 **Agent 执行中枢**：通过 Agent Client Protocol (ACP) 连接本地/远程 coding agent，把任务从"需求描述"推进到"PR 合并"，提供可回放、可接管、可审计的执行过程与进度视图。

### 核心差异化（vs Jira/Linear）

| 维度     | Jira/Linear        | 本系统                         |
| -------- | ------------------ | ------------------------------ |
| 中心     | 需求管理、人工协作 | **Agent 执行与进度追踪**       |
| 执行者   | 人类开发者         | **ACP Agent（可人工接管）**    |
| 核心资产 | Issue、评论、看板  | **执行时间线、诊断数据、产物** |
| 交付物   | 人工提交的代码     | **Agent 自动产出的 PR**        |

---

## 1. 技术架构（基于 Zed ACP）

### 1.1 ACP 协议概述

**Agent Client Protocol (ACP)** 是 Zed Industries 开发的开放标准，用于**编辑器与 AI coding agent 的通信**。

核心特性：

- **协议**: JSON-RPC 2.0 over stdio（标准输入输出）
- **通信模式**: 双向（client 和 agent 都可发起请求）
- **会话管理**: 支持多会话、流式更新、取消
- **权限机制**: agent 可请求用户授权敏感操作
- **文件访问**: 可选的文件系统读写能力
- **与 MCP 兼容**: 可复用 Model Context Protocol 服务器

### 1.2 架构挑战与解决方案

#### 挑战：ACP 原生设计 vs Web 看板需求

```
ACP 原生设计:
[编辑器] --启动子进程--> [Agent]
   ↓                       ↑
   └──── stdio (JSON-RPC) ──┘

本系统需求:
[Web 看板] --远程通信--> [Agent (可能在用户本地)]
```

**核心矛盾**:

1. ACP 是 stdio 通信，但 Web 看板与本地 agent 跨网络
2. ACP 假设父进程启动子进程，但 Web 看板如何启动用户电脑上的 agent？
3. 本地 agent 如何访问本地代码仓库？

#### 解决方案：三层架构

```
┌──────────────────────────────────────────────────────────┐
│                     Layer 1: Web UI                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  看板视图    │  │  任务详情    │  │  Agent控制台 │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP/WebSocket API
┌────────────────────────┴─────────────────────────────────┐
│              Layer 2: Orchestrator (调度中枢)             │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  任务调度  │  状态管理  │  时间线聚合  │  产物跟踪  │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────┬────────────────────────────┬────────────────┘
             │                            │
    ┌────────┴────────┐          ┌────────┴────────┐
    │  本地 Agent Path │          │ 远程 Agent Path  │
    └────────┬────────┘          └────────┬────────┘
             │                            │
┌────────────┴────────────┐   ┌───────────┴──────────────┐
│  Layer 3a: ACP Proxy    │   │ Layer 3b: ACP Gateway    │
│  (用户本地部署)          │   │  (云端运行)               │
│  ┌──────────────────┐   │   │  ┌────────────────────┐  │
│  │  Protocol Bridge │   │   │  │  Container Manager │  │
│  │  Process Manager │   │   │  │  Workspace Manager │  │
│  │  Health Monitor  │   │   │  │  Resource Pool     │  │
│  └────────┬─────────┘   │   │  └──────────┬─────────┘  │
└───────────┴─────────────┘   └─────────────┴────────────┘
             │ stdio                        │ stdio
             │ (JSON-RPC)                   │ (JSON-RPC)
             ↓                              ↓
    ┌────────────────┐              ┌────────────────┐
    │  Local Agents  │              │ Remote Agents  │
    │  (子进程)      │              │  (容器)        │
    └────────────────┘              └────────────────┘
```

### 1.3 核心组件

#### 组件 A: Web UI（前端）

- 看板视图（任务状态、Agent 在线状态）
- 任务详情（时间线、日志、产物）
- Agent 控制台（实时监控、手动控制）

#### 组件 B: Orchestrator（后端核心）

职责：

- **任务调度**: Issue → Run → 选择 Agent → 分发
- **状态管理**: 维护 Run 状态机（Planning / Editing / Testing / ...）
- **事件聚合**: 汇总 ACP events + Git events + CI events → 统一时间线
- **产物追踪**: PR、Branch、Patch、CI 结果
- **并发控制**: 同仓库锁、目录级锁
- **上下文管理**: Review 评论聚合、诊断信息收集

技术栈建议：

- Node.js / Go / Python (异步 I/O)
- PostgreSQL (存储 Issue/Run/Events)
- Redis (分布式锁、任务队列)
- WebSocket (实时推送)

#### 组件 C: ACP Proxy（本地代理）

**部署位置**: 用户本地电脑

**职责**:

1. **协议转换**: WebSocket (from Web) ↔ stdio (to Agent)
2. **进程管理**: 启动/停止/重启 agent 子进程
3. **健康检查**: 心跳、超时监控、异常重启
4. **双向消息转发**:
   - Web 看板的任务 → ACP JSON-RPC request → Agent stdin
   - Agent stdout → ACP JSON-RPC response → Web 看板

**实现示例** (Go 伪代码):

```text
启动流程:
  1) 读取 config.json
  2) Dial WebSocket（可带 Authorization: Bearer <token>）
  3) 发送 register_agent
  4) 启动三个循环:
     - ws read loop: 处理 execute_task/cancel_task
    - agent stdout read loop: 处理 session/update 并转发 acp_update
     - heartbeat loop: 定期发送 heartbeat

进程管理:
  - 使用 os/exec 启动 agent 子进程（例如 codex --acp）
  - stdin 写入 NDJSON（每行一个 JSON-RPC）
  - stdout 按行读取并 json decode
```

**配置文件**（支持 `--config` 指定；默认在用户配置目录下，如 `~/.config/acp-proxy/config.json` 或 Windows 的 `%AppData%`）:

```json
{
  "orchestrator_url": "ws://localhost:3000/ws/agent",
  "auth_token": "user_token_abc123",
  "agent": {
    "id": "codex-local-1",
    "name": "Codex Local Agent 1",
    "command": "codex",
    "args": ["--acp"],
    "capabilities": {
      "languages": ["go", "typescript"],
      "tools": ["git"]
    },
    "max_concurrent": 2,
    "workspace": "/path/to/projects"
  }
}
```

#### 组件 D: ACP Gateway（云端网关）

**部署位置**: 云端服务器（与 Orchestrator 同机房）

**职责**:

1. **容器化 Agent**: 每个 Run 启动独立的 Docker 容器运行 agent
2. **工作空间管理**: 自动 clone 代码、切换分支
3. **资源隔离**: CPU/内存限制、网络隔离
4. **stdio 通信**: 与容器内的 agent 进程 stdio 通信

**流程**:

```
1. Orchestrator 发起任务
   ↓
2. Gateway 启动 agent 容器
   ↓
3. 容器内执行: git clone + git checkout branch
   ↓
4. 通过 stdin 发送 ACP session/prompt
   ↓
5. 流式接收 stdout 的 session/update
   ↓
6. 任务完成后销毁容器
```

**Docker 配置示例**:

```yaml
# docker-compose.yml
services:
  agent-runner:
    image: agents/claude-code:latest
    command: ["--acp"]
    stdin_open: true
    volumes:
      - ${WORKSPACE_PATH}:/workspace
    environment:
      - ANTHROPIC_API_KEY=${API_KEY}
    network_mode: bridge
    mem_limit: 2g
    cpus: 1.5
```

#### 组件 E: SCM/CI Connectors（集成层）

- **GitHub Connector**: 监听 PR events、Checks、Comments
- **GitLab Connector**: 类似
- **CI Connector**: GitHub Actions / GitLab CI / Jenkins

---

## 2. 核心对象模型（数据结构）

### 2.1 核心实体

#### Project（项目）

```typescript
interface Project {
  id: string;
  name: string;
  repo_url: string; // e.g., "https://github.com/org/repo"
  scm_type: "github" | "gitlab" | "gitea";
  default_branch: string;

  // 保护分支策略
  branch_protection: {
    require_review_count: number;
    require_ci_pass: boolean;
    require_codeowner_approval: boolean;
  };

  // Agent 调度策略
  agent_allocation_strategy: "manual" | "auto";
}
```

#### Issue（任务）

```typescript
interface Issue {
  id: string;
  project_id: string;
  title: string;

  // 关键：为了让 agent 可执行，必须有明确的验收标准
  description: string; // 背景与目的
  acceptance_criteria: string[]; // DoD，可验证的标准
  constraints: string[]; // 不能改什么
  references: string[]; // 参考资料链接
  test_requirements: string; // 测试要求

  status: "pending" | "running" | "reviewing" | "done" | "failed";
  assigned_agent_id?: string;

  created_at: Date;
  updated_at: Date;
}
```

#### Run（执行实例）

```typescript
interface Run {
  id: string;
  issue_id: string;
  agent_id: string;

  // ACP 会话信息
  acp_session_id: string; // ACP 的 session ID

  // 工作空间
  workspace_type: "local" | "remote";
  workspace_path: string; // 本地路径或容器路径
  branch_name: string; // e.g., "acp/issue-123/run-456"

  // 状态
  status:
    | "initializing"
    | "planning"
    | "editing"
    | "testing"
    | "building"
    | "packaging"
    | "waiting_review"
    | "fixing"
    | "completed"
    | "failed"
    | "cancelled";

  // 时间戳
  started_at: Date;
  completed_at?: Date;

  // 失败信息
  failure_reason?: FailureReason;
  diagnosis?: DiagnosisPacket;
}
```

#### Event（事件 - 时间线核心）

```typescript
interface Event {
  id: string;
  run_id: string;
  timestamp: Date;

  // 事件来源
  source: "acp" | "git" | "ci" | "user" | "system";

  // 事件类型
  type: EventType; // 见下文枚举

  // 事件数据
  payload: Record<string, any>;

  // 元数据
  metadata: {
    agent_id?: string;
    user_id?: string;
    file_path?: string;
    commit_sha?: string;
  };
}

enum EventType {
  // ACP 事件
  ACP_SESSION_STARTED = "acp.session.started",
  ACP_PROMPT_SENT = "acp.prompt.sent",
  ACP_UPDATE_RECEIVED = "acp.update.received",
  ACP_TOOL_CALL = "acp.tool.call",
  ACP_PERMISSION_REQUESTED = "acp.permission.requested",
  ACP_SESSION_COMPLETED = "acp.session.completed",

  // Git 事件
  GIT_BRANCH_CREATED = "git.branch.created",
  GIT_COMMIT_PUSHED = "git.commit.pushed",
  GIT_PR_CREATED = "git.pr.created",
  GIT_PR_UPDATED = "git.pr.updated",

  // CI 事件
  CI_CHECK_STARTED = "ci.check.started",
  CI_CHECK_PASSED = "ci.check.passed",
  CI_CHECK_FAILED = "ci.check.failed",

  // Review 事件
  REVIEW_COMMENT_ADDED = "review.comment.added",
  REVIEW_CHANGES_REQUESTED = "review.changes.requested",
  REVIEW_APPROVED = "review.approved",

  // 系统事件
  SYSTEM_AGENT_ASSIGNED = "system.agent.assigned",
  SYSTEM_RUN_RETRIED = "system.run.retried",
  SYSTEM_RUN_FAILED = "system.run.failed",
}
```

#### Artifact（产物）

```typescript
interface Artifact {
  id: string;
  run_id: string;
  type: "branch" | "pr" | "patch" | "report" | "ci_result";

  // 具体内容
  content: {
    // 对于 PR
    pr_url?: string;
    pr_number?: number;
    branch_name?: string;

    // 对于 Patch
    diff_content?: string;

    // 对于 Report
    summary?: string;
    details?: string;
  };

  created_at: Date;
}
```

#### Agent（执行者）

```typescript
interface Agent {
  id: string;
  name: string;
  type: "local" | "remote";

  // 连接信息
  connection: {
    // 本地 agent
    proxy_id?: string; // 关联的 ACP Proxy

    // 远程 agent
    gateway_id?: string; // 关联的 ACP Gateway
  };

  // 能力标签
  capabilities: {
    languages: string[]; // ['javascript', 'python', 'go']
    frameworks: string[]; // ['react', 'django', 'gin']
    tools: string[]; // ['git', 'docker', 'npm']
  };

  // 状态
  status: "online" | "offline" | "degraded" | "suspended";
  current_load: number; // 当前并发 Run 数
  max_concurrent_runs: number;

  // 统计
  stats: {
    total_runs: number;
    success_count: number;
    failure_count: number;
    avg_duration_seconds: number;
  };
}
```

### 2.2 复合数据结构

#### DiagnosisPacket（诊断包 - 失败时自动生成）

```typescript
interface DiagnosisPacket {
  run_id: string;
  failure_reason: FailureReason;

  // 自动收集的信息
  last_200_lines_log: string;
  changed_files: string[];
  pr_status: {
    url: string;
    checks: CheckResult[];
  };

  // 环境信息
  environment: {
    agent_version: string;
    os: string;
    git_version: string;
    node_version?: string;
    python_version?: string;
  };

  // 可复现的命令建议
  reproduction_commands: string[];

  created_at: Date;
}

enum FailureReason {
  BUILD_FAILED = "build_failed",
  TEST_FAILED = "test_failed",
  LINT_FAILED = "lint_failed",
  ENV_MISSING = "env_missing",
  PERMISSION_DENIED = "permission_denied",
  MERGE_CONFLICT = "merge_conflict",
  TIMEOUT = "timeout",
  TOOL_ERROR = "tool_error",
  AGENT_CRASH = "agent_crash",
}
```

#### ReworkPacket（返工包 - Review 评论聚合）

```typescript
interface ReworkPacket {
  run_id: string;
  pr_url: string;

  // 聚合的评论
  blocking_items: ReviewComment[]; // 必须修复
  suggestions: ReviewComment[]; // 建议

  // CI 失败信息
  failed_checks: {
    check_name: string;
    error_summary: string;
    log_url: string;
  }[];

  // 生成的下一轮指令（给 agent）
  next_prompt: string; // 由 Orchestrator 自动生成

  created_at: Date;
}

interface ReviewComment {
  author: string;
  file_path: string;
  line_number: number;
  comment: string;
  related_acceptance_criteria?: string; // 关联到哪个验收条目
}
```

---

## 3. 三条主流程（端到端）

### 流程 A: 从任务到 PR 的主流程

#### A1. 创建任务

**入口**: Web UI → 创建 Issue

**必填字段**:

- 标题
- 描述（Why）
- 验收标准（DoD，至少 1 条）
- 约束条件（可选）
- 测试要求

**系统自动补全**:

- 推荐 Agent（根据能力标签匹配）
- 影响范围猜测（根据相关文件路径）

#### A2. 指派 Agent

**手动模式**:

```
用户选择 Agent → Orchestrator 创建 Run → 调用 Agent
```

**自动模式**:

```
Orchestrator 根据策略自动选择:
1. 能力匹配（Issue 需要的技术栈 vs Agent 能力）
2. 负载均衡（优先选择空闲的 Agent）
3. 环境匹配（本地 vs 远程）
```

#### A3. Agent 执行（ACP 协议交互）

**序列图**:

```
┌──────────┐         ┌─────────────┐         ┌────────┐
│Orchestrator│         │ ACP Proxy   │         │ Agent  │
└──────┬───┘         └──────┬──────┘         └───┬────┘
       │                    │                    │
       │ 1. dispatch(task)  │                    │
       ├───────────────────>│                    │
       │                    │ 2. start_process() │
       │                    ├───────────────────>│
       │                    │                    │
       │                    │ 3. initialize      │
       │                    │<───────────────────│
       │                    │ InitializeResponse │
       │                    ├───────────────────>│
       │                    │                    │
       │                    │ 4. session/new     │
       │                    ├───────────────────>│
       │                    │ NewSessionResponse │
       │                    │<───────────────────│
       │                    │                    │
       │                    │ 5. session/prompt  │
       │                    │    (任务描述)      │
       │                    ├───────────────────>│
       │                    │                    │
       │                    │ 6. session/update  │
       │   Event: Planning  │<──────────(流式)───│
       │<───────────────────│                    │
       │                    │                    │
       │                    │ 7. session/update  │
       │   Event: Editing   │<──────────(流式)───│
       │<───────────────────│                    │
       │                    │                    │
       │                    │ 8. PromptResponse  │
       │   Event: Done      │<───────────────────│
       │<───────────────────│                    │
```

**ACP 消息示例**:

```json
// Orchestrator → Agent: 发送任务
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess-abc123",
    "prompt": [
      {
        "type": "text",
        "text": "任务: 实现用户登录功能\n\n验收标准:\n1. 支持邮箱+密码登录\n2. 密码错误3次后锁定账户\n3. 登录成功后跳转到首页\n\n约束:\n- 不能修改现有的 auth 模块 API\n- 必须通过所有单元测试"
      }
    ]
  }
}

// Agent → Orchestrator: 流式返回进度
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess-abc123",
    "update": {
      "type": "agentMessage",
      "content": [
        {
          "type": "text",
          "text": "我正在分析现有的 auth 模块..."
        }
      ]
    }
  }
}

// Agent → Orchestrator: 最终结果
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess-abc123",
    "stopReason": "end_turn",
    "output": [
      {
        "type": "text",
        "text": "已完成登录功能实现，PR 已创建: https://github.com/org/repo/pull/123"
      }
    ]
  }
}
```

#### A4. 产出 PR

**Agent 产出要求**:

- 创建分支: `acp/{issue_id}/{run_id}`
- 提交代码
- 创建 PR (标题、描述、关联 Issue)
- 变更摘要

**Orchestrator 记录**:

- 创建 Artifact (type: 'pr')
- 创建 Event (type: 'git.pr.created')
- 更新 Run 状态 → 'waiting_review'

#### A5. CI 检查

**流程**:

```
PR 创建 → 触发 CI → Orchestrator 监听 Webhook
→ 创建 Event (ci.check.started)
→ CI 完成 → 创建 Event (ci.check.passed/failed)
→ 更新 Run 状态
```

**失败处理**:

- 自动生成 DiagnosisPacket
- 可选：自动触发重试（根据失败原因）

#### A6. Review → Merge → Done

**Review 流程**:

```
Reviewer 在 PR 上评论
→ Orchestrator 收集评论（Webhook）
→ 创建 Event (review.comment.added)
→ 状态更新: 'reviewing'
```

**合并条件**:

- [ ] 所有 required checks 通过
- [ ] Reviewer 数量 ≥ N（根据项目配置）
- [ ] 可选：Codeowner 批准

**Done 标准**:

- PR merged（硬信号）
- DoD checklist 通过（软信号，可配置）

---

### 流程 B: Review 到返工的闭环

#### B1. 评论采集与聚合

**触发**: PR 收到 Review 评论或 CI 失败

**Orchestrator 动作**:

```python
async def aggregate_review_feedback(run_id: str):
    # 1. 从 GitHub API 获取 PR 评论
    pr_comments = await github_api.get_pr_comments(pr_url)

    # 2. 从 CI 获取失败信息
    failed_checks = await ci_api.get_failed_checks(pr_url)

    # 3. 分类
    blocking_items = []
    suggestions = []

    for comment in pr_comments:
        if comment.is_blocking:  # 根据关键词或标签判断
            blocking_items.append(comment)
        else:
            suggestions.append(comment)

    # 4. 关联验收标准
    for item in blocking_items:
        item.related_criteria = match_to_acceptance_criteria(
            item.comment,
            issue.acceptance_criteria
        )

    # 5. 创建返工包
    rework_packet = ReworkPacket(
        run_id=run_id,
        pr_url=pr_url,
        blocking_items=blocking_items,
        suggestions=suggestions,
        failed_checks=failed_checks,
        next_prompt=generate_rework_prompt(...)  # 见下文
    )

    return rework_packet
```

**生成下一轮 Prompt**:

```python
def generate_rework_prompt(rework_packet: ReworkPacket) -> str:
    prompt = f"""
当前 PR 状态: {rework_packet.pr_url}

必须修复的问题:
"""
    for i, item in enumerate(rework_packet.blocking_items):
        prompt += f"\n{i+1}. [{item.file_path}:{item.line_number}] {item.comment}"
        if item.related_criteria:
            prompt += f"\n   (关联验收标准: {item.related_criteria})"

    if rework_packet.failed_checks:
        prompt += "\n\nCI 失败:\n"
        for check in rework_packet.failed_checks:
            prompt += f"- {check.check_name}: {check.error_summary}\n"
            prompt += f"  日志: {check.log_url}\n"

    prompt += """
\n请修复以上问题并更新 PR。对于每个问题，请在提交信息中说明如何解决。
"""
    return prompt
```

#### B2. 自动触发下一轮

**策略选择**:

**策略 1: 同一 Session 继续**（推荐，保持上下文）

```python
# 使用 ACP 的 session/prompt，sessionId 不变
await acp_proxy.send_prompt(
    session_id=run.acp_session_id,
    prompt=rework_packet.next_prompt
)
```

**策略 2: 新 Session**（更干净，但丢失部分上下文）

```python
# 创建新的 session，但在 prompt 中包含历史
await acp_proxy.send_prompt(
    session_id=new_session_id,
    prompt=f"""
历史背景:
{original_task}

第一轮产出:
{first_pr_summary}

需要返工的原因:
{rework_packet.next_prompt}
"""
)
```

#### B3. Agent 修复并更新 PR

**Agent 动作**:

1. 在同一分支上继续修改
2. 提交新的 commit
3. Push → 自动更新 PR
4. （可选）回复 Review 评论说明修复内容

**Orchestrator 追踪**:

- 创建 Event (git.pr.updated)
- 创建 Event (ci.check.started)（新的 CI 运行）
- 更新 Run 状态 → 'fixing'

#### B4. 循环直到通过

**退出条件**:

- ✅ 所有 Review 批准
- ✅ CI 全绿
- ✅ 合并完成

**保护机制**:

- 最大重试次数（例如 3 次）
- 超过次数 → 标记为 'needs_human_intervention'
- 通知人工接管

---

### 流程 C: 失败到接管的恢复

#### C1. 失败检测与分类

**触发点**:

- Agent 进程崩溃
- ACP 超时无响应
- CI 持续失败
- 明确的错误响应

**自动分类**:

```python
def classify_failure(run: Run, events: List[Event]) -> FailureReason:
    # 检查最近的事件
    last_events = events[-10:]

    # 1. 检查是否有 CI 失败事件
    for event in last_events:
        if event.type == EventType.CI_CHECK_FAILED:
            check_name = event.payload['check_name']

            if 'build' in check_name:
                return FailureReason.BUILD_FAILED
            elif 'test' in check_name:
                return FailureReason.TEST_FAILED
            elif 'lint' in check_name:
                return FailureReason.LINT_FAILED

    # 2. 检查 agent 错误
    for event in last_events:
        if event.type == EventType.ACP_UPDATE_RECEIVED:
            if 'permission denied' in event.payload.get('text', '').lower():
                return FailureReason.PERMISSION_DENIED

    # 3. 检查超时
    elapsed = datetime.now() - run.started_at
    if elapsed > timedelta(hours=2):
        return FailureReason.TIMEOUT

    # 默认
    return FailureReason.AGENT_CRASH
```

#### C2. 自动生成诊断包

**信息收集**:

```python
async def generate_diagnosis(run: Run, failure_reason: FailureReason):
    # 1. 收集日志
    logs = await get_recent_logs(run.id, lines=200)

    # 2. 获取变更文件
    changed_files = await git_api.get_changed_files(run.branch_name)

    # 3. 获取 PR 和 CI 状态
    pr_status = None
    if run.pr_url:
        pr_status = await github_api.get_pr_checks(run.pr_url)

    # 4. 环境信息
    env_info = await agent_api.get_environment_info(run.agent_id)

    # 5. 生成复现命令
    reproduction_commands = generate_repro_commands(
        failure_reason,
        changed_files,
        pr_status
    )

    return DiagnosisPacket(
        run_id=run.id,
        failure_reason=failure_reason,
        last_200_lines_log=logs,
        changed_files=changed_files,
        pr_status=pr_status,
        environment=env_info,
        reproduction_commands=reproduction_commands,
        created_at=datetime.now()
    )
```

#### C3. 恢复选项

**选项 1: 一键重跑**

```
用户点击"Retry" → Orchestrator 创建新 Run
→ 继承上下文（issue、历史 events、诊断包）
→ 同一 Agent、同一分支
```

**选项 2: 换 Agent 接管**

```
用户选择"Reassign to agent-B" → 创建新 Run
→ 继承上下文
→ 新 Agent、可选新分支或继续原分支
```

**选项 3: 人工接管**

```
用户点击"Take Over" → Run 标记为 'human_taken_over'
→ 提供诊断包、分支信息、PR 链接
→ 人工修复后手动标记 Done
```

**继承内容定义**:

```typescript
interface RunContext {
  // 原始任务
  original_issue: Issue;

  // 历史执行记录
  previous_runs: {
    run_id: string;
    agent_id: string;
    outcome: "success" | "failed";
    diagnosis?: DiagnosisPacket;
  }[];

  // 已有产物
  existing_artifacts: {
    branch?: string;
    pr_url?: string;
    commits?: string[];
  };

  // Review 历史
  review_history: ReworkPacket[];
}
```

---

## 4. Agent 管理

### 4.1 Agent 注册与连接

#### 本地 Agent (via ACP Proxy)

**注册流程**:

```
1. 用户安装 ACP Proxy
   ↓
2. 配置 agents (config.json)
   ↓
3. 启动 Proxy: acp-proxy start
   ↓
4. Proxy 连接到 Web 看板 (WebSocket)
   ↓
5. 发送注册消息:
   {
     "type": "register_agents",
     "agents": [...]
   }
   ↓
6. Web 看板更新 Agent 状态: 'online'
```

**心跳机制**:

```text
心跳循环（ACP Proxy 侧）:
  - 每 30s 发送一次 heartbeat
  - payload 至少包含: agent_id/current_load/available_capacity（或等价字段）
  - 断线重连后应立即发送一次 heartbeat 或重新注册
```

#### 远程 Agent (via ACP Gateway)

**管理方式**:

- 预配置的 Agent 池
- 按需启动容器
- 自动扩缩容

### 4.2 Agent 能力画像

**标签体系**:

```typescript
interface AgentCapabilities {
  // 编程语言
  languages: {
    javascript: "expert" | "intermediate" | "basic";
    python: "expert" | "intermediate" | "basic";
    go: "expert" | "intermediate" | "basic";
    // ...
  };

  // 框架
  frameworks: string[]; // ['react', 'vue', 'django', 'spring']

  // 工具
  tools: string[]; // ['git', 'docker', 'kubernetes', 'terraform']

  // 特殊能力
  special: string[]; // ['database-migration', 'api-design', 'performance-tuning']
}
```

**匹配算法**:

```python
def calculate_agent_score(issue: Issue, agent: Agent) -> float:
    score = 0.0

    # 1. 语言匹配（从 Issue 描述中提取关键词）
    required_langs = extract_languages_from_text(issue.description)
    for lang in required_langs:
        if lang in agent.capabilities.languages:
            level = agent.capabilities.languages[lang]
            score += {'expert': 3, 'intermediate': 2, 'basic': 1}[level]

    # 2. 框架匹配
    required_frameworks = extract_frameworks_from_text(issue.description)
    for fw in required_frameworks:
        if fw in agent.capabilities.frameworks:
            score += 2

    # 3. 工作负载（优先选择空闲的）
    capacity_ratio = agent.current_load / agent.max_concurrent_runs
    score *= (1 - capacity_ratio * 0.5)  # 负载越高，分数折扣越大

    # 4. 历史成功率
    if agent.stats.total_runs > 0:
        success_rate = agent.stats.success_count / agent.stats.total_runs
        score *= (0.5 + success_rate * 0.5)

    return score
```

### 4.3 Agent 监控面板

**实时指标**:

- 在线状态
- 当前负载 (X / Y)
- 正在执行的 Run 列表
- 最近 10 次执行结果

**历史统计**:

- 总执行次数
- 成功率
- 平均耗时
- 失败原因 Top 5

**快捷操作**:

- 暂停接收新任务
- 取消当前 Run
- 重启连接
- 隔离（suspend，暂时不分配）

---

## 5. 产品决策（关键配置）

### 决策 1: 默认产物类型

**选择**: PR 优先

**理由**:

- Review 闭环需要 PR（评论、批准）
- CI 集成依赖 PR 触发
- 代码审查最佳实践

**替代方案**: Patch 文件

- 适用场景：无法创建 PR 的情况（权限限制）
- 需要额外的 review 流程

### 决策 2: 工作空间隔离策略

**选择**: 每个 Run 独立 worktree + 独立分支

**理由**:

- 同一台机器多 Agent 并发安全
- 避免文件冲突
- 易于清理

**实现**:

```bash
# 为 Run 创建 worktree
git worktree add /tmp/acp-workspaces/run-123 -b acp/issue-456/run-123

# Run 完成后清理
git worktree remove /tmp/acp-workspaces/run-123
```

### 决策 3: 合并权限

**选择**: 人类合并，Agent 不自动合并

**理由**:

- 保护主分支安全
- 保留最终审批权
- 符合企业规范

**例外**: 可配置"自动合并"（适用于完全信任的 Agent + 严格的 CI）

### 决策 4: 返工策略

**选择**: 优先在原 PR 上修复

**理由**:

- 保留 Review 上下文（评论、历史）
- 减少 PR 数量
- Reviewer 无需重新审查整个 PR

**替代方案**: 创建新 PR

- 适用场景：修改过大，需要"重来"

### 决策 5: 任务定义版本化

**选择**: Issue 修改后生成新版本，Run 绑定版本

**目的**: 避免"需求变了"的扯皮

**实现**:

```typescript
interface Issue {
  id: string;
  current_version: number;
  versions: IssueVersion[];
}

interface IssueVersion {
  version: number;
  description: string;
  acceptance_criteria: string[];
  updated_at: Date;
  updated_by: string;
}

interface Run {
  issue_version: number; // 绑定具体版本
}
```

---

## 6. MVP 范围（分阶段）

### P0-Minimal (2-3 周，快速验证)

**目标**: 跑通"Issue → Agent → PR"最小闭环

**功能清单**:

- [ ] Web UI: 基础看板 + 任务详情页
- [ ] Orchestrator: 任务调度 + 状态管理
- [ ] ACP Proxy: 本地部署 + stdio ↔ WebSocket 转换
- [ ] Agent 管理: 注册 + 心跳 + 在线状态
- [ ] 执行流程: Issue → Run → ACP session/prompt → PR 创建
- [ ] 事件时间线: 基础版（只记录 ACP messages）
- [ ] GitHub 集成: PR 创建、Webhook 监听

**不包含**:

- ❌ Review 闭环
- ❌ CI 集成
- ❌ 失败诊断
- ❌ 重试/接管

### P0-Complete (4-6 周)

**在 Minimal 基础上增加**:

- [ ] Review 评论聚合 + 返工闭环
- [ ] CI 状态回写
- [ ] 失败分类 + 诊断包生成
- [ ] 一键重跑 / 换 Agent 接管
- [ ] ACP Gateway（远程 Agent 支持）
- [ ] 完整时间线（ACP + Git + CI + User）

### P1 (后续迭代)

- [ ] Agent 能力自动学习（根据历史成功率）
- [ ] 多项目并行
- [ ] 高级权限控制（RBAC）
- [ ] 成本分析（Agent 调用次数、时长）
- [ ] 集成更多 SCM（GitLab、Gitea）

---

## 7. 关键技术挑战与解决方案

### 挑战 1: stdio 协议在网络环境下的稳定性

**问题**: stdio 不是面向网络的协议，连接断开怎么办？

**解决**:

```python
class ResilientACPProxy:
    def __init__(self):
重连与会话恢复（实现要点）:

- 重连策略：指数退避（含 jitter），允许上限或无限重试
- 重连成功后：立即重新注册 Agent，并补发一次 heartbeat
- 会话恢复：若 Proxy 本地仍保留 `session_id -> run_id` 映射，可向 Orchestrator 发 `session_restored`（或等价事件）用于时间线补齐
- 退出/取消：统一由 `context`（Go）或等价机制控制，确保 goroutine/子进程可被收敛
```

### 挑战 2: ACP 消息的正确解析

**问题**: JSON-RPC over stdio 依赖换行符分隔，如何处理格式错误？

**解决**:

```python
import json

async def read_jsonrpc_messages(stream):
    buffer = ""

    async for line in stream:
        buffer += line

        # 尝试解析
        try:
            msg = json.loads(buffer)
            yield msg
            buffer = ""  # 清空缓冲区

        except json.JSONDecodeError:
            # 可能是多行 JSON，继续读取
            if len(buffer) > 100000:  # 防止无限增长
                logging.error("Invalid JSON-RPC message")
                buffer = ""
```

### 挑战 3: 并发 Agent 的文件冲突

**问题**: 同一仓库，多个 Agent 同时操作不同分支

**解决**: Git worktree + 分支命名规范

```python
class WorkspaceAllocator:
    def __init__(self):
        self.worktree_base = "/tmp/acp-workspaces"

    def allocate(self, run_id: str, repo_path: str) -> str:
        worktree_path = f"{self.worktree_base}/{run_id}"
        branch_name = f"acp/{run_id}"

        # 创建 worktree
        subprocess.run([
            "git", "-C", repo_path,
            "worktree", "add", worktree_path, "-b", branch_name
        ])

        return worktree_path

    def release(self, run_id: str, repo_path: str):
        worktree_path = f"{self.worktree_base}/{run_id}"

        # 删除 worktree
        subprocess.run([
            "git", "-C", repo_path,
            "worktree", "remove", worktree_path
        ])
```

### 挑战 4: Review 评论的智能理解

**问题**: 评论可能模糊、矛盾，如何转换为可执行指令？

**解决**: MVP 阶段采用简单策略

```python
def generate_rework_prompt_simple(comments: List[ReviewComment]) -> str:
    """简单策略：直接罗列评论，不做智能理解"""

    prompt = "以下是 Reviewer 的评论，请逐条修复:\n\n"

    for i, comment in enumerate(comments):
        prompt += f"{i+1}. [{comment.file_path}:{comment.line_number}]\n"
        prompt += f"   {comment.comment}\n\n"

    prompt += "修复完成后更新 PR，并在每个 commit message 中引用对应的评论编号。"

    return prompt

# 未来优化: 使用 LLM 理解评论并生成结构化指令
async def generate_rework_prompt_smart(comments):
    # 调用 LLM
    structured = await llm.analyze_review_comments(comments)

    # 返回更精确的指令
    return structured.to_prompt()
```

---

## 8. 附件规格（后续补充）

### 附件 A: 事件模型与状态机

**内容**:

- 完整的 EventType 枚举（100+ 种）
- 每种事件的 payload schema
- Run 状态机（状态转移图）
- 事件如何驱动状态变更

### 附件 B: 对象字段数据字典

**内容**:

- 所有实体的字段详细定义
- 数据类型、约束、默认值
- 外键关系图
- 数据库 schema (DDL)

### 附件 C: ACP 集成规范

**内容**:

- ACP Proxy 详细设计
- 协议转换规则（WebSocket ↔ stdio）
- 错误处理流程
- 重连机制
- 示例代码（Python / TypeScript）

### 附件 D: RBAC 权限矩阵

**内容**:

- 角色定义（Manager / Reviewer / Observer / Admin）
- 权限矩阵（角色 × 操作）
- API 鉴权规则

### 附件 E: GitHub/GitLab 集成细则

**内容**:

- Webhook 配置
- API 调用列表
- PR 字段映射
- Review 状态映射
- CI 集成方案

---

## 9. 下一步行动

### 需要你确认的问题

1. **优先支持的 SCM 平台**: GitHub / GitLab / Gitea？（可多选）
2. **主要用户场景**: 本地 Agent 为主 or 云端 Agent 为主？
3. **Agent 来源**: 自己开发 or 使用现成的（Claude Code / OpenCode / Gemini CLI）？
4. **部署方式**: SaaS or 私有部署 or 混合？

### 技术验证建议

**PoC 1**: ACP Proxy 可行性验证（1 周）

- 实现最简单的 WebSocket ↔ stdio 桥接
- 用 Gemini CLI 或 Claude Code 测试
- 确认消息格式正确、延迟可接受

**PoC 2**: 端到端流程验证（2 周）

- 搭建最小 Orchestrator
- 跑通: 创建 Issue → 调用 Agent → 创建 PR
- 验证 worktree 隔离方案

### 文档产出计划

如果你确认以上内容，我可以继续产出:

1. **附件 C: ACP 集成规范** (含完整代码示例)
2. **附件 E: GitHub 集成细则** (基于 GitHub API v3/v4)
3. **PoC 实现指南** (Step-by-step)

---

**请回复你对以下问题的选择，我会据此深化 PRD**:

1. SCM 平台: GitHub / GitLab / Gitea？
2. Agent 部署偏好: 本地为主 / 云端为主 / 混合？
3. 是否需要我先出 PoC 实现指南？
