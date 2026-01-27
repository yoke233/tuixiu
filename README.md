# TuiXiu（ACP 协作台）

把 GitHub/GitLab/Codeup 的 Issue 交给 ACP 兼容的 Coding Agent：在隔离工作区里改代码、运行测试、生成报告，并产出可审查的 PR/MR。

> 状态：MVP 可用（本地运行优先）  
> 默认 Agent：Codex CLI（通过 `acp-proxy` 启动 ACP Agent）

---

## 你能用它做什么

- **需求池**：Issue 统一进池（`pending`）
- **多步骤任务**：Issue 下创建 Task，按 Step（agent/ci/human/system）推进，支持打回→回滚→重跑（保留历史 attempt）
- **隔离工作区**：每次 Run 自动创建分支 + worktree/clone 工作区，避免污染主分支
- **浏览器里看过程**：Console 实时输出、变更文件与 diff、产物（report/ci_result）
- **PR 闭环**：一键创建 PR（GitHub/GitLab），合并动作可进入审批队列
- **Webhook（可选）**：GitHub issue 自动导入、GitHub CI 结果回写；Codeup MR 合并回写

---

## 快速开始（Windows / PowerShell）

### 0) 前置条件

- 安装：`git`、Node.js 20+、`pnpm`、Docker Desktop（用于 Postgres）
- 准备一个 ACP Agent（默认：`npx --yes @zed-industries/codex-acp`），并在运行 `acp-proxy` 的环境里准备好 API Key（例如 `OPENAI_API_KEY`）

### 1) 安装依赖 + 启动数据库

```powershell
pnpm install
docker compose up -d

Copy-Item backend/.env.example backend/.env
Copy-Item acp-proxy/config.json.example acp-proxy/config.json
```

编辑 `acp-proxy/config.json`（至少确认）：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `cwd`: 本仓库根目录（运行中会覆盖为 Run 的 workspace）

### 2) 启动（3 个终端）

终端 1：backend

```powershell
pnpm -C backend dev
```

终端 2：acp-proxy

```powershell
$env:OPENAI_API_KEY="..."
pnpm -C acp-proxy dev
```

终端 3：frontend

```powershell
pnpm -C frontend dev
```

打开：`http://localhost:5173/login` → 点击“初始化管理员（首次）” → 登录。

> 也可以用 `pnpm dev` 一次性启动全部包（输出会混在同一终端，不如三终端清晰）。

### 3) 跑通一次闭环（UI）

1. **创建 Project**（仓库 + Token）
2. **创建/导入 Issue**
3. 在 Issue 详情页创建 Task（选择内置模板）并启动 Step
4. 等 agent 产出 commit/报告后，继续执行后续 Step（评审/PR/CI/合并）

---

## 概念速览（普通用户只需要知道这些）

- **Project**：一个 Project 对应一个仓库（`repoUrl`），并保存 SCM Token/工作区模式等配置
- **Issue**：需求/任务条目（进入需求池）
- **Task**：在一个 Issue 下的一次“可追踪工作流实例”（由模板创建）
- **Step**：Task 的步骤（`executorType=agent/ci/human/system`）
- **Run（Execution）**：某个 Step 的一次执行尝试（会产生事件流与产物）

---

## 工作区模式怎么选（重要）

创建 Project 时需要选 `workspaceMode`：

| 模式 | 适合谁 | 你需要准备什么 |
| --- | --- | --- |
| `worktree`（默认） | 你已经在本机 clone 了目标仓库 | **在该 repo 目录里启动 backend**，且本机 Git 能 `git push`（SSH key / GCM / 凭据） |
| `clone` | 不想预先 clone / 想跑多个仓库 | 让后端自动 clone（会用 `WORKSPACES_ROOT` 与 `REPO_CACHE_ROOT`），并在 Project 配好 git 认证方式（HTTPS PAT / SSH） |

注意：SCM token 用于调用 GitHub/GitLab API（创建/合并 PR 等）；`git push` 在 `worktree` 模式下仍依赖本机 Git 的认证配置。

---

## 集成与 Webhook（可选）

### GitHub（最常用）

**PAT 权限建议（fine-grained）**

- `Contents: Read & write`
- `Pull requests: Read & write`
- `Issues: Read-only`（仅导入）

**自动导入 Issue + CI 回写**

后端接口：`POST /api/webhooks/github`（同一个入口处理 Issues 与 CI 事件）

1. 在 `backend/.env` 配置：`GITHUB_WEBHOOK_SECRET="xxx"`（推荐）
2. GitHub 仓库 → Settings → Webhooks → Add webhook
   - Payload URL：`https://<你的可访问域名>/api/webhooks/github`
   - Content type：`application/json`
   - Secret：与 `GITHUB_WEBHOOK_SECRET` 一致
   - Which events：
     - 必选：**Issues**
     - CI 回写：**Workflow runs** / **Check runs** / **Check suites**
     - PR 流转（推荐）：**Pull requests**（用于同步 PR 状态/合并回写/打回重跑）
     - PR 人工评审（可选）：**Pull request reviews**（用于 `CHANGES_REQUESTED` 打回）
3. GitHub 访问不到 `localhost`，需要用 ngrok / Cloudflare Tunnel 等把 `3000` 端口暴露出去

**PR 自动评审（可选）**

- 在 `backend/.env` 配置：`GITHUB_PR_AUTO_REVIEW_ENABLED=1`
- 同时配置 `PM_LLM_*` 或 `OPENAI_API_KEY`（用于生成评审内容）
- Webhook 需要勾选 **Pull requests**（打开/更新时触发）；评审结果会以评论形式回写到 PR

### Codeup（云效）

后端接口：`POST /api/webhooks/codeup`（用于 MR 合并回写）

1. 在 `backend/.env` 配置：`CODEUP_WEBHOOK_SECRET="xxx"`（推荐）
2. Codeup 仓库 → 设置 → WebHooks
   - URL：`https://<你的可访问域名>/api/webhooks/codeup`
   - Secret Token：与 `CODEUP_WEBHOOK_SECRET` 一致（Codeup 会通过 `X-Codeup-Token` 发送）
   - 触发器：合并请求事件（Merge Request Hook）

### GitLab

已支持 PR/MR 创建/合并与基础集成，详见：`docs/05_GITLAB_INTEGRATION.md`。

---

## 安全提示（强烈建议读）

- SCM Token 目前会以明文字段写入数据库，请仅在可信环境使用，并尽量使用最小权限 token
- RoleTemplate 的 `initScript` 在 `acp-proxy` 所在机器执行，等同运行本地脚本；建议仅管理员可编辑

---

## 验证与排错

### 一键验证（跑测试）

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

### 常见问题

- **页面不刷新/看不到输出**：确认前端显示 `WS: connected`，以及 backend/proxy 都在运行
- **无法启动 Step / 提示未登录**：先访问 `http://localhost:5173/login` 登录（首次用 bootstrap）
- **Agent 无输出**：检查 `acp-proxy/config.json` 的 `agent_command` 与 `orchestrator_url`，以及环境变量（如 `OPENAI_API_KEY`）
- **PR 创建失败**：检查 Project token 权限、以及 `worktree` 模式下本机是否能 `git push origin <branch>`

> Windows 下命令行调本地 API：建议用 `curl.exe --noproxy 127.0.0.1 ...`，避免系统代理影响。

---

## 更多文档（按需深入）

- 快速跑通一次闭环：`docs/06_QUICK_START_GUIDE.md`
- 系统架构与数据流：`docs/01_SYSTEM_ARCHITECTURE.md`
- 当前进度与下一步：`docs/ROADMAP.md`
- 当前执行计划（PM Agent）：`docs/plans/2026-01-27-pm-agent-execution-plan.md`
- 历史计划归档：`docs/archive/plans/`
- 工作流优化方案（BMAD-Lite）：`docs/09_WORKFLOW_OPTIMIZATION_BMAD_LITE.md`
- 完整 PRD（历史/设计文档）：`PRD_ACP_Driven_Dev_Collab_System_v2.md`
