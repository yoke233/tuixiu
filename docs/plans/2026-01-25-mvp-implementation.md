# MVP（ACP Orchestrator + Proxy + Web UI）实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 在本地（Windows/pwsh）跑通一个最小闭环：创建 Project → 创建 Issue → 后端调度到在线 Agent（Proxy）→ Proxy 通过 ACP（`@zed-industries/codex-acp`）执行并回传事件 → 后端落库并通过 WebSocket 广播 → 前端实时展示；且所有已实现功能点均有单元测试覆盖并可一键验证。

**Architecture:** 三层结构：`backend/` 负责 REST + WS Orchestrator + DB；`acp-proxy/` 负责 WS ↔ ACP(JSON-RPC/stdin/stdout) 桥接；`frontend/` 负责 Web UI + WS 实时订阅。数据库使用 PostgreSQL + Prisma ORM（迁移由 `prisma migrate` 生成，不手写 SQL）。

**Tech Stack:** Node.js + TypeScript + Fastify + Prisma + Vitest；Go + gorilla/websocket + go test；React + Vite + Vitest + Testing Library。

---

### Task 1: 校验并对齐文档/脚本（Windows 优先）

**Files:**
- Modify: `docs/02_ENVIRONMENT_SETUP.md`
- Modify: `docs/06_QUICK_START_GUIDE.md`
- Modify: `README.md`

**Step 1: 以实际仓库为准更新差异点**
- DB 迁移：用 `backend/prisma/schema.prisma` + `pnpm -C backend prisma:migrate`，移除手写 `database/migrations/*.sql` 的要求。
- ACP：说明本机 `codex` 若无 `--acp`，使用 `npx --yes @zed-industries/codex-acp`（Proxy 已默认）。
- Windows/pwsh：`curl` 需用 `curl.exe --noproxy 127.0.0.1`（避免系统代理导致 502）。
- 前端端口：Vite 默认 `5173`，文档中 `8080` 改为实际。

**Step 2: 增加“本地快速启动”命令（可复制粘贴）**
- `docker compose up -d`
- `pnpm -C backend prisma:migrate`
- `pnpm -C backend dev`
- `go test ./...` / `go run ./cmd/proxy`（或 `./bin/acp-proxy.exe`）
- `pnpm -C frontend dev`

**Verification:**
- 能按文档从零启动并访问：`GET http://localhost:3000/api/projects` 返回 `success:true`

---

### Task 2: 后端覆盖率门槛全绿（Vitest）

**Files:**
- Modify: `backend/test/**/*.test.ts`

**Step 1: 跑覆盖率并记录缺口**
- Run: `pnpm -C backend test:coverage`
- Expected: coverage thresholds 满足（lines/functions/statements ≥ 95%，branches ≥ 90%）

**Step 2: 按覆盖率报告补齐缺失分支**
- 优先补：错误分支、无项目/无 Agent 分支、WS message 分支（unknown/invalid/close）。

**Verification:**
- Run: `pnpm -C backend test:coverage`
- Expected: exit code 0

---

### Task 3: acp-proxy 单元测试覆盖（Go）

**Files:**
- Create: `acp-proxy/internal/config/config_test.go`
- Create: `acp-proxy/internal/acp/client_test.go`
- Create: `acp-proxy/internal/proxy/proxy_test.go`（必要时）
- Modify: `acp-proxy/internal/proxy/proxy.go`（仅做最小可测试性改造：注入 sender / dialer / acp 工厂）

**Step 1: config.Load（RED→GREEN）**
- 覆盖：必填字段校验、cwd 默认、name 默认、maxConcurrent/heartbeat 默认、agent_command 默认（`npx --yes @zed-industries/codex-acp`）。

**Step 2: acp.Client（RED→GREEN）**
- 覆盖：`bytesTrimSpace`、`idKeyFromRaw`（int/string/raw）、`handleLine` 的 4 类分支（notification/request/unknown request/response）。
- 覆盖：`session/request_permission` 自动选择 `allow_once`；无 option 则 cancelled。

**Step 3: proxy.Proxy（RED→GREEN）**
- 覆盖：`mock_mode` 下收到 `execute_task` 会发送 text update + prompt_result。
- 覆盖：非 mock 下失败路径（Initialize/NewSession/Prompt 任一失败）会发送可读错误文本。
- 覆盖：`session_update` 转发为 `agent_update`（run_id 绑定）。

**Verification:**
- Run: `pushd acp-proxy; go test ./...; popd`
- Expected: exit code 0

---

### Task 4: 前端 MVP + 单元测试覆盖

**Files:**
- Modify: `frontend/package.json`（加入 test scripts + 依赖）
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/components/*`
- Modify: `frontend/src/App.tsx`

**Step 1: API client（RED→GREEN）**
- 用 `fetch`（减少依赖），统一返回 `{ success, data, error }`，并对非 2xx 抛出可读错误。

**Step 2: UI（RED→GREEN）**
- Project：列表 + 创建（最小表单：name/repoUrl）。
- Issue：列表 + 创建（title/description/criteria）。
- Issue 详情：展示最新 Run、事件列表、产物列表（branch）。
- WS：连接 `/ws/client`，收到 `event_added/artifact_added` 时刷新当前详情数据。

**Step 3: 前端测试（Vitest + RTL）**
- 组件渲染（空态/loading/error）。
- 创建 Project/Issue 成功后列表刷新。
- WS 消息触发数据刷新（mock WebSocket）。

**Verification:**
- Run: `pnpm -C frontend test`
- Expected: exit code 0

---

### Task 5: 根脚本与一键验证

**Files:**
- Modify: `package.json`

**Step 1: 增加根脚本**
- `test`: backend + frontend + go
- `test:coverage`: backend/frontend（如设置）+ go

**Verification:**
- Run: `pnpm test`
- Expected: exit code 0

