---
title: "GitHub SCM 最小状态（无 Artifact）实施计划"
owner: "@yoke233"
status: "archived"
last_reviewed: "2026-01-28"
---

# GitHub SCM 最小状态（无 Artifact）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 backend 在不保存 diff/patch/report 等 Artifact 的前提下，仍能基于 GitHub 的 PR/CI 状态自动推进流程（创建 PR、等待 CI、自动合并/请求审批），并把最小状态落到 `Run` 上。

**Architecture:** 以 `Run` 为唯一事实来源（SSOT）：仅保存 `prUrl/prNumber/state/headSha/ciStatus` 等最小 SCM 状态。GitHub Webhook 负责“推”状态更新，后台低频轮询只做兜底 reconcile。所有原先写入 `Artifact(type=pr/ci_result/report)` 的逻辑改为更新 `Run` 字段。

**Tech Stack:** Fastify + WebSocket gateway，Prisma(PostgreSQL)，Zod，Vitest，GitHub Webhooks + GitHub REST API。

---

## 范围与非目标

**本期范围（GitHub 优先）：**

- `Run` 新增 SCM 最小状态字段（PR/CI）并提供统一写入函数
- GitHub webhook：`pull_request` + `check_suite/check_run/workflow_run` 更新 `Run` SCM 状态（不再写 Artifact）
- 运行流程：push 后自动创建 PR（由现有 create PR 逻辑/或后续执行面上报触发），CI 通过后按项目配置自动合并或自动创建 merge 审批
- Project 配置增加 `autoMerge/mergeMethod/ciGate`（放在现有 pmPolicy/branchProtection 里，或新 schema 版本）

**非目标（后续里程碑）：**

- 删除本地 worktree/clone/git push（需要执行面上报 `scm_pushed` 并接管 workspace）
- 删除 GitLab 相关的旧字段/逻辑（会做，但不是 GitHub MVP 的阻塞项）
- 删除 Artifact 表（先停止写入 pr/ci_result/report，确认无读路径后再 drop）

## 设计约束（必须满足）

- backend 不提供 diff/changes API；UI/人工去 GitHub 看 diff。
- backend 不再创建 `Artifact(type=pr/ci_result/report)`；相关信息只落在 `Run`（或 `Run.metadata.scm`，但优先 Run 字段）。
- webhook 必须可幂等：重复事件不会写出错误状态、不会触发重复合并。

---

### Task 1: 创建功能分支（从 main）

**Files:** 无

**Step 1: 创建分支**

Run:

```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git fetch
git checkout -b feat/backend/github-scm-minimal-state origin/main
```

Expected: 切换到新分支且工作区干净。

---

### Task 2: Prisma - Run 增加 SCM 最小状态字段

**Files:**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/YYYYMMDDHHMMSS_add_run_scm_state/migration.sql`

**Step 1: 写一个失败用例（路由层）**

- 在 `backend/test/routes/githubWebhooks.test.ts`（若存在）新增测试：CI webhook 到来时应更新 `Run.scmCiStatus` 而不是创建 `Artifact(ci_result)`。
- 先只断言 “artifact.create 未被调用 + run.update 被调用包含 scmCiStatus”。

**Step 2: 跑测试确认失败**

Run:

```powershell
pnpm -C backend test -- -t "ci webhook updates run scm"
```

Expected: FAIL（现实现仍在写 Artifact）。

**Step 3: 修改 schema + 写 migration**

- 在 `Run` 增加字段：
  - `scmProvider String? @db.VarChar(20)`（先写 "github"）
  - `scmHeadSha String? @db.VarChar(64)`
  - `scmPrNumber Int?`
  - `scmPrUrl String? @db.VarChar(500)`
  - `scmPrState String? @db.VarChar(20)`
  - `scmCiStatus String? @db.VarChar(20)`（或 enum：pending/passed/failed）
  - `scmUpdatedAt DateTime?`
- 创建 migration.sql 添加列与索引（建议索引：`(scmPrNumber)`, `(issueId, branchName)`）。

**Step 4: prisma generate**

Run:

```powershell
pnpm -C backend prisma:generate
```

Expected: Prisma Client 生成成功。

**Step 5: Commit**

Run:

```powershell
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(backend): add run scm state fields"
```

---

### Task 3: 新增统一写入函数 updateRunScmState（服务层）

**Files:**

- Create: `backend/src/services/scmState.ts`
- Test: `backend/test/services/scmState.test.ts`

**Step 1: 写失败测试**

```ts
// 断言：updateRunScmState 会把 prUrl/prNumber/state/headSha/ciStatus 归一写入 Run
```

**Step 2: 跑测试确认失败**
Run: `pnpm -C backend test -- -t "updateRunScmState"`
Expected: FAIL（函数不存在）。

**Step 3: 最小实现**

- 输入支持 partial patch（只更新传入字段）
- 幂等：重复写同样状态不应触发额外副作用
- 统一 normalize：ciStatus -> pending/passed/failed；prState -> open/closed/merged（先做最小映射）

**Step 4: 跑测试确认通过**
Run: `pnpm -C backend test -- -t "updateRunScmState"`
Expected: PASS

**Step 5: Commit**

```powershell
git add backend/src/services/scmState.ts backend/test/services/scmState.test.ts
git commit -m "feat(backend): add scm state updater"
```

---

### Task 4: GitHub webhook - PR 事件更新 Run（不写 Artifact）

**Files:**

- Modify: `backend/src/routes/githubWebhooks.ts`
- Test: `backend/test/routes/githubWebhooks.test.ts`（新增或修改）

**Step 1: 写失败测试**

- `pull_request` opened/synchronize/closed(merged) 应更新 `Run.scmPrUrl/scmPrNumber/scmPrState/scmHeadSha`。
- 断言：`prisma.artifact.create` 不被调用（或仅允许旧的非 pr/ci/report 类型）。

**Step 2: 跑测试确认失败**
Run: `pnpm -C backend test -- -t "pull_request updates run scm"`
Expected: FAIL

**Step 3: 最小实现**

- 以 `projectId + branchName(head.ref)` 找 `Run`（最近 startedAt，且 status in running/waiting_ci/…）
- 写入 `scmProvider="github"`、`scmPr*`、`scmHeadSha`
- `merged=true` 时将 `scmPrState="merged"`；否则 `open/closed`
- 仅更新 SCM 字段，不再创建 `Artifact(type=pr)`

**Step 4: 跑测试**
Run: `pnpm -C backend test -- -t "pull_request updates run scm"`
Expected: PASS

**Step 5: Commit**

```powershell
git add backend/src/routes/githubWebhooks.ts backend/test/routes/githubWebhooks.test.ts
git commit -m "feat(backend): update run scm state from github pr webhooks"
```

---

### Task 5: GitHub webhook - CI 事件更新 Run.ciStatus（不写 Artifact）

**Files:**

- Modify: `backend/src/routes/githubWebhooks.ts`
- Test: `backend/test/routes/githubWebhooks.test.ts`

**Step 1: 写失败测试**

- `check_suite/check_run/workflow_run` completed 时：
  - success -> `scmCiStatus=passed`
  - failure/cancelled -> `scmCiStatus=failed`
  - 同时写 `scmHeadSha`（若有）
- 断言不再 `artifact.create(ci_result)`。

**Step 2: 跑测试确认失败**
Run: `pnpm -C backend test -- -t "ci webhooks update run scm"`
Expected: FAIL

**Step 3: 最小实现**

- 优先用 `branch(head_branch)` 找 `Run`（status=waiting_ci 优先）
- 找不到时用 `scmPrNumber in prNumbers` 或 `scmHeadSha=headSha` 兜底
- 更新 `scmCiStatus` + `scmUpdatedAt`

**Step 4: 跑测试**
Run: `pnpm -C backend test -- -t "ci webhooks update run scm"`
Expected: PASS

**Step 5: Commit**

```powershell
git add backend/src/routes/githubWebhooks.ts backend/test/routes/githubWebhooks.test.ts
git commit -m "feat(backend): update run ci status from github ci webhooks"
```

---

### Task 6: PM/审批/自动化逻辑改读 Run SCM 状态（不再读 Artifact）

**Files:**

- Modify: `backend/src/services/pm/pmAutoReviewRun.ts`
- Modify: `backend/src/services/pm/pmAutoAdvance.ts`
- Modify: `backend/src/services/taskProgress.ts`
- Test: 对应的 `backend/test/services/*`（按失败用例补）

**Step 1: 写失败测试**

- 断言：自动推进判断 PR/CI 时不再查询 `artifact(type=pr/ci_result/report)`，而是读 `Run.scm*`。

**Step 2: 跑测试确认失败**
Run: `pnpm -C backend test -- -t "pm auto advance uses run scm"`
Expected: FAIL

**Step 3: 最小实现**

- 把 “最新 ci_result artifact” 替换为 `Run.scmCiStatus`
- 把 “最新 pr artifact” 替换为 `Run.scmPrUrl/scmPrState`
- `taskProgress.ensureArtifactOnce` 对 report/ci_result 逐步废弃（先不删接口，先不再被调用）

**Step 4: 跑全量测试**
Run: `pnpm -C backend test`
Expected: PASS

**Step 5: Commit**

```powershell
git add backend/src/services backend/test/services
git commit -m "refactor(backend): switch automation to run scm state"
```

---

### Task 7: 项目配置 - 增加 autoMerge 策略（GitHub 优先）

**Files:**

- Modify: `backend/src/services/pm/pmPolicy.ts`
- Modify: `backend/src/services/pm/pmAutoAdvance.ts`（合并策略读取）
- Test: `backend/test/services/pmAutoAdvance.test.ts` 或新增

**Step 1: 写失败测试**

- 当 `policy.automation.autoMerge=true` 且 `Run.scmCiStatus=passed` 时，触发合并；否则不合并。

**Step 2: 跑测试确认失败**
Run: `pnpm -C backend test -- -t "auto merge"`
Expected: FAIL

**Step 3: 实现**

- pmPolicy 增加：
  - `automation.autoMerge: boolean (default false)`
  - `automation.mergeMethod: "merge"|"squash"|"rebase" (default "squash")`
  - `automation.ciGate: boolean (default true)`
- 在 pmAutoAdvance 的 `ci_completed` 分支里执行：
  - autoMerge=true 且 ciGate 满足 -> 调用 GitHub merge API（复用现有 github integration 或新增 service）
  - autoMerge=false -> 走 `autoRequestMergeApproval`（现有逻辑）
- **autoMerge 失败时（必须可审计、可“打回”）：**
  - 写入 Event：`pm.pr.auto_merge.failed`（含 prUrl/prNumber/headSha/ciStatus/error）
  - 将对应 Task 回滚到 `dev.implement`（或模板第一步）并触发自动继续，让 agent 进入修复流程
  - 额外给 agent 一条“失败原因 + 下一步”消息（通过 ACP prompt 注入到新的 run，会形成事件审计）

**Step 4: 跑测试**
Run: `pnpm -C backend test -- -t "auto merge"`
Expected: PASS

**Step 5: Commit**

```powershell
git add backend/src/services/pm/pmPolicy.ts backend/src/services/pm/pmAutoAdvance.ts backend/test/services
git commit -m "feat(backend): add project auto-merge policy"
```

---

### Task 8: 删除 diff/changes API（按决策）

**Files:**

- Modify: `backend/src/routes/runs.ts`
- Delete: `backend/src/services/runGitChanges.ts`
- Test: 更新 `backend/test/routes/runs.test.ts`

**Step 1: 写失败测试**

- 访问 `/api/runs/:id/changes` 与 `/api/runs/:id/diff` 应返回 404 或明确错误码 `DEPRECATED`。

**Step 2: 实现删除**

- 路由移除
- `runGitChanges` 删除并清理所有 import

**Step 3: 跑全量测试**
Run: `pnpm -C backend test`

**Step 4: Commit**

```powershell
git add backend/src/routes/runs.ts backend/test/routes/runs.test.ts
git rm backend/src/services/runGitChanges.ts
git commit -m "refactor(backend): remove runs diff/changes endpoints"
```

---

### Task 9: 停止写 Artifact(pr/ci_result/report)，保留表结构（清理引用点）

**Files:**

- Modify: `backend/src/services/runReviewRequest.ts`
- Modify: `backend/src/services/githubPolling.ts`
- Modify: `backend/src/services/githubPrAutoReview.ts`（不再创建 report artifact；改写 event）
- Modify: `backend/src/services/approvalRequests.ts` / `backend/src/routes/approvals.ts`（去掉 report artifact 依赖）
- Tests: 覆盖相关用例

**Step 1: 逐点删除写入**

- create PR：只更新 `Run.scmPr*`
- CI 结果：只更新 `Run.scmCiStatus`
- report：只写 `Event(type=...)`，不落 Artifact

**Step 2: 跑全量测试**
Run: `pnpm -C backend test`

**Step 3: Commit**

```powershell
git add backend/src backend/test
git commit -m "refactor(backend): stop persisting pr/ci/report artifacts"
```

---

### Task 10: 文档与发布

**Files:**

- Modify: `docs/README.md`（或新增模块文档）

**Step 1: 写迁移说明**

- 如何配置 GitHub webhook events
- 如何开启项目 autoMerge
- 变更点：Run 增加 scm 字段；diff API 删除；Artifact 不再写入 pr/ci/report

**Step 2: Commit**

```powershell
git add docs
git commit -m "docs: describe github scm minimal state flow"
```

---

### Task 11: Prompt 模板配置（平台默认 + 项目覆盖）

**动机：** 目前与 agent 交互的很多提示词写死在代码中（如 `acpAgentExecutor.ts` 的步骤指令、PM 自动评审、PR 自动评审、worktree/branch 命名等）。希望把提示词集中为“可配置模板”，平台可统一管理，项目可覆盖，且每次使用可审计追溯。

**设计：**

- 定义 `PromptKey`（示例）：`step.prd.generate`、`step.dev.implement`、`step.code.review`、`pm.auto_review.system`、`github.pr.auto_review.system`、`utils.git.branch_name.system`、`automation.auto_merge.fix_instruction` 等。
- 提示词解析优先级（从高到低）：
  1. Project 覆盖（例如 `Project.branchProtection.prompts[key]`）
  2. 平台默认（例如从环境变量指向的 JSON/YAML 文件加载，或新增 DB 表持久化；二选一）
  3. 代码内置默认（兜底，确保系统可跑）
- 模板变量：复用现有 `renderTemplate` 语法（`{{issue.title}}`/`{{run.id}}`/`{{pr.url}}` 等），并提供一份“可用变量清单”文档。
- 审计：每次向 agent 发送 prompt 时，写入 `Event(type="prompt.used")`，记录 `key/version/hash/runId/projectId`，保证可追溯“当时用了哪个提示词”。

**Files（建议）：**

- Create: `backend/src/services/prompts/promptCatalog.ts`（PromptKey 常量与默认值）
- Create: `backend/src/services/prompts/promptResolver.ts`（按优先级解析 + render）
- Modify: `backend/src/executors/acpAgentExecutor.ts`（`buildStepInstruction` 改为从 resolver 取模板）
- Modify: `backend/src/services/startIssueRun.ts`（首条 prompt 改为从 resolver 取模板）
- Modify: `backend/src/utils/gitWorkspace.ts`（branch/worktree 命名 prompt 改为从 resolver 取模板）
- Modify: `backend/src/services/githubPrAutoReview.ts` / `backend/src/services/pm/pmAnalyzeIssue.ts`（系统提示词改为从 resolver 取模板）
- （可选）新增 admin 接口：`GET/PUT /api/admin/projects/:id/prompts` / `GET/PUT /api/admin/prompts`（平台级）

**Step 1: 写一个解析优先级测试**

- Project 覆盖存在时优先使用覆盖；否则使用平台默认；都没有则回退内置默认。

**Step 2: 逐个替换硬编码提示词**

- 先替换 `step.*`（最大收益），再替换其它工具/自动化 prompt。

**Step 3: 跑全量测试**
Run: `pnpm -C backend test`

**Step 4: Commit**

```powershell
git add backend/src backend/test
git commit -m "refactor(backend): make agent prompts configurable"
```

---

## 执行备注（实现时的“坑位清单”）

- `backend/src/routes/githubWebhooks.ts` 目前会用 `Artifact(type=pr)` 反查 run，需要先让 Run 存 `scmPrNumber/scmHeadSha` 才能替换掉。
- GitHub CI 事件很多：必须做“rollup”策略（至少不要因单个 check success 就把整次 CI 判为 passed）。
- 自动合并必须幂等：重复 webhook 不应重复 merge；需要在合并前再查询 PR 状态。
- 迁移期间允许 Artifact 表保留，但要确保新逻辑不再写入 pr/ci/report。
- autoMerge 失败要能把任务“打回”并记录审计：失败原因、回滚目标 step、触发的新 runId、以及发给 agent 的指令内容（key/hash）。
