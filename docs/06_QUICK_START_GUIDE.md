# 快速开始手册（当前仓库）

本文档面向“直接跑起来并完成一次完整闭环”。不再包含旧版“从零搭建/示例伪代码”，真实实现以仓库代码为准。

---

## 1. 启动（Windows / PowerShell）

先按 `docs/02_ENVIRONMENT_SETUP.md` 完成环境与数据库准备（`backend` 的 `pnpm dev` 会自动应用 Prisma 迁移），然后在三个终端分别启动：

```powershell
# 终端 1：backend
cd backend
pnpm dev
```

```powershell
# 终端 2：proxy
cd acp-proxy
Copy-Item config.json.example config.json
notepad config.json
pnpm dev
```

```powershell
# 终端 3：frontend
cd frontend
pnpm dev
```

浏览器打开：`http://localhost:5173`

---

## 1.1 启动（Linux / WSL2）

- 纯 Linux：三段命令与 Windows 相同（分别在 `backend/`、`acp-proxy/`、`frontend/` 运行 `pnpm dev`）。
- A 形态（backend/frontend 在 Windows，proxy 在 WSL2）：WSL2 内启动 `acp-proxy` 时，`orchestrator_url` 不能用 `localhost`，需要配置为 Windows Host IP；并开启 `pathMapping` 把 `D:\\...` 转成 `/mnt/d/...`。

---

## 1.2 启动（macOS）

- 默认建议 `sandbox.provider=host_process`（本机直跑），`orchestrator_url` 可继续用 `ws://localhost:3000/ws/agent`。
- 如需 `sandbox.provider=boxlite_oci`：仅 Apple Silicon(arm64) 且 macOS 12+；Intel Mac 暂不支持。

---

## 2. 最小闭环（推荐用 UI）

1. 创建 Project（填写 `repoUrl` + SCM token）
2. 创建 Issue（进入 `pending` 需求池）
3. 在 Issue 详情页点击“启动 Run”（选择/自动分配 Agent）
4. 观察右侧控制台输出（RunConsole）与状态变化
5. 在下方输入框继续对话（同一个 Run/session）
6. 查看变更（files + diff）
7. 点击“一键创建 PR”，进入 Review 流程（当前为后端直连 GitLab/GitHub API）

---

## 3. Run 工作区与分支（关键约定）

后端在启动 Run 时会自动创建独立工作区与分支（两种模式）：

- `workspaceMode=worktree`（默认）：`<repoRoot>/.worktrees/run-<worktreeName>`（需要在该 repo 目录里启动 `backend`）
- `workspaceMode=clone`：`<WORKSPACES_ROOT>/run-<runId>`（默认 `$HOME/.tuixiu/workspaces`），并维护 `REPO_CACHE_ROOT/<projectId>.git` mirror 缓存（best-effort）用于加速 clone（默认 `$HOME/.tuixiu/repo-cache`）
- 分支名：`run/<worktreeName>`

并把 `cwd=<workspacePath>` 透传给 proxy/ACP session，让 agent 在隔离环境里修改代码。  
**约定**：agent 在该分支上完成修改后应执行 `git commit`，随后由后端负责 `git push` 并创建 PR。

实现参考：

- worktree：`backend/src/utils/gitWorkspace.ts`
- clone/worktree 统一入口：`backend/src/utils/runWorkspace.ts`
- 启动 Run：`backend/src/routes/issues.ts`

---

## 4. 关键 API（给脚本/调试用）

> Windows/pwsh 调本地 API：建议用 `curl.exe --noproxy 127.0.0.1 ...`

### 4.1 Project

- `GET /api/projects`
- `POST /api/projects`

示例：

```powershell
curl.exe --noproxy 127.0.0.1 -X POST http://localhost:3000/api/projects `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"demo\",\"repoUrl\":\"https://gitlab.example.com/group/repo\",\"scmType\":\"gitlab\",\"defaultBranch\":\"main\",\"workspaceMode\":\"clone\",\"gitAuthMode\":\"https_pat\",\"gitlabProjectId\":123,\"gitlabAccessToken\":\"<token>\"}'
```

### 4.2 Issue（需求池）

- `POST /api/issues`：创建 Issue（进入 `pending`）
- `POST /api/issues/:id/start`：启动 Run（可选传 `agentId`）
- `GET /api/issues/:id`：详情（包含 runs 列表）

### 4.3 Run（对话/变更/PR）

- `GET /api/runs/:id`：Run 详情（含 `acpSessionId/workspacePath/branchName/artifacts`）
- `GET /api/runs/:id/events`：事件流（后端按 timestamp desc 返回）
- `POST /api/runs/:id/prompt`：继续对话（后端会尽量复用 `Run.acpSessionId`）
- `GET /api/runs/:id/changes` / `GET /api/runs/:id/diff?path=...`：变更列表与 diff
- `POST /api/runs/:id/create-pr`：创建 PR（GitLab MR / GitHub PR）
- `POST /api/runs/:id/merge-pr`：合并 PR（高危动作；推荐走审批流程）
- `POST /api/runs/:id/request-merge-pr`：发起“合并 PR”审批请求（生成 `report(kind=approval_request)`）
- `GET /api/approvals`：查看审批队列
- `POST /api/approvals/:id/approve`：批准并执行（例如合并 PR）
- `POST /api/approvals/:id/reject`：拒绝审批请求

实现参考：

- Run routes：`backend/src/routes/runs.ts`
- PR：`backend/src/services/runReviewRequest.ts`

---

## 5. Proxy 配置（acp-proxy/config.json）

最小配置项：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `cwd`: repo 根目录（运行中会覆盖为 Run 的 workspace cwd）
- `agent.max_concurrent`: 单个 Agent 的并发 Run 上限（ACP 支持多 `session`；>1 时可并行多个 Run，但更吃 CPU/内存）
- `agent_command`: 默认 `["npx","--yes","@zed-industries/codex-acp"]`（可替换为任意 ACP 兼容 Agent）
- `sandbox.provider`: 默认 `host_process`（`boxlite_oci` 仅 WSL2/Linux/macOS Apple Silicon 可用）
- `pathMapping`: 可选（仅当你在 WSL 内运行 proxy 且后端传入 Windows 路径时使用，把 `D:\\...` 转成 `/mnt/d/...`）

示例：替换为其它 ACP agent 启动命令：

```json
{ "agent_command": ["npx", "--yes", "<some-acp-agent>"] }
```

示例：使用 BoxLite（`sandbox.provider=boxlite_oci`）在 OCI/micro-VM 里运行 ACP Agent：

```json
{
  "sandbox": {
    "provider": "boxlite_oci",
    "boxlite": {
      "image": "ghcr.io/<org>/codex-acp:latest",
      "workingDir": "/workspace",
      "env": { "OPENAI_API_KEY": "<key>" },
      "volumes": [{ "hostPath": "/mnt/d/repo/tuixiu", "guestPath": "/workspace" }]
    }
  }
}
```

> 镜像参考：`docs/references/agent-images/codex-acp/Dockerfile`（建议构建并推送到 registry，供 BoxLite 拉取）。

WSL2/Linux 最短链路（假设已准备好可拉取的镜像）：

```bash
pnpm -C acp-proxy add @boxlite-ai/boxlite
# 编辑 acp-proxy/config.json：按上面的 boxlite_oci 示例配置 image/volumes/pathMapping
pnpm -C acp-proxy dev
```

Windows 下如遇 `spawn npx ENOENT`，请先确认 `where.exe npx` 可用；proxy 已内置 `cmd.exe /c` shim（`acp-proxy/src/sandbox/hostProcessSandbox.ts`）。

---

## 6. 一键验证

```powershell
pnpm test
pnpm test:coverage
```

---

## 7. 常见排错

- 前端列表/详情不更新：确认 WS 已连接（页面顶部 `WS: connected`）以及 backend 端口正确
- 无法继续对话：确认 Agent 在线（`GET /api/agents`）且 Run 已绑定 `acpSessionId`
- PR 创建失败：检查 Project 的 token/权限、以及分支是否已 push（后端会在创建 PR 前 `git push`）
