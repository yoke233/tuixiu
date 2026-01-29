---
title: "backend/src/services 模块化拆分与渐进迁移计划"
owner: "@tbd"
status: "draft"
last_reviewed: "2026-01-29"
superseded_by: ""
related_issues: []
---

# backend/src/services 模块化拆分 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 backend 的 `src/services` 从“杂项集合”演进为按域模块化的结构，降低耦合、提升可测试性与可扩展性，并支持后续把策略/模板更多下放到运行时配置。

**Architecture:** 引入 `backend/src/modules/` 作为“按业务域分组”的实现目录；`backend/src/services/` 在迁移期仅作为兼容层（re-export），最终可删除或保留为稳定门面。迁移按“先子目录（scm/workflow/pm/attachments）→ 再顶层实现（acp/runs/approvals/…）→ 最后清理兼容层”的顺序推进，保证每个 PR 足够小、可回滚、单测可护航。

**Tech Stack:** Fastify + TypeScript(ESM) + Prisma + Zod + Vitest。

---

## 背景（当前状态）

- `backend/src/services/` 目前同时存在：
  - **真实实现**：如 `acpTunnel.ts`、`startIssueRun.ts`、`workspaceCleanup.ts` 等。
  - **顶层 re-export**：如 `taskEngine.ts`、`githubPolling.ts` 等（实际实现已下沉到 `services/workflow/*`、`services/scm/*`）。
- 已出现“模块化雏形”（`services/scm`、`services/workflow`、`services/pm`、`services/attachments`），但整体仍被统一塞在 `services/`，域边界与公共入口不够清晰。

---

## 目标结构（建议）

### 目录与命名

将“域/能力”作为一级目录，形成稳定入口（每个模块可提供 `index.ts` 作为唯一导出面）：

```text
backend/src/
  modules/
    acp/
    approvals/
    artifacts/
    attachments/
    pm/
    runs/
    scm/
    security/
    templates/
    workflow/
    workspace/
  services/               # 迁移期：仅 re-export（兼容层）
```

### services → modules 归属映射（初版）

- `services/workflow/*` → `modules/workflow/*`
- `services/scm/*` → `modules/scm/*`
- `services/pm/*` → `modules/pm/*`
- `services/attachments/*` → `modules/attachments/*`
- `services/acpContent.ts`、`services/acpTunnel.ts`、`services/contextPack.ts` → `modules/acp/*`
- `services/startIssueRun.ts`、`services/runContext.ts`、`services/agentOutput.ts` → `modules/runs/*`
- `services/approvalRequests.ts` → `modules/approvals/*`
- `services/artifactPublish.ts` → `modules/artifacts/*`
- `services/textTemplates.ts` → `modules/templates/*`
- `services/redaction.ts` → `modules/security/*`
- `services/workspaceCleanup.ts` → `modules/workspace/*`

> 说明：当前 `services/*` 顶层文件里已有不少“单行 re-export”，迁移时优先把“真实实现”移动到 `modules/`，`services/` 只留薄薄一层。

---

## 渐进迁移策略（推荐）

### 原则

1. **每个 PR 只做一类搬迁**：先搬目录、后改引用、再清理兼容层，避免“又搬又改又重构”导致 review 困难。
2. **兼容层优先保留**：迁移期 `services` 继续存在，避免一次性改动所有 import（尤其 `backend/test/**`）。
3. **公共入口收敛**：迁移后逐步把外部引用统一改到 `modules/<mod>/index.ts`，减少跨文件耦合。
4. **可测试优先**：优先把纯逻辑从 IO 编排中抽出；重 IO 的模块先通过 mock + contract 测试护航。

### 风险与对策

- **ESM 路径与 `.js` 扩展名**：移动文件后相对路径易错。
  - 对策：优先迁移深度不变的子目录（`services/scm`→`modules/scm` 等）；每个 PR 都跑 `pnpm -C backend test` + `pnpm -C backend typecheck`。
- **循环依赖**：模块拆分后更容易暴露潜在循环。
  - 对策：每个模块只允许依赖“更底层”的模块（如 `workflow` 可以依赖 `templates/security`，但避免 `acp` ↔ `workflow` 双向）；必要时引入 “ports”（接口）打断循环。
- **测试大量使用 `../src/services/...`**：一次性改会很痛。
  - 对策：迁移期保留 `services` re-export；最后集中做一次“引用收敛”。

---

## Definition of Done（计划验收标准）

- `backend/src/services` 仅剩 re-export（或已删除），真实实现归位到 `backend/src/modules/**`。
- `pnpm -C backend test`、`pnpm -C backend typecheck`、`pnpm lint` 全通过。
- 覆盖率不下降（以 CI/阈值为准）；新增/调整的单测覆盖到搬迁涉及的关键分支。
- 文档更新：本计划从 `draft` 转 `active`（实施中）或最终 `archived`（完成/取消），并补齐“结局”。

---

## Tasks（按 PR 切分，建议顺序）

### Task 0: 建立基线与工作约定

**Files:** 无

**Step 1: 确认当前 main 基线与测试通过**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git fetch origin
git switch main
git pull --ff-only
pnpm -C backend test
pnpm -C backend typecheck
pnpm lint
```

Expected: 全绿。

**Step 2: 记录“services 依赖面”**

Run:
```powershell
rg -n "from \\\"\\.?\\.?/services/|from '\\.?\\.?/services/" backend/src backend/test
```

Expected: 输出作为后续收敛 import 的清单参考（无需提交）。

---

### Task 1: 创建 `modules/` 目录与空壳入口（不搬代码）

**Files:**
- Create: `backend/src/modules/README.md`（可选：写模块约束与导出规则）
- Create: `backend/src/modules/{acp,approvals,artifacts,attachments,pm,runs,scm,security,templates,workflow,workspace}/.gitkeep`（或用真实文件替代）

**Step 1: 创建目录结构**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
New-Item -ItemType Directory -Force -Path backend/src/modules | Out-Null
```

Expected: `backend/src/modules` 存在。

**Step 2: 提交一个纯结构 PR（可选）**

Run:
```powershell
git status
```

Expected: 仅新增目录/README。

---

### Task 2: 迁移 SCM 模块（`services/scm` → `modules/scm`）

**Files:**
- Move: `backend/src/services/scm/*` → `backend/src/modules/scm/*`
- Modify: `backend/src/services/scm/*`（改为 re-export）

**Step 1: 使用 `git mv` 搬迁实现文件**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git mv backend/src/services/scm backend/src/modules/scm
```

Expected: `backend/src/modules/scm/*.ts` 出现，旧路径消失。

**Step 2: 重建 `services/scm` 为兼容层**

- 为每个 `modules/scm/*.ts` 创建同名 `services/scm/*.ts`，内容仅做 re-export，例如：
  - `export * from "../../modules/scm/githubPolling.js";`

**Step 3: 跑测试 + 提交**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

Expected: 全绿。

---

### Task 3: 迁移 Workflow 模块（`services/workflow` → `modules/workflow`）

**Files:**
- Move: `backend/src/services/workflow/*` → `backend/src/modules/workflow/*`
- Modify: `backend/src/services/workflow/*`（改为 re-export）

**Step 1: `git mv` 搬迁**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git mv backend/src/services/workflow backend/src/modules/workflow
```

**Step 2: 重建 `services/workflow` 兼容层**

每个文件 re-export 到 `../../modules/workflow/*.js`。

**Step 3: 跑测试**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

---

### Task 4: 迁移 PM 与 Attachments 模块（同样策略）

**Files:**
- Move: `backend/src/services/pm` → `backend/src/modules/pm`
- Move: `backend/src/services/attachments` → `backend/src/modules/attachments`
- Modify: `backend/src/services/pm/*`、`backend/src/services/attachments/*`（改为 re-export）

**Step 1: 分别 `git mv`**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git mv backend/src/services/pm backend/src/modules/pm
git mv backend/src/services/attachments backend/src/modules/attachments
```

**Step 2: 重建兼容层并跑测试**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

---

### Task 5: 迁移顶层 services 实现（按域分批）

> 这一阶段会改变相对路径深度（`../` → `../../`），建议每个文件一个 PR 或按域 2~3 个文件一组。

#### 5.1 ACP 域

**Files:**
- Move: `backend/src/services/{acpContent,acpTunnel,contextPack}.ts` → `backend/src/modules/acp/*.ts`
- Modify: `backend/src/services/{acpContent,acpTunnel,contextPack}.ts`（保留为 re-export）

**Step 1: `git mv` + 修正相对 import**

Run:
```powershell
Set-Location -LiteralPath D:\xyad\tuixiu-backend
git mv backend/src/services/acpContent.ts backend/src/modules/acp/acpContent.ts
git mv backend/src/services/acpTunnel.ts backend/src/modules/acp/acpTunnel.ts
git mv backend/src/services/contextPack.ts backend/src/modules/acp/contextPack.ts
```

**Step 2: 修复 import 深度并跑测试**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

#### 5.2 Runs 域（run 生命周期/上下文）

**Files:**
- Move: `backend/src/services/{startIssueRun,runContext,agentOutput}.ts` → `backend/src/modules/runs/*.ts`
- Modify: `backend/src/services/{startIssueRun,runContext,agentOutput}.ts`（re-export）

#### 5.3 其余域

- `approvalRequests.ts` → `modules/approvals/approvalRequests.ts`
- `artifactPublish.ts` → `modules/artifacts/artifactPublish.ts`
- `textTemplates.ts` → `modules/templates/textTemplates.ts`
- `redaction.ts` → `modules/security/redaction.ts`
- `workspaceCleanup.ts` → `modules/workspace/workspaceCleanup.ts`

每个域独立 PR，避免爆炸式 diff。

---

### Task 6: 引用收敛（从 `services/*` 迁到 `modules/*`）

**Files:**
- Modify: `backend/src/**`（routes/executors/websocket/index）
- Modify: `backend/test/**`

**Step 1: 逐模块替换 import**

Run:
```powershell
rg -n \"from \\\"\\.?\\.?/services/|from '\\.?\\.?/services/\" backend/src backend/test
```

按输出列表逐个替换为 `modules/...`（优先走模块 `index.ts`）。

**Step 2: 全量测试**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
pnpm lint
```

---

### Task 7: 删除兼容层（或保留为门面）

**Option A（推荐收敛）：** 删除 `backend/src/services`，统一从 `modules` 导入。  
**Option B（保守）：** 保留 `services`，但强制只允许 re-export（通过 lint/CI 或简单脚本校验）。

**Files:**
- Delete/Modify: `backend/src/services/**`

**Step 1: 执行删除并跑测试**

Run:
```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

---

## 备注：运行时配置（后续里程碑，非本拆分阻塞）

本仓库已存在 `project/platform` 分层的模板能力（见现有 `textTemplates` 相关实现）。后续可将：

- `workflow/taskTemplates.ts`（内置模板常量）
- `workflow/taskTemplatePolicy.ts`（策略/约束）

逐步迁移为“平台默认 + 项目覆盖”的运行时配置（DB/配置中心），让控制权更多在运行时而不是代码里。

