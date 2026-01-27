# 多执行器任务系统（Task/Step/Execution）+ 回滚重跑（4A 内置模板）实现计划

> 对应 PRD：`docs/plans/2026-01-27-executor-task-prd.md`  
> 范围：MVP 先落地 **内置模板（4A）**，不做工作流编辑器；但在数据模型与服务层预留未来可配置 DAG 的扩展位。

**Goal:** 把现有 “Issue → Run(ACP)” 升级为 “Issue → Task(工作流实例) → Steps(步骤) → Executions(尝试)”：同一 Issue 下可运行 PRD/实现/测试/评审/CI/人工审批等步骤；支持 **打回 → 回滚到任意 Step → 重跑（保留历史尝试）**；测试支持双模（workspace 快速反馈 + CI 权威门禁，CI 不可用自动降级）。

**Architecture:** 仍保持三层：`frontend/`（UI）↔ `backend/`（REST + WS + DB + Git workspace）↔ `acp-proxy/`（WS ↔ ACP）。新增的 “执行器” 主要在 `backend/`：`AcpAgentExecutor` 复用现有 `execute_task/prompt_run`，`CiExecutor` 由 webhook 驱动，`HumanExecutor` 通过 UI 表单提交。

**Tech Stack:** Fastify + Prisma + Zod + Vitest；React + Vite + Vitest/RTL；（Auth）`@fastify/jwt` + `bcrypt`（或等价方案）。

---

## Task 1: 数据模型与迁移（User + Task + Step + Run 扩展）

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/*_add_tasks_steps_users/*`
- Modify: `backend/src/deps.ts`
- (Optional) Modify: `backend/src/utils/publicProject.ts`（脱敏字段范围若新增）

**Steps:**
1. 新增枚举（建议）：
   - `UserRole`: `admin|pm|reviewer|dev`
   - `ExecutorType`: `agent|ci|human|system`
   - `TaskStatus`: `pending|running|blocked|completed|failed|cancelled`
   - `StepStatus`: `pending|ready|running|waiting_ci|waiting_human|blocked|completed|failed|cancelled`
2. 新增 `User`：
   - `username` 唯一；`passwordHash`；`role`；`createdAt/updatedAt`。
3. 新增 `Task`（隶属 `Issue`）：
   - `templateKey`、`status`、`currentStepId`（指向 Step，可空）
   - 共享 workspace 快照：`workspaceType/workspacePath/branchName/baseBranch`（用于“同一分支贯穿步骤”）
   - `createdByUserId`（可空，便于渐进接入 Auth）
4. 新增 `Step`（隶属 `Task`）：
   - `key`（稳定标识，如 `dev.implement`）、`kind`（如 `test.run`）、`order`、`status`
   - `executorType`（默认执行器）、`roleKey`（agent 角色）、`params`（JSON）
   - `dependsOn`（JSON，占位：未来 DAG 用；MVP 先不用）
   - 约束：`@@unique([taskId, key])`、索引 `(taskId, order)`。
5. 扩展 `Run` 作为 Execution（建议演进路径：Run=Execution attempt）：
   - `agentId` 改为可空（支持 CI/Human/System）
   - 新增：`executorType`、`taskId`、`stepId`、`attempt`（int）
   - 索引：`(taskId, startedAt)`、`(stepId, startedAt)`。
6. 更新 `PrismaDeps`：加入 `user/task/step`（以及后续需要的表）。
7. Run:
   - `pnpm -C backend prisma generate`
   - `pnpm -C backend prisma migrate dev --name add_tasks_steps_users`（或 `--create-only`）

**Verification:**
- Run: `pnpm -C backend test`
- Expected: exit code 0（如有失败先最小修复类型/关系断言）

---

## Task 2: 后端“任务引擎”与内置模板（4A）

**Files:**
- Create: `backend/src/services/taskTemplates.ts`
- Create: `backend/src/services/taskEngine.ts`
- Create: `backend/src/routes/tasks.ts`
- Create: `backend/src/routes/steps.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/test/routes/tasks.test.ts`
- Create: `backend/test/routes/steps.test.ts`

**Steps:**
1. 内置模板常量（4A）：
   - `template.dev.full`（实现→测试→AI review→人 review→创建 PR→CI gate→merge）
   - `template.prd.only`（PRD 生成→PRD review→（可选）发布）
   - `template.test.only`（测试→（可选）发布）
2. `taskEngine.createTaskFromTemplate(issueId, templateKey, overrides?)`：
   - 原子创建 `Task + Steps`；把第一个 Step 置为 `ready`，其余 `pending`。
3. `taskEngine.startStep(stepId, overrides?)`：
   - 计算 `attempt`（同 step 下 `Run` 数量 + 1）
   - 创建 `Run`（Execution）并写 `Run.taskId/stepId/executorType/attempt`
   - 把 Step 置为 `running|waiting_*`，Task 置为 `running`，并广播事件（见 Task 4）。
4. `taskEngine.rollback(taskId, targetStepId)`：
   - 将 `targetStep` 之后的 Step 状态重置为 `pending`（保留历史 Run/Artifact/Event）
   - 目标 Step 置为 `ready`，Task.currentStepId 指向目标 Step，Task.status 置为 `running`
5. API（建议最小集合）：
   - `POST /api/issues/:id/tasks`：创建 Task（body: `templateKey`）
   - `GET /api/issues/:id/tasks`：列出 Task
   - `GET /api/tasks/:id`：Task 详情（含 Steps + 最近一次 Run/Artifacts 概要）
   - `POST /api/steps/:id/start`：启动 Step（body: overrides）
   - `POST /api/tasks/:id/rollback`：回滚到 Step（body: `stepId`）

**Verification:**
- Run: `pnpm -C backend test -- -t \"tasks\"`
- Expected: 创建/启动/回滚 的状态机断言通过

---

## Task 3: Executor 抽象（Agent/CI/Human）与 Step Prompt 规范

**Files:**
- Create: `backend/src/executors/types.ts`
- Create: `backend/src/executors/acpAgentExecutor.ts`
- Create: `backend/src/executors/humanExecutor.ts`
- Create: `backend/src/executors/ciExecutor.ts`
- Modify: `backend/src/routes/issues.ts`（复用选 agent + workspace 逻辑，或抽到共享 service）
- Modify: `backend/src/websocket/gateway.ts`（Run 完成 → 推进 Step/Task）
- Modify: `backend/src/routes/runs.ts`（Run.agentId 可空后的兼容）
- Modify: `backend/src/services/runContext.ts`（必要时：Step/Task 上下文拼装）
- Create: `backend/test/executors/*.test.ts`

**Steps:**
1. 定义 `Executor` 接口（最小）：
   - `start({ task, step, run })`
   - `cancel({ run })`（可选）
2. `AcpAgentExecutor`：
   - 复用现有 agent 选择策略（在线且未满载）
   - Workspace 策略：若 `Task.workspacePath` 为空，则创建一次（用 `taskId` 作为 workspace id；worktree 模式下用模板生成的 runKey），并写入 Task 与 Run；后续 Step 复用同一 `cwd/branchName`
   - Prompt 规范（强约束输出，便于结构化沉淀）：
     - PRD：最终输出必须包含一个 `REPORT_JSON` 代码块（JSON，含 `kind="prd"`、`title`、`sections`、`acceptanceCriteria`）
     - Review：必须包含 `REPORT_JSON`（含 `kind="review"`、`verdict`、`findings[]`）
     - Test：必须包含 `CI_RESULT_JSON`（含 `passed`、`failedCount?`、`durationMs?`、`logExcerpt`）
   - Backend 在 Run 完成时从事件流中提取最后一个 JSON 块；解析失败则降级为 `report`（原文）/`ci_result`（只含 passed=exitCode 推断）。
3. `HumanExecutor`：
   - `start`：将 Step 置为 `waiting_human`，创建 `Run(executorType=human)` + `Event(type=human.action_required)`
   - 新增提交端点：`POST /api/runs/:id/submit` 或 `POST /api/steps/:id/submit`
     - body: `verdict` + `comment`；落 `Artifact(type=report, kind=review/prd)` 并推进 Step
     - 若 verdict=`changes_requested`：Task.status=`blocked`，并提示可回滚（UI 侧引导触发 rollback）
4. `CiExecutor`：
   - `start`：将 Step 置为 `waiting_ci`，记录关联信息（PR number / head sha / branch）到 `Run.metadata`（或 `Artifact(pr)`）
   - Webhook 到达后：写 `Artifact(type=ci_result)` 并推进 Step/Task

**Verification:**
- Run: `pnpm -C backend test -- -t \"executor\"`
- Expected: 三类 executor 的状态推进与降级策略均可被单测覆盖

---

## Task 4: WebSocket 广播与前端实时刷新（Task/Step 级别）

**Files:**
- Modify: `backend/src/websocket/gateway.ts`
- (Optional) Create: `backend/src/websocket/events.ts`（统一事件类型）
- Modify: `frontend/src/api/ws.ts`（或现有 WS client 文件）
- Modify: `frontend/src/pages/IssueDetailPage.tsx`
- Modify/Create: `frontend/src/pages/IssueDetailPage.test.tsx`

**Steps:**
1. 后端新增广播事件（建议）：
   - `task_added`、`task_updated`
   - `step_updated`
   - 复用现有 `event_added/artifact_added`（仍以 run_id 为粒度）
2. Run 完成/失败时（来自 ACP gateway 或 human/ci 回调）：
   - `taskEngine.onRunTerminal(runId)`：推进 Step/Task，必要时自动把下一个 Step 置为 `ready`
3. 前端：
   - Issue 详情页新增 “Tasks” 区块：显示 Task 列表 + 当前 Task 的 Step 时间线
   - WS 收到 `task_* / step_updated` 后只刷新当前 Issue 的任务数据（避免全量刷新）

**Verification:**
- Run: `pnpm -C frontend test -- -t \"Tasks\"`
- Expected: mock WS 推送后 UI 状态更新

---

## Task 5: 交付物落盘与脱敏（Publish）

**Files:**
- Create: `backend/src/services/redaction.ts`
- Create: `backend/src/services/artifactPublish.ts`
- Modify: `backend/src/routes/runs.ts` 或 Create: `backend/src/routes/artifacts.ts`
- Modify: `frontend/src/pages/IssueDetailPage.tsx`（发布按钮）
- Create/Modify: `backend/test/routes/artifacts.test.ts`

**Steps:**
1. 规范 report content：
   - `Artifact(type=report)` 的 `content` 统一含：`kind`、`title`、`markdown`、`json?`、`verdict?`
2. 脱敏策略（最小可用）：
   - 落库前：对 Event/Artifact 文本字段执行敏感信息替换（`GH_TOKEN/GITHUB_TOKEN/OPENAI_API_KEY/*ACCESS_TOKEN*` 等）
   - 发布前：扫描命中高危模式直接阻断（返回明确 error code）
3. Publish API：
   - `POST /api/artifacts/:id/publish`（body: `path?`）
   - 后端在 Task.workspacePath 下写入文件 → `git add` → `git commit -m`（commit message 可包含 issue/task/step）
   - 成功后写入 `Artifact(type=patch or report)` 附加 `{ commitSha, path }`（或写 Event）

**Verification:**
- Run: `pnpm -C backend test -- -t \"publish\"`
- Expected: 写入/commit 被 mock，且脱敏命中时阻断

---

## Task 6: CI/Webhook 闭环（GitHub/GitLab）

**Files:**
- Modify: `backend/src/routes/githubWebhooks.ts`（支持 CI 相关事件）
- Create: `backend/src/routes/gitlabWebhooks.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/test/routes/githubWebhooksCi.test.ts`
- Create: `backend/test/routes/gitlabWebhooksCi.test.ts`

**Steps:**
1. GitHub：
   - 扩展支持 `check_suite` / `check_run` / `workflow_run`（择一实现，按你的 CI 类型确定）
   - 通过 `PR number + repo` 或 `head_branch/head_sha` 定位 `ci.gate` 的 Run/Step
   - 写入 `ci_result` 并推进 Step/Task（成功则 `completed`，失败则 `failed`）
2. GitLab：
   - 新增 webhook 路由 + secret 校验（可复用 Project.gitlabWebhookSecret 或 env）
   - 支持 pipeline 状态事件，按 `source_branch`/MR iid 匹配
3. 超时/丢失兜底（v1.1 可做）：提供 `POST /api/steps/:id/sync-ci` 主动查询 provider 状态并修复。

**Verification:**
- Run: `pnpm -C backend test -- -t \"webhook\"`
- Expected: webhook payload 模拟可驱动 Step 状态变化

---

## Task 7: 轻量登录与权限（6B）

**Files:**
- Create: `backend/src/routes/auth.ts`
- Create: `backend/src/plugins/auth.ts`
- Modify: `backend/src/index.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/pages/LoginPage.tsx`
- Modify: `frontend/src/App.tsx`
- Create/Modify: `backend/test/routes/auth.test.ts`

**Steps:**
1. 后端：
   - `POST /api/auth/login`：签发 JWT（含 `userId/role`）
   - `auth` 插件：对写操作路由加 `preHandler`（Task 创建/启动/回滚/提交评审/merge/publish）
   - 首次启动无用户时：提供 `BOOTSTRAP_ADMIN_*` 环境变量创建初始 admin（或 CLI 脚本）
2. 前端：
   - 登录页获取 token，存储并为后续请求附加 `Authorization: Bearer ...`
   - UI 按 role 隐藏/禁用按钮（例如 merge/approve 仅 reviewer/admin）

**Verification:**
- Run: `pnpm -C backend test`
- Run: `pnpm -C frontend test`
- Expected: 未登录/越权返回 401/403；登录后可正常操作

---

## Task 8: 兼容与收口（不破坏现有 MVP 流程）

**Files:**
- Modify: `frontend/src/pages/IssueDetailPage.tsx`
- Modify: `backend/src/routes/issues.ts`
- Modify: `backend/src/routes/runs.ts`
- Modify: `backend/test/routes/issues.test.ts`

**Steps:**
1. 保持旧入口可用：
   - `POST /api/issues/:id/start` 继续可用；实现上可选择：
     - A) 直接走旧 Run 流程（兼容模式）
     - B) 内部创建一个 `Task(template.dev.full)` 并启动 `dev.implement` Step（推荐，减少双逻辑）
2. UI 渐进迁移：
   - Issue 详情优先展示 Tasks；旧 Runs 区块保留但标记为 “Legacy”
3. 文档补充：
   - 更新 `docs/ROADMAP.md` 与 `README.md`（新增 Task/Step/Executor 的概念与端点摘要）

**Verification:**
- Run: `pnpm test`
- Expected: 旧用例不回归；新增用例通过

