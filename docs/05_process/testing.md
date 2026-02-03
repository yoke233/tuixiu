---
title: "测试计划（当前仓库）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# 测试计划（当前仓库）

本文档描述当前仓库的测试策略与执行方式。旧版 “Go proxy / Go testing / Python 示例” 内容已过时。

---

## 1. 测试策略

### 1.1 测试金字塔（MVP）

- **单元测试（主）**：纯函数、服务层、路由处理（Fastify inject + mock Prisma）、前端组件渲染
- **集成测试（轻量）**：WebSocket 网关的消息处理（mock ws + mock Prisma）
- **端到端（手动为主）**：本地三件套跑通“需求池 → Run → 对话 → 变更 → PR”

当前阶段的取舍：

- 优先保证路由/状态机/消息流的正确性（不依赖真实 DB/真实 agent）
- 真实 DB/真实 agent 的 E2E 暂以手动 smoke 为主（后续引入 Playwright/容器化测试）

---

## 2. 一键执行

在仓库根目录：

```powershell
pnpm test
pnpm test:coverage
```

分别在子项目执行：

```powershell
cd backend
pnpm test
pnpm test:coverage
```

```powershell
cd acp-proxy
pnpm test
pnpm test:coverage
```

```powershell
cd frontend
pnpm test
pnpm test:coverage
```

Lint/类型检查：

```powershell
pnpm lint
pnpm typecheck
```

---

## 3. 后端测试范围（backend/）

测试框架：Vitest  
主要风格：Fastify `server.inject(...)` + mock Prisma deps（不连真实数据库）

目录：

- `backend/test/routes/*.test.ts`：projects/issues/runs/agents 的路由行为与错误码
- `backend/test/websocket/gateway.test.ts`：`/ws/agent` 消息处理（register/heartbeat/acp_update/proxy_update）与广播行为
- `backend/test/config.test.ts`：环境变量校验（DATABASE_URL 等）

验收重点：

- Issue 创建默认进入需求池（`pending`）
- `/api/issues/:id/start` 能选择 agent、创建 Run、创建 worktree 并下发 `execute_task`
- `/api/runs/:id/prompt` 会写 user event，并下发 `prompt_run`（携带 `Run.acpSessionId` 与 `context`）
- `proxy_update` 中的 `session_created` 会落库到 `Run.acpSessionId`

---

## 4. Proxy 测试范围（acp-proxy/）

测试框架：Vitest  
重点：

- 配置解析与默认值：`acp-proxy/src/config.test.ts`
- Windows 下 `npx/pnpm` 启动兼容（cmd shim）的逻辑可通过单元测试/日志验证（不依赖真实 agent）

---

## 5. 前端测试范围（frontend/）

测试框架：Vitest + Testing Library  
目录：

- `frontend/src/pages/*.test.tsx`：Issue 列表/详情的渲染与关键交互
- 关键组件：RunConsole/RunChangesPanel 的渲染与合并逻辑（按需补齐）

---

## 6. 手动 Smoke（建议每次大改后跑一次）

1. 按 `docs/03_guides/environment-setup.md` 启动三件套（backend + proxy + frontend）
2. Web UI：
   - 创建 Project（配置 repoUrl + token）
   - 创建 Issue（pending）
   - 启动 Run（running）
   - 观察 RunConsole 输出与可继续对话
   - 查看变更与 diff
   - 创建 PR / 合并 PR（需要真实 GitLab/GitHub token）

---

## 7. 后续增强（规划）

- 引入真实 Postgres 的集成测试（docker compose + 独立测试库/迁移）
- 引入 Playwright 做 E2E（覆盖“UI → API → WS → proxy → UI”的完整链路）
- GitLab/GitHub webhook + CI 状态回写测试（见 `docs/00_overview/roadmap.md`）
