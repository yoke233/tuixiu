---
title: "ACP 协作台：Run Worktree + GitLab MR 实现计划"
owner: "@tuixiu-maintainers"
status: "archived"
result: "done"
last_reviewed: "2026-01-27"
superseded_by: "docs/00_overview/roadmap.md"
---

# ACP 协作台：Run Worktree + GitLab MR 实现计划（已归档）

> ⚠️ **已归档 / 已过期**：本文件仅用于历史追溯，可能与当前实现不一致，请勿作为开发依据。  
> 当前请以 `README.md`、`docs/00_overview/roadmap.md`、`docs/03_guides/quick-start.md` 为准。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 每个 Run 自动创建独立分支/worktree，Web 端可查看变更并一键创建/合并 GitLab MR，驱动 Issue 状态流转（pending → running → reviewing → done）。

**Architecture:** 后端负责 `git worktree`/`git push`/GitLab API 调用，proxy 负责把 Run 的 `cwd` 绑定到 ACP session 并尽量 `session/load` 复用历史会话；前端在详情页侧栏展示变更与 MR 操作，并显示 Agent/Session 状态。

**Tech Stack:** Fastify + Prisma + WebSocket，React + Vite，ACP TypeScript SDK + ws，GitLab REST API v4。

---

### Task 1: 修复 Windows 下 proxy `spawn npx ENOENT`

**Files:**
- Modify: `acp-proxy/package.json`
- Modify: `acp-proxy/src/acpBridge.ts`

**Step 1: 写最小复现脚本（可选）**
- Run: `node -e "require('node:child_process').spawn('npx',['--version']).on('error',e=>console.error(String(e)))"`
- Expected: `Error: spawn npx ENOENT`

**Step 2: 确保 `start` 会先 build**
- Change: `prestart` → `pnpm build`

**Step 3: 确保 win32 对 `npx/npm/pnpm/yarn` 走 `cmd.exe /c`**
- Verify: `acp-proxy/src/acpBridge.ts` 使用 `process.env.ComSpec ?? 'cmd.exe'`

**Step 4: 验证**
- Run: `cd acp-proxy && pnpm start`
- Expected: `spawn acp agent` 日志里 `cmd.exe` + `npx ...`

---

### Task 2: Run 工作区：后端自动创建 `branch + worktree`

**Files:**
- Modify: `backend/src/routes/issues.ts`
- Modify: `backend/src/routes/runs.ts`
- Create: `backend/src/utils/gitWorkspace.ts`
- Modify: `.gitignore`

**Step 1: 为每个 Run 分配 `branchName/workspacePath`**
- 规则：`branchName = run/<worktreeName>`；`workspacePath = <repo>/.worktrees/run-<worktreeName>`
- 使用：`git worktree add -b <branch> <path> <baseBranch>`

**Step 2: 写入数据库**
- `Run.workspaceType = 'worktree'`
- `Run.workspacePath = <absolutePath>`
- `Run.branchName = <branchName>`
- 同时创建 `Artifact(type=branch)` 便于前端显示

**Step 3: 启动 Run 时把 `cwd` 发给 proxy**
- `execute_task` payload 增加 `cwd`

**Step 4: 对话时把 `cwd` 带上（用于 load/new session）**
- `prompt_run` payload 增加 `cwd`

**Step 5: 验证**
- Run: `pnpm -r test`
- 手动：创建 Issue → 启动 Run → 本地出现 `.worktrees/run-...`

---

### Task 3: proxy 绑定 Run→cwd + 尽量 `session/load` 复用历史 session

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `acp-proxy/src/index.ts`
- Modify: `acp-proxy/src/acpBridge.ts`
- Test: `acp-proxy/src/*.test.ts`

**Step 1: message schema 增加 `cwd?: string`**

**Step 2: 新建/重建 session 时使用 Run 的 cwd**
- `newSession(cwd)`

**Step 3: loadSession 使用 Run 的 cwd**
- `loadSession(sessionId, cwd)`

**Step 4: 验证**
- Run: `cd acp-proxy && pnpm test`

---

### Task 4: GitLab MR：创建/合并/刷新（后端 API）

**Files:**
- Create: `backend/src/integrations/gitlab.ts`
- Modify: `backend/src/routes/runs.ts`
- Test: `backend/test/routes/runs.test.ts`

**Step 1: 根据 `Project.repoUrl` 推导 GitLab baseUrl（含 git@host:path）**

**Step 2: `POST /api/runs/:id/create-pr`**
- 先 `git push -u origin <branch>`
- 再调用 `POST /projects/:id/merge_requests`
- 创建 `Artifact(type=pr)`，必要时把 `Run.status` 置为 `waiting_ci`

**Step 3: `POST /api/runs/:id/merge-pr`（可选）**
- 调用 `PUT /projects/:id/merge_requests/:iid/merge`
- merged 后把 `Issue.status=done`

**Step 4: 验证**
- Run: `pnpm -r test`

---

### Task 5: 前端：详情页侧栏显示变更 + MR 操作 + 状态提示

**Files:**
- Modify: `frontend/src/components/RunChangesPanel.tsx`
- Modify: `frontend/src/pages/IssueDetailPage.tsx`
- Modify: `frontend/src/api/runs.ts`
- Test: `frontend/src/pages/IssueDetailPage.test.tsx`

**Step 1: RunChangesPanel 增加 “创建 PR / 打开 PR / 合并 PR / 刷新状态”**

**Step 2: 会话提示文案调整**
- 优先提示：若已有 `sessionId` 会尝试 `session/load`；只有在无法恢复时才降级为“注入上下文新建”

**Step 3: 验证**
- Run: `pnpm -r test`
