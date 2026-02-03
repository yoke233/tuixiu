# GitCredential（项目级凭证）与 SCM 配置拆分 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用项目级 `GitCredential` 统一承载 Git/SCM 相关 secrets（高权限/低权限两套），并把 GitHub/GitLab 的项目配置从 `Project` 表拆出去，`RoleTemplate.envText` 不再承载任何 Git 认证相关内容。

**Architecture:** 在 DB 中新增 `GitCredential`（项目作用域）与 `ProjectScmConfig`（项目作用域）。`Project` 仅保留 repo 基础信息，并通过 `runGitCredentialId` / `scmAdminCredentialId` 引用两套凭证（低权限用于 Run 执行；高权限用于后台 SCM 自动化/审批/PR 操作）。运行时统一通过“Project + GitCredential”的合并对象生成 `TUIXIU_GIT_*`/`GH_TOKEN`/`GITLAB_*` 环境变量，避免 Role 注入 git secrets。

**Tech Stack:** Fastify + Prisma(PostgreSQL) + Vitest（backend）；Vite + React + Vitest（frontend）。

---

## 约定与非目标（先定边界）

- **不把 Run 的 SCM 状态字段**（`scmPrNumber/scmPrUrl/scmCiStatus/...`）并入 `GitCredential`；这些是运行态/索引查询字段，继续保留在 `Run` 表。
- **RoleTemplate.envText 仍保留**用于其它环境变量注入，但 **禁止/忽略** Git 相关 keys（避免权限绕过与困惑）。
- **两套凭证：**
  - `run`（低权限）：用于 git clone/fetch/push + Agent 内部必要的 `GH_TOKEN/GITLAB_TOKEN`（低权限）。
  - `scm_admin`（高权限）：用于 GitHub/GitLab API（创建/合并 PR、自动合并、issue 导入、轮询等）。

---

### Task 1: 设计与落库（新增表 + 兼容迁移）

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_gitcredential_and_project_scm_config/migration.sql`
- Modify: `backend/src/utils/publicProject.ts`
- Test: `backend/test/routes/projects.test.ts`

**Step 1: 先写一个会失败的路由测试（驱动 public project shape 变化）**

在 `backend/test/routes/projects.test.ts` 新增用例（先预期失败）：

```ts
it("GET /api/projects returns credential/config summary", async () => {
  const prisma = {
    project: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) },
    gitCredential: { findMany: vi.fn().mockResolvedValue([]) },
    projectScmConfig: { findMany: vi.fn().mockResolvedValue([]) },
  } as any;
  // 预期：hasRunGitCredential/hasScmAdminCredential/gitlabProjectId/githubPollingEnabled 等字段
});
```

**Step 2: 更新 Prisma schema（仅新增，不删旧字段）**

在 `backend/prisma/schema.prisma` 增加：

```prisma
model GitCredential {
  id              String   @id @default(uuid()) @db.Uuid
  projectId       String   @db.Uuid
  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  key             String   @db.VarChar(100) // e.g. run-default / scm-admin
  purpose         String?  @db.VarChar(20)  // "run" | "scm_admin"（先用 string，后续可 enum）
  gitAuthMode     String   @default("https_pat") @db.VarChar(20) // https_pat | ssh

  githubAccessToken String? @db.Text
  gitlabAccessToken String? @db.Text

  gitSshCommand   String?  @db.Text
  gitSshKey       String?  @db.Text
  gitSshKeyB64    String?  @db.Text

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([projectId, key])
  @@index([projectId])
}

model ProjectScmConfig {
  id                 String   @id @default(uuid()) @db.Uuid
  projectId           String   @unique @db.Uuid
  project             Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  gitlabProjectId     Int?     @unique
  gitlabWebhookSecret String?  @db.VarChar(255)

  githubPollingEnabled Boolean @default(false)
  githubPollingCursor  DateTime?

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([gitlabProjectId])
  @@index([githubPollingEnabled])
}
```

并在 `Project` model 里新增（先保留旧字段，便于迁移/回滚）：

```prisma
runGitCredentialId   String? @db.Uuid
runGitCredential     GitCredential? @relation("ProjectRunCredential", fields: [runGitCredentialId], references: [id], onDelete: SetNull)

scmAdminCredentialId String? @db.Uuid
scmAdminCredential   GitCredential? @relation("ProjectScmAdminCredential", fields: [scmAdminCredentialId], references: [id], onDelete: SetNull)

scmConfig            ProjectScmConfig?
```

**Step 3: 生成并编写 migration（含数据回填）**

运行（从 repo root）：

```powershell
pnpm -C backend prisma:migrate
```

在生成的 `migration.sql` 里加 data migration（伪代码/示例，按实际列名调整）：

```sql
-- 1) 为每个 project 创建两条 credential（run + scm_admin），先把旧 token 原样迁过去（后续再由管理员降权）
INSERT INTO "GitCredential" ("id","projectId","key","purpose","gitAuthMode","githubAccessToken","gitlabAccessToken","createdAt","updatedAt")
SELECT gen_random_uuid(), p."id", 'run-default', 'run', p."gitAuthMode", p."githubAccessToken", p."gitlabAccessToken", now(), now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "GitCredential" gc WHERE gc."projectId" = p."id" AND gc."key" = 'run-default'
);

INSERT INTO "GitCredential" ("id","projectId","key","purpose","gitAuthMode","githubAccessToken","gitlabAccessToken","createdAt","updatedAt")
SELECT gen_random_uuid(), p."id", 'scm-admin', 'scm_admin', p."gitAuthMode", p."githubAccessToken", p."gitlabAccessToken", now(), now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "GitCredential" gc WHERE gc."projectId" = p."id" AND gc."key" = 'scm-admin'
);

-- 2) 回填 Project 的默认 credential 引用
UPDATE "Project" p
SET "runGitCredentialId" = gc."id"
FROM "GitCredential" gc
WHERE gc."projectId" = p."id" AND gc."key" = 'run-default' AND p."runGitCredentialId" IS NULL;

UPDATE "Project" p
SET "scmAdminCredentialId" = gc."id"
FROM "GitCredential" gc
WHERE gc."projectId" = p."id" AND gc."key" = 'scm-admin' AND p."scmAdminCredentialId" IS NULL;

-- 3) SCM config 回填（gitlabProjectId/webhookSecret + github polling）
INSERT INTO "ProjectScmConfig" ("id","projectId","gitlabProjectId","gitlabWebhookSecret","githubPollingEnabled","githubPollingCursor","createdAt","updatedAt")
SELECT gen_random_uuid(), p."id", p."gitlabProjectId", p."gitlabWebhookSecret", p."githubPollingEnabled", p."githubPollingCursor", now(), now()
FROM "Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "ProjectScmConfig" c WHERE c."projectId" = p."id"
);
```

**Step 4: 更新 `toPublicProject`（先提供 summary，便于前端改造）**

在 `backend/src/utils/publicProject.ts`：
- 移除对旧字段（`githubAccessToken/gitlabAccessToken/...`）的依赖
- 从 `Project.runGitCredentialId/scmAdminCredentialId` + `Project.scmConfig` 计算：
  - `hasRunGitCredential`
  - `hasScmAdminCredential`
  - `gitlabProjectId`
  - `githubPollingEnabled`
  - `githubPollingCursor`

（注意：不返回 token）

**Step 5: 跑后端相关测试**

Run：

```powershell
pnpm -C backend test -- test/routes/projects.test.ts
```

Expected：PASS

**Step 6: Commit**

```powershell
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/utils/publicProject.ts backend/test/routes/projects.test.ts
git commit -m "feat: add GitCredential and ProjectScmConfig schema"
```

---

### Task 2: 新增 GitCredential API（CRUD + 默认绑定）

**Files:**
- Create: `backend/src/routes/gitCredentials.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/test/routes/gitCredentials.test.ts`

**Step 1: 写失败测试（CRUD）**

在 `backend/test/routes/gitCredentials.test.ts`：
- `GET /api/projects/:id/git-credentials` 返回列表（不含 secret，只含 hasGithubToken/hasGitlabToken/hasSshKey）
- `POST/PATCH/DELETE` 需要 admin（用 `auth.requireRoles(["admin"])`）

**Step 2: 实现路由**

新增 `backend/src/routes/gitCredentials.ts`，实现：
- `GET /:projectId/git-credentials`（所有登录用户可读，返回脱敏 DTO）
- `POST /:projectId/git-credentials`（admin）
- `PATCH /:projectId/git-credentials/:credentialId`（admin；支持 `clear` 语义：`null`=清空，`undefined`=不改）
- `DELETE /:projectId/git-credentials/:credentialId`（admin；若被 project 设为默认，先阻止或自动解绑）
- `PATCH /:projectId/git-credentials-defaults`（admin；设置 `runGitCredentialId` / `scmAdminCredentialId`）

DTO 示例（不返回 token）：

```ts
{
  id, projectId, key, purpose, gitAuthMode,
  hasGithubAccessToken: boolean,
  hasGitlabAccessToken: boolean,
  hasSshKey: boolean,
  updatedAt
}
```

**Step 3: 在 `backend/src/index.ts` 注册路由**

类似 role routes：

```ts
server.register(makeGitCredentialRoutes({ prisma, auth }), { prefix: "/api/projects" });
```

**Step 4: 跑测试**

```powershell
pnpm -C backend test -- test/routes/gitCredentials.test.ts
```

**Step 5: Commit**

```powershell
git add backend/src/routes/gitCredentials.ts backend/src/index.ts backend/test/routes/gitCredentials.test.ts
git commit -m "feat(backend): add git credential routes"
```

---

### Task 3: 新增 ProjectScmConfig API（只放“配置”，不放 token）

**Files:**
- Create: `backend/src/routes/projectScmConfig.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/test/routes/projectScmConfig.test.ts`

**Step 1: 写失败测试**
- `GET /api/projects/:id/scm-config`（登录可读）
- `PUT /api/projects/:id/scm-config`（admin；可更新 gitlabProjectId/gitlabWebhookSecret/githubPollingEnabled）

**Step 2: 实现路由（upsert）**

`PUT` 走 `upsert`：不存在则 create，存在则 update。

**Step 3: 注册路由 + 跑测试 + Commit**

```powershell
pnpm -C backend test -- test/routes/projectScmConfig.test.ts
git commit -m "feat(backend): add project scm config routes"
```

---

### Task 4: 后端统一“合并凭证 → 生成 Git env”工具（替代 Role 校验）

**Files:**
- Create: `backend/src/utils/gitCredentialRuntime.ts`
- Modify: `backend/src/utils/gitAuth.ts`
- Test: `backend/test/utils/gitCredentialRuntime.test.ts`

**Step 1: 写失败测试（关键路径）**

覆盖：
- `https_pat`：能从 `githubAccessToken/gitlabAccessToken` 挑出 git 用 password
- `ssh`：能输出 `TUIXIU_GIT_SSH_*`
- 当缺少必要字段时抛出带 code 的错误（用于前端提示）

**Step 2: 实现合并与 env 生成**

核心 API（示例）：

```ts
export function mergeGitAuthInput(project: { repoUrl: string; scmType?: string | null }, cred: any) {
  return {
    repoUrl: project.repoUrl,
    scmType: project.scmType ?? null,
    gitAuthMode: cred.gitAuthMode ?? null,
    githubAccessToken: cred.githubAccessToken ?? null,
    gitlabAccessToken: cred.gitlabAccessToken ?? null,
  };
}

export function buildGitRuntimeEnv(opts: { project: any; credential: any }): Record<string, string> {
  const input = mergeGitAuthInput(opts.project, opts.credential);
  // 复用/改造 resolveGitAuthMode/pickGitAccessToken/resolveGitHttpUsername
  // 输出：TUIXIU_GIT_AUTH_MODE / TUIXIU_GIT_HTTP_USERNAME / TUIXIU_GIT_HTTP_PASSWORD
  // 同时输出：GH_TOKEN/GITHUB_TOKEN/GITLAB_TOKEN/GITLAB_ACCESS_TOKEN（来自 credential，低权限）
}
```

并把 `assertRoleGitAuthEnv` 逐步降级：
- 运行时不再依赖 role env 里的 `TUIXIU_GIT_AUTH_MODE`
- 后续 Task 8 再考虑删除旧函数/错误类型

**Step 3: 跑测试 + Commit**

```powershell
pnpm -C backend test -- test/utils/gitCredentialRuntime.test.ts
git commit -m "refactor(backend): build git env from GitCredential"
```

---

### Task 5: Run 启动/恢复/推送改用 GitCredential（低权限）

**Files:**
- Modify: `backend/src/modules/runs/startIssueRun.ts`
- Modify: `backend/src/modules/runs/runRecovery.ts`
- Modify: `backend/src/executors/acpAgentExecutor.ts`
- Modify: `backend/src/utils/sandboxGitPush.ts`
- Test: `backend/test/modules/runs/startIssueRun.test.ts`
- Test: `backend/test/modules/runs/runRecovery.test.ts`

**Step 1: 先改测试（让旧 role git env 不再是必需）**
- 更新 `startIssueRun`/`runRecovery` 的测试夹具：Role 的 `envText` 不再包含 `TUIXIU_GIT_AUTH_MODE/GH_TOKEN/...`
- 新增一个用例：当 project 没配置 `runGitCredentialId` 且 policy=git 时，返回可读错误码（例如 `RUN_GIT_CREDENTIAL_MISSING`）

**Step 2: 实现读取 Project.runGitCredentialId 并生成 initEnv**
- `startIssueRun.ts`：在 `resolvedPolicy.resolved === "git"` 时，查询 `GitCredential`（run），生成 git env 注入到 `initEnv`
- `runRecovery.ts`：同上
- `acpAgentExecutor.ts`：同上（任务流的 agent 执行）
- `sandboxGitPush.ts`：改为接收“合并后的输入/或 credential”，不要再依赖 `Project.githubAccessToken/gitlabAccessToken`

**Step 3: 跑定向测试**

```powershell
pnpm -C backend test -- test/modules/runs/startIssueRun.test.ts
pnpm -C backend test -- test/modules/runs/runRecovery.test.ts
```

**Step 4: Commit**

```powershell
git commit -m "feat(backend): use run GitCredential for run init and git push"
```

---

### Task 6: SCM 相关后台逻辑改用 SCM Admin Credential（高权限）+ 新 ScmConfig

**Files:**
- Modify: `backend/src/modules/scm/runReviewRequest.ts`
- Modify: `backend/src/modules/approvals/approvalRequests.ts`
- Modify: `backend/src/routes/githubIssues.ts`
- Modify: `backend/src/modules/scm/githubPolling.ts`
- Modify: `backend/src/routes/gitlabWebhooks.ts`
- Modify: `backend/src/routes/githubWebhooks.ts`
- Tests: 相关 backend tests（见下）

**Step 1: 逐个模块加/改测试（先失败）**
- `backend/test/routes/githubIssues.test.ts`：把 “Project 未配置 GitHub token” 改为 “未配置 scmAdmin credential 的 github token”
- 给 `runReviewRequest` 新增单测：push 用 run credential；创建 PR/merge 用 admin credential
- GitHub polling：当 `ProjectScmConfig.githubPollingEnabled=true` 且 admin credential 有 github token 时才执行
- GitLab webhook：根据 `ProjectScmConfig.gitlabProjectId` 找 project，并用 `ProjectScmConfig.gitlabWebhookSecret` 校验

**Step 2: 实现：统一从 Project 取两套 credential**
- 增加 helper：`loadProjectCredentials(projectId)` → `{ run, admin }`
- `runReviewRequest.ts`：
  - push：用 run credential 生成 env
  - GitLab MR：用 admin.gitlabAccessToken
  - GitHub PR/merge/comment：用 admin.githubAccessToken
- `approvalRequests.ts`：合并/创建 PR 走 admin credential
- `githubIssues.ts`：导入 issues 走 admin.githubAccessToken
- `githubPolling.ts`：读取 `ProjectScmConfig`，并用 admin.githubAccessToken
- `gitlabWebhooks.ts`：读取 `ProjectScmConfig`，不再读 Project 上的 gitlabProjectId/webhookSecret
- `githubWebhooks.ts`：auto merge 使用 admin.githubAccessToken（不再读 Project.githubAccessToken）

**Step 3: 跑定向测试**

```powershell
pnpm -C backend test -- test/routes/githubIssues.test.ts
pnpm -C backend test -- test/routes/projects.test.ts
pnpm -C backend test
```

**Step 4: Commit**

```powershell
git commit -m "refactor(backend): move scm secrets/config to GitCredential + ProjectScmConfig"
```

---

### Task 7: 前端 Admin UI 改造（Project 只保留基础；新增“凭证/SCM 配置”面板）

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/projects.ts`
- Create: `frontend/src/api/gitCredentials.ts`
- Create: `frontend/src/api/projectScmConfig.ts`
- Modify: `frontend/src/pages/admin/sections/ProjectsSection.tsx`
- (可选) Test: `frontend/src/pages/admin/sections/ProjectsSection.test.tsx`

**Step 1: 先改类型（让 TS 报错暴露改造面）**
- `Project` 移除：`gitAuthMode/gitlabAccessToken/githubAccessToken/gitlabProjectId/gitlabWebhookSecret/githubPollingEnabled/githubPollingCursor/hasGithubAccessToken/hasGitlabAccessToken`
- `Project` 增加 summary：`hasRunGitCredential/hasScmAdminCredential`（以及可选 `gitlabProjectId/githubPollingEnabled/githubPollingCursor`）
- 新增 `GitCredential` / `ProjectScmConfig` type

**Step 2: 新增 API client**
- `gitCredentials.ts` 对齐后端：list/create/update/delete/setDefaults
- `projectScmConfig.ts`：get/put

**Step 3: 改 ProjectsSection UI**
- 删除旧的 GitLab/GitHub token/ProjectId/webhookSecret/polling UI（对应旧 Project 字段）
- 新增两个折叠面板：
  - “Git 凭证（低权限 Run）”：编辑 `run-default`（或选择一个 credential 作为默认）
  - “SCM Admin 凭证（高权限）”：编辑 `scm-admin`
  - “SCM 配置”：GitLab projectId/webhookSecret + GitHub polling enabled/cursor（cursor 只读）
- 文案明确：Role 的 envText 不负责 git 认证

**Step 4: 跑前端测试/类型检查**

```powershell
pnpm -C frontend test
pnpm -C frontend typecheck
```

**Step 5: Commit**

```powershell
git commit -m "feat(frontend): manage git credentials and scm config in admin UI"
```

---

### Task 8: 删除旧字段（破坏性迁移）+ 清理旧逻辑

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_drop_project_scm_secret_fields/migration.sql`
- Modify: `backend/src/routes/projects.ts`
- Modify: `frontend/src/pages/admin/sections/ProjectsSection.tsx`
- Update: 相关 backend/frontend tests
- Docs: `docs/03_guides/*`（新增“如何配置凭证/权限分层”）

**Step 1: 先把后端代码切到“只读新表”（不再 fallback 旧字段）**
- 删除所有 `project.githubAccessToken/gitlabAccessToken/gitlabProjectId/gitlabWebhookSecret/githubPollingEnabled/githubPollingCursor/gitAuthMode` 的读取
- 若缺少配置：统一返回明确错误码（前端可直接弹窗）

**Step 2: Prisma 迁移：从 Project 表 drop 旧列**
- 从 `Project` model 删除旧字段（上面列表）
- 生成 migration 并确认不会误删新表数据

**Step 3: 更新 projects routes**
- `POST/PATCH /api/projects` bodySchema 移除旧字段
- 前端同时删除相关提交字段（已在 Task 7 做完）

**Step 4: RoleTemplate.envText 禁止 git keys（可选但推荐）**
- 在 `backend/src/routes/roleTemplates.ts` 的 `normalizeEnvText` 后增加检查：
  - 若 env keys 命中：`TUIXIU_GIT_* / GH_TOKEN / GITHUB_TOKEN / GITLAB_TOKEN / GITLAB_ACCESS_TOKEN`
  - 返回 `{ success:false, error:{ code:"ROLE_ENV_GIT_KEYS_FORBIDDEN", message:"Git 认证已迁移到 GitCredential，请在 Project 凭证中配置", details:[...] } }`
- 同步更新 `frontend` RolesSection 文案（不再提示 GH_TOKEN）

**Step 5: 全量测试**

```powershell
pnpm test
pnpm lint
pnpm typecheck
```

**Step 6: Commit**

```powershell
git commit -m "refactor!: remove scm/git secret fields from Project and Role env"
```

---

## 回滚策略（必须写清）

- 迁移分两步：先 **新增表+回填**，确认线上读写新表稳定后再 **drop 旧列**。
- 若出现严重问题：回滚到只读旧列的版本（在 drop 旧列之前可以无损回滚）。

---

## 验收清单

- 启动 Run（git policy）时不再要求 Role env 配 `TUIXIU_GIT_AUTH_MODE`；缺配置时前端弹窗显示明确错误码与 message。
- `sandboxGitPush` / 创建 PR / 合并 PR / 自动合并 / GitHub issue 导入 / GitHub polling / GitLab webhook 均改为读新表。
- 前端 Projects 管理页不再出现旧的 GitHub/GitLab token 字段；改为 GitCredential + SCM config 面板。
- secrets 不通过任何 API 响应泄露（只返回 has* 标记）。

