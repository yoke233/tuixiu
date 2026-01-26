# GitHub Issue 导入 + Role initScript（bash）实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 支持从 GitHub 导入已有 Issue 作为内部 Issue；支持 Project 默认角色（RoleTemplate），在 Run 启动前执行角色 `initScript`（bash，允许访问 `GH_TOKEN`），用于拉取/生成配置并落盘到 workspace / `$HOME`。

**Architecture:** `backend/` 负责存储 Project/RoleTemplate/外部 Issue 引用并在启动 Run 时下发 `init` 配置；`acp-proxy/` 在 `execute_task` 前执行 `initScript` 并将日志/结果回传，失败则让后端把 Run/Issue 标记为 failed 并回收 agent load；`frontend/` 提供最小 UI：导入 GitHub Issue、创建/选择 RoleTemplate 并启动 Run。

**Tech Stack:** Fastify + Prisma + Zod + Vitest；`acp-proxy`(Node/TS) + `bash`；React + Vite。

---

### Task 1: 数据模型与迁移（RoleTemplate + 外部 Issue 引用 + Project 默认角色）

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/*_add_role_templates_and_external_issue/*`
- Modify: `backend/src/deps.ts`

**Steps:**
1. 在 `Project` 增加 `defaultRoleKey`（可空）。
2. 在 `Issue` 增加 GitHub 外部引用字段（`externalProvider/externalId/externalNumber/externalUrl/externalState/externalLabels/lastSyncedAt`），并加唯一索引 `(projectId, externalProvider, externalId)`。
3. 新增 `RoleTemplate`（project 作用域）：`key/displayName/promptTemplate/initScript/initTimeoutSeconds` 等。
4. Run: `pnpm -C backend prisma generate`
5. Run: `pnpm -C backend prisma migrate dev --name add_role_templates_and_external_issue`（若无 DB，用 `--create-only`）

**Verification:**
- Run: `pnpm -C backend test`
- Expected: exit code 0

---

### Task 2: Backend API（GitHub Issue 导入 + RoleTemplate CRUD + Run.start 下发 init）

**Files:**
- Create: `backend/src/routes/githubIssues.ts`
- Create: `backend/src/routes/roleTemplates.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/issues.ts`
- Modify: `backend/src/integrations/github.ts`
- Modify: `backend/src/websocket/gateway.ts`
- Create: `backend/test/routes/githubIssues.test.ts`
- Modify: `backend/test/routes/issues.test.ts`
- Modify: `backend/test/websocket/gateway.test.ts`

**Steps:**
1. GitHub Issues API（backend integration）：
   - `listIssues()` / `getIssue()`，过滤 PR（`pull_request` 字段）。
2. 新增 routes：
   - `GET /api/projects/:id/github/issues`（分页列出，MVP 可只支持 `state/page/limit`）
   - `POST /api/projects/:id/github/issues/import`（支持 number 或 url，幂等导入）
3. RoleTemplate CRUD（project scope）：
   - `GET /api/projects/:id/roles`
   - `POST /api/projects/:id/roles`
   - `PATCH /api/projects/:id/roles/:roleId`
4. `POST /api/issues/:id/start` 增加 `roleKey`：
   - 解析 role（body.roleKey > project.defaultRoleKey）
   - 组装 prompt（基础 prompt + role.promptTemplate）
   - 下发 `init: { script, timeout_seconds, env }`（`env.GH_TOKEN`/`GITHUB_TOKEN` 来自 Project 的 `githubAccessToken`）
   - Run.metadata 写入 `{ roleKey }`（不写 token）
5. WebSocket gateway：识别 `content.type === "init_result"`，失败时将 Run/Issue 标记 failed 并回收 agent load。

**Verification:**
- Run: `pnpm -C backend test`
- Expected: 新增用例通过，且 `init_result` 能推进失败状态

---

### Task 3: Proxy 执行 initScript（bash）并回传结果；前端最小 UI 接入

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `acp-proxy/src/index.ts`
- (Optional) Create: `acp-proxy/src/initScript.ts`
- Modify: `frontend/src/api/issues.ts`
- Create: `frontend/src/api/roles.ts`
- Create: `frontend/src/api/githubIssues.ts`
- Modify: `frontend/src/pages/IssueListPage.tsx`
- Modify: `frontend/src/pages/IssueDetailPage.tsx`
- (Optional) Modify: `frontend/src/types.ts`
- (Optional) Modify/Create: `frontend/src/pages/*.test.tsx`

**Steps:**
1. 扩展 `execute_task` 消息：支持 `init: { script, timeout_seconds, env }`。
2. Proxy 在 `execute_task` 前运行 init：
   - `bash -lc <script>`，`cwd` 为 run workspace
   - stdout/stderr 作为 `agent_update { type:"text" }` 回传（前缀 `[init]`），并对 `GH_TOKEN/GITHUB_TOKEN` 做简单脱敏替换
   - 完成后回传 `agent_update { type:"init_result", ok, exitCode, error? }`
   - init 失败：不继续创建 ACP session/prompt
3. 前端最小 UI：
   - IssueList：增加“导入 GitHub Issue（number/url）”表单，调用 import API 后刷新列表
   - IssueDetail：启动 Run 时增加“选择 Role”下拉框（默认 project.defaultRoleKey），调用 startIssue 传 `roleKey`

**Verification:**
- Run: `pnpm -C acp-proxy test`
- Run: `pnpm -C frontend test`
- Expected: exit code 0

