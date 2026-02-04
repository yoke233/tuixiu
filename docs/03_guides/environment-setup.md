---
title: "环境搭建（当前仓库）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-31"
---

# 环境搭建文档（当前仓库）

本文档只描述**把本仓库跑起来**所需的环境与步骤（旧版“从零搭框架/Go Proxy/Python Proxy”的内容已过时并已从仓库实现中移除）。

---

## 1. 系统要求

- ✅ Windows 10/11（PowerShell）/ macOS / Linux
- ✅ Git（用于 worktree/分支/提交/推送）
- ✅ Docker Desktop / Docker Engine（用于启动 Postgres，推荐）

---

## 2. 必装工具

### 2.1 Node.js

- 推荐：Node.js 20+（至少 Node.js 18+）

验证：

```powershell
node --version
npm --version
```

### 2.2 pnpm

本仓库使用 pnpm workspace（见根目录 `package.json` 的 `packageManager`）。

安装与验证：

```powershell
npm install -g pnpm
pnpm --version
```

### 2.3 Docker（推荐）

验证：

```powershell
docker --version
docker compose version
```

---

## 3. 安装依赖

在仓库根目录执行：

```powershell
pnpm install
```

---

## 4. 启动数据库 + Prisma 迁移

### 4.1 启动 PostgreSQL（Docker Compose）

仓库根目录自带 `docker-compose.yml`（仅包含 Postgres）：

```powershell
docker compose up -d
```

### 4.2 配置后端环境变量

```powershell
Copy-Item backend/.env.example backend/.env
```

> 目前后端必需的只有 `DATABASE_URL`。GitLab/GitHub 的 token 等配置通过“创建 Project”时写入数据库，不再依赖环境变量。
>
> Run 工作区/缓存相关（`WORKSPACES_ROOT`、`REPO_CACHE_ROOT`、TTL 清理参数）是可选项：留空则默认使用 `$HOME/.tuixiu/*`。

### 4.3 应用 Prisma 迁移（自动）

`backend` 的 `pnpm dev` 启动时会自动执行 `pnpm prisma:deploy`（`prisma migrate deploy`）以应用已有迁移文件，因此通常无需手动执行。

如需手动执行：

```powershell
cd backend
pnpm prisma:deploy
```

> 仅当你在本地修改了 `prisma/schema.prisma` 并需要**生成新迁移**时，才需要用 `pnpm prisma:migrate`（`prisma migrate dev`）。

---

## 5. 启动三件套（backend + proxy + frontend）

### 5.1 启动后端（Orchestrator）

```powershell
cd backend
pnpm dev
```

验证（Windows/pwsh 注意使用 `curl.exe` 并关闭代理）：

```powershell
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/projects
```

### 5.2 启动本地 Proxy（acp-proxy）

```powershell
cd acp-proxy
Copy-Item config.toml.example config.toml
notepad config.toml
pnpm dev
```

#### 5.2.0 最小配置示例（只填 2~3 项即可跑）

你可以从 `config.toml.example` 精简到类似下面的最小配置：

```toml
orchestrator_url = "ws://localhost:3000/ws/agent"

[sandbox]
# Windows/macOS Intel：默认 container_oci（可省略 provider）
# Linux/WSL2/macOS Apple Silicon：可改为 boxlite_oci
provider = "container_oci"

# 把 API Key 注入到 guest（不要提交到仓库）
env = { OPENAI_API_KEY = "<your key>" }
```

说明（对应本仓库当前实现）：

- `agent.id` 会自动生成并落盘（无需手填）
- `sandbox.runtime`（container_oci）会自动探测 `docker/podman/nerdctl`（找不到会报错）
- `sandbox.image`（非 host_process）默认 `tuixiu-codex-acp:local`

`config.toml` 其他常用字段：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `sandbox.provider`: `container_oci`（Windows/macOS Intel 默认）或 `boxlite_oci`（Linux/WSL2/macOS Apple Silicon）
- `sandbox.image`: ACP Agent 镜像（可选；默认 `tuixiu-codex-acp:local`）
- `sandbox.runtime`: `docker`/`podman`/`nerdctl`（可选；`provider=container_oci` 时会自动探测）
- `sandbox.agentMode`: `exec`（默认，通过 `docker exec` 启动 agent）或 `entrypoint`（容器主进程为 agent；如提供 `acp_open.init.script` 会在 agent 启动前执行）
- `pathMapping`: 可选（仅当你在 WSL 内运行 proxy 且后端传入 Windows 路径时使用）
- `agent_command`: 默认 `["npx","--yes","@zed-industries/codex-acp"]`

#### 5.2.1 WSL2 运行 proxy（A 形态）

当 `backend/frontend` 跑在 Windows、`acp-proxy` 跑在 WSL2：

- WSL2 内的 `localhost` 指向 WSL2 自己；`orchestrator_url` 需要配置为 Windows Host IP。
- 后端透传的 `cwd` 若是 Windows 路径（如 `D:\\repo\\...`），需要开启 `pathMapping` 转成 `/mnt/d/repo/...`。

WSL2 内获取 Windows Host IP 示例：

```bash
ip route | awk '/default/ {print $3}'
```

#### 5.2.2 BoxLite（sandbox.provider=boxlite_oci）

BoxLite 用于把 ACP Agent 放入 micro-VM/OCI 沙箱运行：

- Windows：请使用 `sandbox.provider=container_oci`
- Linux：需要 `/dev/kvm` 可用。
- macOS：仅支持 Apple Silicon(arm64) 且 macOS 12+；Intel Mac 暂不支持。

BoxLite Node SDK 已作为 `acp-proxy` 依赖（`pnpm install` 后即可）。若你使用了裁剪安装/旧 lock，确保已安装：`pnpm -C acp-proxy install`。

注意：Codex 类 Agent 通常需要 API Key（例如 `OPENAI_API_KEY`）；建议通过 `sandbox.boxlite.env` 注入（不要提交到仓库）。
注意：配置字段已统一为 `sandbox.env`（与 provider 无关）。

BoxLite 工作区由 `workspaceProvider` 与 `workspaceMode` 共同决定：

- `sandbox.workspaceProvider=guest`：由 VM 内 init 在 `/workspace/run-<runId>` 创建 workspace；后端会下发 `workspaceMode=clone`（guest + worktree 会被归一化为 clone）。
- `sandbox.workspaceProvider=host`：由宿主机创建 workspace，并通过 `sandbox.boxlite.volumes` 挂载到 VM 的 `/workspace`；后端下发 `workspaceMode=worktree|clone` 决定宿主机侧策略。

准备一个可运行的 ACP Agent 镜像（推荐）：

- Dockerfile：`acp-proxy/agent-images/codex-acp/Dockerfile`
- 该镜像内置 `git`，默认启动 `codex-acp`，工作目录 `/workspace`

示例（构建并推送到 registry，供 BoxLite 拉取）：

```bash
docker build -t ghcr.io/<org>/codex-acp:latest -f acp-proxy/agent-images/codex-acp/Dockerfile acp-proxy/agent-images/codex-acp
docker push ghcr.io/<org>/codex-acp:latest
```

然后可用模板快速起步（在 WSL2/Linux/macOS 环境操作）：

```bash
cp acp-proxy/config.toml.example acp-proxy/config.toml
# 编辑 config.toml：填写 sandbox.provider/sandbox.image/sandbox.env（container_oci 需要 sandbox.runtime）
```

### 5.3 启动前端

```powershell
cd frontend
pnpm dev
```

浏览器打开：`http://localhost:5173`

---

## 6. 配置 SCM（GitLab/GitHub）

系统通过 “Project” 来承载代码仓库与凭据配置（写入数据库）。

创建 Project 时还可选：

- `workspaceMode`：`worktree`（默认）或 `clone`
- `gitAuthMode`：`https_pat`（默认）或 `ssh`（仅影响 git clone/fetch/push；创建 PR/MR 等 API 仍需要 token）

> `workspaceMode=clone` 会把 Run 工作区创建在 `WORKSPACES_ROOT` 下，并按需维护 `REPO_CACHE_ROOT` mirror 缓存（两者不配则默认 `$HOME/.tuixiu/*`）。
>
> `gitAuthMode=ssh` 依赖宿主机已配置的 SSH（例如 `~/.ssh`），并建议 `repoUrl` 使用 SSH 形式（如 `git@github.com:org/repo.git`）。

### 6.1 GitLab

创建 Project 时填写：

- `scmType`: `gitlab`
- `repoUrl`: GitLab 仓库地址
- `gitlabProjectId`: 数字 project id
- `gitlabAccessToken`: Personal Access Token（需能创建 MR/推送分支）
- `gitlabWebhookSecret`: 可选（后续接 webhook 时使用）

> 注意：GitLab 侧术语是 MR，但系统抽象统一称 PR（artifact.type = `pr`）。

### 6.2 GitHub

创建 Project 时填写：

- `scmType`: `github`
- `repoUrl`: GitHub 仓库地址
- `githubAccessToken`: PAT（需能创建 PR/推送分支）

---

## 7. 一键验证

```powershell
pnpm test
pnpm test:coverage
pnpm lint
pnpm typecheck
```

---

## 8. 常见问题（Windows）

### Q1: 本地 API 请求失败/卡住

PowerShell 的 `curl` 可能是别名或受系统代理影响；推荐：

```powershell
curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/projects
```

### Q2: `spawn npx ENOENT`

请确认：

- `where.exe npx` 能找到路径
- Node/npm 安装完整
- `acp-proxy/config.toml` 的 `agent_command` 可执行

proxy 已内置 Windows `cmd.exe /c` shim 来兼容 `npx/pnpm`（见 `acp-proxy/src/sandbox/hostProcessSandbox.ts`）。

### Q3: 数据库连接失败

- 确认 `docker compose up -d` 已启动
- 检查 `backend/.env` 的 `DATABASE_URL`
- 后端启动日志会提示环境变量校验失败（见 `backend/src/config.ts`）
