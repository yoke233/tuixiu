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

## 快速使用（面向普通用户）

你只需要把服务跑起来，并在 Web UI 里完成一次“创建 Project → 创建 Issue → 启动 Run”的闭环。

### 0) 前置条件

- 安装：Node.js 20+、`pnpm`、Docker Desktop（用于 Postgres）
- 准备 ACP Agent 运行所需的凭据（例如 `OPENAI_API_KEY`），并让 `acp-proxy` 能读取到（见 `docs/03_guides/environment-setup.md`）

### 1) 安装依赖 + 启动数据库

```powershell
pnpm install
docker compose up -d postgres

Copy-Item backend/.env.example backend/.env
Copy-Item acp-proxy/config.toml.example acp-proxy/config.toml
```

编辑 `acp-proxy/config.toml`（最少确认这些）：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `sandbox.provider`: Windows 推荐 `container_oci`（详细选型见 `docs/03_guides/environment-setup.md`）

### 2) 启动服务（3 个终端）

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

打开：`http://localhost:5173/bootstrap` → 从后端启动日志复制 bootstrap token 初始化管理员 → 登录。

### 3) 在 UI 跑通一次闭环（最短路径）

1. **创建 Project**（仓库 URL + Token/认证方式）
2. **创建/导入 Issue**
3. 在 Issue 详情页启动 Run（或创建 Task 后启动 Step）
4. 在浏览器里查看输出、diff、产物，并按流程创建/合并 PR（可选）

### 4) 可选：Docker Compose 冒烟

```powershell
docker compose up -d
```

该模式用于“一键冒烟”验证镜像与链路，不推荐作为日常开发模式；更多说明见 `docs/03_guides/environment-setup.md`。

---

## 概念速览（普通用户只需要知道这些）

- **Project**：一个 Project 对应一个仓库（`repoUrl`），并保存 SCM Token/工作区模式等配置
- **Issue**：需求/任务条目（进入需求池）
- **Task**：在一个 Issue 下的一次“可追踪工作流实例”（由模板创建）(尚未完善)
- **Step**：Task 的步骤（`executorType=agent/ci/human/system`）(尚未完善)
- **Run（Execution）**：某个 Step 的一次执行尝试（会产生事件流与产物）

---

## 更多文档

- 一页环境搭建（Windows/macOS/Linux）：`docs/03_guides/environment-setup.md`
- 架构与链路深挖（开发者）：`docs/repo_review.md`
- 文档索引（从这里开始）：`docs/00_overview/index.md`
- 公网/IAP 部署建议：`docs/security/iap.md`

---

### 一键验证（跑测试）

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

### 常见问题

- **页面不刷新/看不到输出**：确认前端显示 `WS: connected`，以及 backend/proxy 都在运行
- **无法启动 Step / 提示未登录**：先访问 `http://localhost:5173/login` 登录（首次用 `/bootstrap` 初始化管理员）
- **Agent 无输出**：检查 `acp-proxy/config.toml` 的 `agent_command` 与 `orchestrator_url`，以及环境变量（如 `OPENAI_API_KEY`）
- **PR 创建失败**：检查 Project token 权限、以及 `worktree` 模式下本机是否能 `git push origin <branch>`

> Windows 下命令行调本地 API：建议用 `curl.exe --noproxy 127.0.0.1 ...`，避免系统代理影响。

---

## 公网部署注意事项

- 不要把后端 `3000` 端口直接暴露公网，置于反向代理/IAP/SSO/MFA 之后
- `/api/*` 与 `/ws/*` 需受门禁保护；仅 `/api/webhooks/*` 可公网放行
