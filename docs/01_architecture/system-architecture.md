---
title: "系统架构文档（当前仓库）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# 系统架构文档（当前仓库）

本文档描述本仓库 MVP 的真实架构与数据流（旧版“自动调度器/Go Proxy/Python 方案/从零搭建”内容已过时）。

---

## 1. 三层架构

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 1：Web UI（frontend/）                                 │
│ - Issue 列表（需求池）                                       │
│ - Issue 详情（RunConsole + 对话 + 变更 + PR）                 │
│ - 主题切换（浅色/深色）                                      │
│                                                              │
│  HTTP: /api/*                      WS: /ws/client            │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────┐
│ Layer 2：Orchestrator（backend/）                             │
│ - REST API：projects/issues/runs/agents                        │
│ - WebSocket Gateway：/ws/agent（proxy）+ /ws/client（Web UI）  │
│ - 数据持久化：PostgreSQL（Prisma）                            │
│ - Git 工作区：run worktree + 分支管理                         │
│ - SCM：GitLab MR / GitHub PR（统一抽象为 PR）                 │
└───────────────────────────────┬──────────────────────────────┘
                                │  WS: /ws/agent
┌───────────────────────────────┴──────────────────────────────┐
│ Layer 3：本地执行层（acp-proxy/）                              │
│ - WS ↔ ACP(stdio/NDJSON) 桥接                                  │
│ - 启动 ACP agent 子进程（默认 npx @zed-industries/codex-acp）   │
│ - Session 复用（session/load 可选）+ 丢失降级（context 注入）   │
└───────────────────────────────┬──────────────────────────────┘
                                │ stdio/NDJSON
┌───────────────────────────────┴──────────────────────────────┐
│ ACP Agent（子进程）                                            │
└──────────────────────────────────────────────────────────────┘

外部依赖：
- Git 远端：GitLab / GitHub（用于 push 分支、创建/合并 PR）
- 本地 Git：worktree/commit/diff
```

---

## 2. 核心数据流（MVP）

### 2.1 需求池：创建 Issue（不自动执行）

1. Web UI 调用 `POST /api/issues` 创建 Issue
2. Issue 默认状态 `pending`（需求池）

设计动机：创建需求 ≠ 立即运行。运行需要明确选择/分配 agent 与工作区资源。

### 2.2 启动 Run：选择/自动分配 Agent + 创建 worktree

1. Web UI 调用 `POST /api/issues/:id/start`（可选传 `agentId/roleKey/worktreeName`）
2. backend 选择可用 Agent（在线且未满载）
3. backend 创建 Run（`status=running`）
4. backend 创建独立 Git worktree 与分支（`run/<worktreeName>`，路径 `.worktrees/run-<worktreeName>`）
5. backend 通过 `/ws/agent` 下发 `execute_task { run_id, prompt, cwd }`

实现参考：

- `backend/src/routes/issues.ts`
- `backend/src/utils/gitWorkspace.ts`

### 2.3 执行与实时输出：事件流

1. proxy 将 `execute_task` 转成 ACP `session/new` + `session/prompt`
2. agent 通过 `session/update` 流式输出 chunk/tool_call
3. proxy 以 `agent_update` 形式转发给 backend
4. backend 写入 `Event` 并广播到 `/ws/client`
5. Web UI 的 RunConsole 增量渲染（chunk 合并、tool 折叠）

实现参考：

- `acp-proxy/src/index.ts`
- `backend/src/websocket/gateway.ts`
- `frontend/src/components/RunConsole.tsx`

### 2.4 继续对话：复用 Run.acpSessionId

1. Web UI 调用 `POST /api/runs/:id/prompt`
2. backend 先写入 `user` event，再组装 `context`（Issue + 最近对话节选）
3. backend 通过 `/ws/agent` 下发 `prompt_run { session_id, context, cwd }`
4. proxy 尽量 `session/load` 恢复历史会话；确认为丢失时才新建并注入 context

实现参考：

- `backend/src/services/runContext.ts`
- `backend/src/routes/runs.ts`
- `acp-proxy/src/acpBridge.ts`

### 2.5 产出 PR：后端一键（统一抽象）

1. Run 完成后，Issue 进入 `reviewing`
2. Web UI 调用 `POST /api/runs/:id/create-pr`
3. backend 对分支执行 `git push`，再调用 GitLab/GitHub API 创建 PR
4. 写入 `Artifact(type=pr)`，并推进 Run 状态（例如 `waiting_ci`）

合并：

- `POST /api/runs/:id/merge-pr`：调用 provider merge，合并成功后推进 Issue `done`

实现参考：

- `backend/src/services/runReviewRequest.ts`
- `backend/src/integrations/gitlab.ts`
- `backend/src/integrations/github.ts`

---

## 3. 关键设计决策（与旧文档差异最大的点）

1. **Issue 是需求池**：创建 Issue 不立即执行；由 `/api/issues/:id/start` 触发 Run
2. **每个 Run 一个 worktree**：隔离并行修改，降低冲突，便于 diff/PR
3. **PR 抽象统一**：对 UI/API 暴露 “PR”，底层按 provider 处理（GitLab 实际为 MR）
4. **Session 复用优先**：尽量恢复历史 ACP session；丢失时用 context 注入降级

---

## 4. 扩展方向

见 `docs/00_overview/roadmap.md`，当前 P0 重点为：

- CI/Webhook 闭环（接 GitLab/GitHub webhook，驱动 `waiting_ci → completed/failed`）
- Review 工作流（通过/打回/重跑）
- Agent/Session 在线状态与断线提示策略
