---
title: "项目上下文（Context Pack）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# 项目上下文（Context Pack）

> 目的：把“仓库硬约束/默认约定”集中成一份短文档，供人类与 Agent 在执行任何 Step 前统一对齐，减少误改与返工。

## 1. 仓库结构（pnpm workspace）

- `backend/`：Fastify 编排层（REST API + WebSocket gateway），Prisma schema/migrations 在 `backend/prisma/`，单测在 `backend/test/`
- `acp-proxy/`：WebSocket ↔ ACP bridge 与 agent launcher；运行时配置 `acp-proxy/config.json`（从 `config.json.example` 拷贝）
- `frontend/`：Vite + React UI；页面在 `frontend/src/pages/`，组件在 `frontend/src/components/`
- `docs/`：架构、PRD、实现说明与执行计划
- `.worktrees/`：运行时生成的 git worktrees（不要手动编辑、不要提交）

## 2. 环境与常用命令（Windows / PowerShell）

> 推荐 Node.js 20+；命令默认从仓库根目录执行。

```powershell
pnpm install
docker compose up -d
pnpm dev
```

- DB 迁移：`pnpm -C backend prisma:migrate`
- 全仓检查：`pnpm lint`、`pnpm typecheck`
- 测试：`pnpm test`（或按包：`pnpm -C backend test` / `pnpm -C frontend test`）

## 3. Git 工作区与分支约定

- Run/Task 默认使用 git worktree 隔离工作区：
  - worktree：`<repoRoot>/.worktrees/run-<worktreeName>`
  - branch：`run/<worktreeName>`
- 在工作区内修改代码后，必须 `git commit` 到该分支（由系统后续创建 PR/合并）。

## 4. 代码风格与工程约定

- TypeScript + ESM（`"type": "module"`），2 空格缩进优先
- 尽量保持 diff 最小：不要做无关格式化/大规模重排
- 遵循各包的本地 ESLint/格式化约定（见各包 `eslint.config.js`）
- 命名约定：
  - 后端模块：`camelCase.ts`（例：`backend/src/routes/githubIssues.ts`）
  - React 组件：`PascalCase.tsx`（例：`frontend/src/components/RunConsole.tsx`）
  - 测试：`*.test.ts` / `*.test.tsx`

## 5. 自动化与门禁（重要）

- 默认目标：把 “Issue → Run → PR → Merge → Done” 尽量全自动闭环
- 原则：**只有高危动作需要审批**；其余尽量自动推进；同一 Issue 串行（不并行）
- 当前已具备的门禁：
  - `merge_pr`：默认需要审批
  - `create_pr` / `publish_artifact`：可按 Project policy 以及 `sensitivePaths` 命中升级进入审批

## 6. 安全与配置

- 机密信息（PAT/API key/Token）禁止写入代码、日志与文档；不要提交到 git
- 配置文件参考：
  - `backend/.env.example` → `backend/.env`
  - `acp-proxy/config.json.example` → `acp-proxy/config.json`

## 7. 参考

- 工作流路线图：`docs/05_process/workflow-optimization-bmad-lite.md`
- 执行计划：`docs/00_overview/plans/2026-01-27-pm-agent-execution-plan.md`
- 快速开始：`docs/03_guides/quick-start.md`
- 环境搭建：`docs/03_guides/environment-setup.md`
- 测试计划：`docs/05_process/testing.md`
