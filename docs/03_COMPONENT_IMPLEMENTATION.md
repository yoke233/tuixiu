# 组件实现要点（当前仓库）

本文档以“代码导航”为主：告诉你**现在哪些功能已经实现**、**落在哪些文件**、以及关键数据结构/接口约定。旧版“手写 SQL/伪代码/Go Proxy”内容已过时并已从仓库实现中移除。

---

## 1. 仓库结构

```
backend/     # Fastify + WebSocket + Prisma（Orchestrator）
acp-proxy/   # Node/TS：WS ↔ ACP(stdio/NDJSON)，启动本机 ACP agent
frontend/    # React + Vite：Issue 列表/详情 + RunConsole + 变更/PR 操作
```

---

## 2. 数据模型（Prisma）

以 `backend/prisma/schema.prisma` 为准，核心表/模型：

- `Project`：仓库与 SCM 配置（GitLab/GitHub token 目前存 DB）
- `Issue`：需求池实体（默认 `pending`）
- `Agent`：由 proxy 通过 WebSocket 注册/心跳维护在线状态
- `Run`：一次执行实例（绑定 `issueId/agentId`，并持久化 `acpSessionId/workspacePath/branchName`）
- `Event`：事件流（ACP update、用户消息、系统事件等）
- `Artifact`：产物（`branch`、`pr`、`ci_result` 等）

状态枚举（同 `schema.prisma`）：

- `IssueStatus`: `pending|running|reviewing|done|failed|cancelled`
- `RunStatus`: `pending|running|waiting_ci|completed|failed|cancelled`
- `ArtifactType`: `branch|pr|patch|report|ci_result`

ID 生成：

- Prisma schema 默认 `uuid()`；应用层在写入时使用 `uuidv7()`（见 `backend/src/utils/uuid.ts`）以获得更好的时间排序特性。

---

## 3. 后端（Orchestrator）实现位置

入口：

- `backend/src/index.ts`：Fastify 启动、路由注册、WebSocket 网关初始化

路由：

- `backend/src/routes/projects.ts`
  - `GET /api/projects`
  - `POST /api/projects`（创建 Project 并写入 SCM 配置字段）
- `backend/src/routes/issues.ts`
  - `POST /api/issues`：创建 Issue（进入需求池 `pending`，不自动执行）
  - `POST /api/issues/:id/start`：选择/自动分配 Agent，创建 Run + worktree，并下发 `execute_task`
  - `GET /api/issues/:id` / `GET /api/issues` / `PATCH /api/issues/:id`
- `backend/src/routes/runs.ts`
  - `GET /api/runs/:id` / `GET /api/runs/:id/events`
  - `POST /api/runs/:id/prompt`：继续对话（尽量复用 `Run.acpSessionId`）
  - `GET /api/runs/:id/changes` / `GET /api/runs/:id/diff?path=...`
  - `POST /api/runs/:id/create-pr` / `POST /api/runs/:id/merge-pr`
  - `POST /api/runs/:id/cancel` / `POST /api/runs/:id/complete`
- `backend/src/routes/agents.ts`
  - `GET /api/agents`

服务/工具：

- `backend/src/websocket/gateway.ts`：/ws/agent 与 /ws/client，负责 agent 注册、event 落库、前端广播
- `backend/src/utils/gitWorkspace.ts`：Run worktree 与分支命名（`run/<worktreeName>`）
- `backend/src/services/runContext.ts`：从 Issue + Events 拼装对话上下文（用于 session 丢失降级）
- `backend/src/services/runGitChanges.ts`：获取变更文件列表与 diff
- `backend/src/services/runReviewRequest.ts`：统一 PR 抽象（GitLab MR / GitHub PR）创建/合并
- `backend/src/integrations/gitlab.ts` / `backend/src/integrations/github.ts`：provider 细节

---

## 4. WebSocket（Agent/前端）约定

端点：

- Agent（proxy）连接：`/ws/agent`
- Web UI 连接：`/ws/client`

关键消息（以 `backend/src/websocket/gateway.ts` 为准）：

- Agent → backend：`register_agent` / `heartbeat` / `agent_update`
- backend → Agent：`execute_task` / `prompt_run`
- backend → Web UI：`event_added` / `artifact_added`

Run 状态推进：

- proxy 转发 ACP 的 `prompt_result` 后，backend 会将 `Run` 从 `running` 推进到 `completed`，并将 `Issue` 推进到 `reviewing`。

---

## 5. Run 工作区（worktree）与 PR 工作流

### 5.1 worktree

启动 Run 时创建：

- worktree：`<repoRoot>/.worktrees/run-<worktreeName>`
- branch：`run/<worktreeName>`

并将 `cwd=<worktreePath>` 下发给 proxy，使 agent 在隔离工作区内运行。

### 5.2 PR（统一抽象）

系统统一称 “PR”（artifact.type=`pr`）：

- GitLab 侧术语为 MR（Merge Request）
- GitHub 侧术语为 PR（Pull Request）

后端提供统一端点：

- 创建：`POST /api/runs/:id/create-pr`
- 合并：`POST /api/runs/:id/merge-pr`

实现入口：`backend/src/services/runReviewRequest.ts`

---

## 6. 前端实现位置

页面：

- `frontend/src/pages/IssueListPage.tsx`：Issue 列表（含状态过滤、跳转详情）
- `frontend/src/pages/IssueDetailPage.tsx`：Issue 详情（启动 Run、对话、控制台、变更、PR）

关键组件：

- `frontend/src/components/RunConsole.tsx`：ACP 事件 → 可读 console（chunk 合并、tool_call 折叠、粘滞滚动）
- `frontend/src/components/RunChangesPanel.tsx`：变更文件列表 + diff
- `frontend/src/components/ThemeToggle.tsx`：浅色/深色切换

WebSocket：

- `frontend/src/hooks/useWsClient.ts`：连接 `/ws/client`，接收 `event_added/artifact_added` 推动 UI 实时更新

---

## 7. Proxy（acp-proxy）实现位置

- 入口：`acp-proxy/src/index.ts`
- ACP 桥接：`acp-proxy/src/acpBridge.ts`
- 配置：`acp-proxy/config.json`（示例见 `acp-proxy/config.json.example`）

协议细节与 session 策略：见 `docs/04_ACP_INTEGRATION_SPEC.md`。
