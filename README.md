# ACP 驱动的 Agent 执行与研发协作系统（TuiXiu）

> **默认 Agent**: Codex CLI（通过 `acp-proxy` 启动 ACP Agent）  
> **SCM**: GitHub（MVP，单仓库）/ GitLab（已接 PR/MR，Issue 导入待补）  
> **定位**: 从 Issue → Run（Agent 自动改代码）→ PR 的最小闭环

---

## 一分钟看懂

这是一套把「Issue 需求」交给 **ACP 兼容 Coding Agent** 执行，并把结果沉淀为「可审查的 PR」的本地协作系统。

**典型闭环**：创建 Project（仓库 + Token）→ 导入/创建 Issue → 启动 Run（创建 `git worktree` 工作区）→ Console 实时输出 → 查看变更/diff → 一键创建/合并 PR。

**仓库组成**：`backend/`（Orchestrator）+ `acp-proxy/`（WS ↔ ACP 桥接与 Agent 启动）+ `frontend/`（Web UI）+ `docs/`（文档）+ `docker-compose.yml`（Postgres）。

## 面向真实用户：接入真实 GitHub（单仓库）

> 当前版本默认使用 **本地仓库（worktree 模式）**：后端不会自动从 GitHub clone 仓库。  
> 你要让 Agent 修改哪个 repo，就在那个 repo 的根目录启动 `backend`，并确保本地能 `git push origin <branch>`。  
> 如需“Run 自动全量 clone + 缓存 + BoxLite 沙箱”模式，见 `docs/plans/2026-01-26-run-clone-boxlite-prd.md`（规划/设计中）。

### 准备

- 工具：`git`、Node.js 20+、`pnpm`、Docker（用于 Postgres）
- 仓库：先在运行 `backend` 的机器上 **clone 一份目标 repo**，并配置好 push 权限（SSH key 或 Git Credential Manager / 账号凭据）
- Agent：默认 `npx --yes @zed-industries/codex-acp`（或替换为任意 ACP 兼容 Agent）
  - 在运行 `acp-proxy` 的环境里配置好 API Key（例如 `OPENAI_API_KEY`）
- （可选）`bash`：仅当你使用 RoleTemplate 的 `initScript`（bash）时需要（WSL2 / Git Bash 均可）

### GitHub 凭据（PAT）

- 用途：导入 GitHub Issue、创建/合并 GitHub PR（`git push` 仍依赖本地 Git 的认证配置）
- Classic PAT（简单）：公共仓库用 `public_repo`，私有仓库用 `repo`
- Fine-grained PAT（推荐）：对目标仓库授予
  - `Contents: Read & write`
  - `Pull requests: Read & write`
  - `Issues: Read-only`（仅导入）

### 首次使用流程（UI）

1. 按下方“快速启动”启动 `backend` + `acp-proxy` + `frontend`
2. 打开 `http://localhost:5173`
3. 展开页面中的 **创建 / 配置**：
   - 创建 Project：`scmType=github`，填写 `repoUrl`（建议与本地 `origin` 对应）、`defaultBranch`、`githubAccessToken`
   - （可选）导入 GitHub Issue：输入 Issue number 或 URL（例如 `123` / `https://github.com/o/r/issues/123`）
   - （可选）创建 RoleTemplate：填写 `promptTemplate` / `initScript`（bash）
4. 从 Issue 列表进入详情页：
   - 没有 Run 时点击 **启动 Run**（可选选择 Role/Agent）
   - 在 **Console** 查看输出并可继续对话
   - 展开 **变更** → 点击 **创建 GitHub PR** →（可选）**合并 GitHub PR**

### 注意事项（MVP）

- Token 会写入数据库（当前无 KMS/加密/权限体系/审计），请仅在可信环境使用，并尽量使用最小权限 PAT
- Run 会在仓库根目录生成 `.worktrees/`（git worktree）；建议不要手动改动其结构
- 当前 `worktree` 模式天然绑定“后端启动时所在的仓库目录”：一个 `backend` 实例默认只服务一个 repo；多仓库请多实例或等待 `workspaceMode=clone`（见上方 PRD）
- RoleTemplate 的 `initScript` 在 `acp-proxy` 所在机器执行，等同运行本地脚本；建议仅管理员可编辑

---

## 📚 文档导航

### 核心文档（必读）

1. **[PRD_ACP_Driven_Dev_Collab_System_v2.md](PRD_ACP_Driven_Dev_Collab_System_v2.md)**  
   产品需求文档（完整版）- 系统定位、架构、数据模型、流程设计

2. **[docs/00_POC_IMPLEMENTATION_GUIDE.md](docs/00_POC_IMPLEMENTATION_GUIDE.md)**  
   PoC 实施总览 - 里程碑、团队分工、时间表

3. **[docs/01_SYSTEM_ARCHITECTURE.md](docs/01_SYSTEM_ARCHITECTURE.md)**  
   系统架构文档 - 三层架构、组件职责、数据流、技术选型

4. **[docs/ROADMAP.md](docs/ROADMAP.md)**  
   Roadmap - 已完成/未完成清单与下一步优先级

---

### 环境搭建（第一步）

5. **[docs/02_ENVIRONMENT_SETUP.md](docs/02_ENVIRONMENT_SETUP.md)**  
   环境搭建指南 - 工具安装、数据库初始化、GitHub/GitLab 配置、项目初始化

---

## ✅ 本仓库当前可运行的 MVP

已实现并可本地跑通：
- `backend/`：Fastify + WebSocket Gateway + Prisma ORM（迁移使用 `prisma migrate` 自动生成/执行）
- `acp-proxy/`：Node/TypeScript 实现 WS ↔ ACP(JSON-RPC/stdin/stdout)，基于 `@agentclientprotocol/sdk`；默认使用 `npx --yes @zed-industries/codex-acp`
- `frontend/`：React + Vite Web UI（Project/Issue/Run/变更/PR）+ WS 实时刷新
- GitHub：Issue 导入（按 number/URL）+ PR 创建/合并（MVP 先支持 GitHub）
- RoleTemplate：`promptTemplate` + `initScript`（bash，可选；在 Run 启动前执行）
- 单元测试：后端/前端/Proxy 均已覆盖并可一键执行

### 快速启动（Windows / PowerShell）

```powershell
pnpm install
docker compose up -d

Copy-Item backend/.env.example backend/.env
cd backend
pnpm prisma:migrate
pnpm dev
```

另开一个终端启动 Proxy：

```powershell
cd acp-proxy
Copy-Item config.json.example config.json
notepad config.json
$env:OPENAI_API_KEY="..."
pnpm dev
```

编辑 `acp-proxy/config.json` 时至少确认：
- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `cwd`: 当前仓库根目录（建议填写；Run 会覆盖为 worktree 目录）
- （可选）`pathMapping`: 仅当 `acp-proxy` 跑在 WSL2 且后端传入 Windows 路径时启用 `windows_to_wsl`

> 如你要使用 RoleTemplate 的 `initScript`（bash），请确保运行 proxy 的环境里 `bash` 在 PATH 中（WSL2 / Git Bash）。

再开一个终端启动前端：

```powershell
cd frontend
pnpm dev
```

浏览器打开 `http://localhost:5173`，按页面的 **创建 / 配置** 创建 Project（`scmType=github` + `repoUrl` + `githubAccessToken`），然后创建/导入 Issue 并启动 Run。

> Windows 下如使用命令行调用后端 API，建议用 `curl.exe --noproxy 127.0.0.1 ...`，避免系统代理导致本地请求失败。

### 一键验证

```powershell
pnpm test
pnpm test:coverage
```

---

### 技术实现（核心）

5. **[docs/03_COMPONENT_IMPLEMENTATION.md](docs/03_COMPONENT_IMPLEMENTATION.md)**  
   组件实现细节 - 完整数据库 Schema、API 定义、核心算法、服务层实现

6. **[docs/04_ACP_INTEGRATION_SPEC.md](docs/04_ACP_INTEGRATION_SPEC.md)**  
   ⭐ **最关键** - ACP 协议集成规范  
   stdio 协议转换、Proxy 实现、WebSocket 桥接、错误处理

7. **[docs/05_GITLAB_INTEGRATION.md](docs/05_GITLAB_INTEGRATION.md)**  
   GitLab 集成文档 - API 调用、Webhook 配置、PR 创建、CI 状态回写

8. **[docs/06_QUICK_START_GUIDE.md](docs/06_QUICK_START_GUIDE.md)**  
   ⭐ **快速开始** - 数据库 Schema、后端代码、Proxy 实现、前端要点  
   包含完整的可运行代码片段

---

### 测试与验收

9. **[docs/07_TESTING_PLAN.md](docs/07_TESTING_PLAN.md)**  
   测试计划 - 单元测试、集成测试、E2E 测试、验收标准

---

## 🚀 快速启动路径

### 路径 1: 我是新人，从零开始

```
1. 阅读 PRD（了解系统目标）
   ↓
2. 阅读 00_POC_IMPLEMENTATION_GUIDE（了解实施计划）
   ↓
3. 阅读 01_SYSTEM_ARCHITECTURE（理解架构）
   ↓
4. 按照 02_ENVIRONMENT_SETUP 搭建环境
   ↓
5. 按照 06_QUICK_START_GUIDE 逐步实现
   ↓
6. 运行 07_TESTING_PLAN 中的测试用例
```

**预计时间**: 3-4 周（3 人团队）

---

### 路径 2: 我是技术负责人，需要评估

```
必读文档:
1. PRD（产品定位与范围）
2. 00_POC_IMPLEMENTATION_GUIDE（里程碑与资源）
3. 01_SYSTEM_ARCHITECTURE（技术选型）
4. 04_ACP_INTEGRATION_SPEC（核心技术难点）
```

**关键决策点**:

- [x] 技术栈已确定（Node.js + TypeScript）
- [ ] Agent 选型（Codex vs 其他）
- [ ] 部署方式（本地 Proxy vs 云端 Gateway）
- [ ] 团队配置（2 人 vs 3 人）

---

### 路径 3: 我是后端开发，开始写代码

```
必读文档:
1. 01_SYSTEM_ARCHITECTURE（了解整体）
2. 02_ENVIRONMENT_SETUP（准备环境）
3. 03_COMPONENT_IMPLEMENTATION（数据库 + API + 算法）⭐
4. 06_QUICK_START_GUIDE（直接看代码）
5. 05_GITLAB_INTEGRATION（GitLab API 调用）
```

**开发顺序**:

1. 数据库 Schema（30 分钟）→ 参考 03 文档
2. API 框架搭建（2 小时）→ 参考 03 文档
3. WebSocket Gateway（4 小时）→ 参考 03 文档
4. Issue 启动 Run + worktree（4 小时）→ 参考 01/03 文档
5. Run 对话/事件/变更 diff（4 小时）→ 参考 03/04/06 文档
6. PR（GitLab/GitHub）创建/合并（4 小时）→ 参考 03/05 文档

---

### 路径 4: 我是前端开发

```
必读文档:
1. 01_SYSTEM_ARCHITECTURE（了解 API）
2. 06_QUICK_START_GUIDE（前端部分）
```

**关键页面**:

- 任务列表（Table）
- 任务详情（Timeline + 产物）
- 创建任务（Form Modal）

---

### 路径 5: 我负责 ACP Proxy

```
必读文档:
1. 04_ACP_INTEGRATION_SPEC（完整读一遍）⭐⭐⭐
2. 06_QUICK_START_GUIDE（Proxy 实现代码）
```

**核心任务**:

- WebSocket 客户端
- stdio 读写
- JSON-RPC 转换
- 进程管理

---

## 📋 文档清单

| 文件 | 关键内容 | 优先级 |
| --- | --- | --- |
| `PRD_ACP_Driven_Dev_Collab_System_v2.md` | 产品定位、数据模型、流程设计 | P0 |
| `docs/00_POC_IMPLEMENTATION_GUIDE.md` | PoC 总览与范围边界（以 `docs/ROADMAP.md` 为进度准） | P0 |
| `docs/01_SYSTEM_ARCHITECTURE.md` | 真实架构与数据流（当前仓库） | P0 |
| `docs/02_ENVIRONMENT_SETUP.md` | 环境搭建（当前仓库） | P0 |
| `docs/03_COMPONENT_IMPLEMENTATION.md` | 代码导航与关键入口（当前仓库） | P0 |
| `docs/04_ACP_INTEGRATION_SPEC.md` | ACP/Session/Proxy 关键机制（当前仓库） | **P0** ⭐ |
| `docs/06_QUICK_START_GUIDE.md` | 快速跑通一次闭环（UI + API） | **P0** ⭐ |
| `docs/05_GITLAB_INTEGRATION.md` | GitLab MR（系统统一称 PR）与当前实现边界 | P1 |
| `docs/07_TESTING_PLAN.md` | 测试与验收（持续更新） | P1 |

---

## ⚡ 关键技术点速查

### 数据库关键表

```
projects (1) → issues (N) → runs (N) → events / artifacts
                              ↑
                            agents (1)

关键字段（以 Prisma schema 为准）：
- runs.acpSessionId：Run 绑定的 ACP session
- runs.workspacePath：Run worktree 路径
- runs.branchName：默认 `run/<worktreeName>`（可自定义；不填则按 Issue 自动生成）
- runs.status：pending → running → waiting_ci → completed（CI/Webhook 仍在规划中）
```

### API 端点速查

```bash
# Projects
GET    /api/projects          # Project 列表
POST   /api/projects          # 创建 Project（配置 repo/token/scmType）
PATCH  /api/projects/:id      # 更新 Project 配置

# Roles（RoleTemplate）
GET    /api/projects/:id/roles        # 角色模板列表
POST   /api/projects/:id/roles        # 创建角色模板
PATCH  /api/projects/:id/roles/:roleId # 更新角色模板

# GitHub Issues（外部导入）
GET    /api/projects/:id/github/issues        # 列外部 Issue（分页）
POST   /api/projects/:id/github/issues/import # 导入/绑定外部 Issue（幂等）

# Issues
POST   /api/issues          # 创建任务
POST   /api/issues/:id/start # 启动 Run（可选传 agentId/roleKey/worktreeName）
GET    /api/issues          # 列表
GET    /api/issues/:id      # 详情

# Runs
GET    /api/runs/:id        # Run 详情
GET    /api/runs/:id/events # 事件时间线
POST   /api/runs/:id/prompt # 继续对话
GET    /api/runs/:id/changes # 变更文件
GET    /api/runs/:id/diff   # diff（query: path=...）
POST   /api/runs/:id/create-pr # 创建 PR
POST   /api/runs/:id/merge-pr  # 合并 PR
POST   /api/runs/:id/cancel # 取消
POST   /api/runs/:id/complete # 手动完成

# Agents
GET    /api/agents          # Agent 列表
```

### ACP 协议关键

```
协议: JSON-RPC 2.0 over stdio
传输: 每行一个 JSON 对象（换行符分隔）
关键方法:
  - initialize (连接初始化)
  - session/new (创建会话)
  - session/prompt (发送任务)
  - session/update (流式更新，通知)
```

### WebSocket 消息格式

```json
// Orchestrator → Proxy
{
  "type": "execute_task",
  "run_id": "run-123",
  "prompt": "任务描述",
  "cwd": "D:\\repo\\.worktrees\\run-<worktreeName>"
}

// Proxy → Orchestrator
{
  "type": "agent_update",
  "run_id": "run-123",
  "content": { "type": "session_update", "session": "sess_xxx", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "..." } } }
}
```

### PR（GitLab/GitHub）关键

- 统一端点：`POST /api/runs/:id/create-pr`、`POST /api/runs/:id/merge-pr`
- GitLab/MR 细节：见 `docs/05_GITLAB_INTEGRATION.md`

---

## 🔧 常见问题速查

### Q: Agent 连接失败？

**检查**:

1. Orchestrator 是否运行: `curl.exe --noproxy 127.0.0.1 http://localhost:3000/api/projects`
2. WebSocket 是否可访问: `wscat -c ws://localhost:3000/ws/agent`
3. Proxy 配置中的 URL 是否正确

### Q: Codex 无输出？

**检查**:

1. 查看 `acp-proxy` 终端输出（`pnpm dev`）
2. 检查 `acp-proxy/config.json` 的 `agent_command`（Windows 下可用 `where.exe npx` 验证）
3. 确认 backend 已连接到 proxy（Agent 列表 `GET /api/agents`）

### Q: PR 未创建？

**检查**:

1. Project 的 provider token 是否有效（GitHub: `githubAccessToken`；GitLab: `gitlabAccessToken`）且具备创建/合并 PR 权限
2. 本地是否能 `git push origin <branch>`（推荐使用 SSH remote 或配置好 HTTPS 凭据）
3. Run 是否有 `branchName/workspacePath`（启动 Run 时会创建 worktree）
4. 后端日志是否有 `git push` 或 provider API 调用错误

---

## 📞 反馈与协作

**发现文档问题？**

- 在对应文档中标记 `[需澄清]`
- 在团队群中提出

**技术决策？**

- 标记为 `[待定]` 的选项需要讨论
- 记录在会议纪要中

**优先级**:

- `[P0]` - 必须完成
- `[P1]` - 后续迭代
- `[P2]` - 未来考虑

---

## 🎯 成功标准（MVP）

最小闭环至少跑通 1 次（建议累计 10 个真实任务）：

- [x] 创建 Project（配置 repo + token）
- [x] 创建 Issue（进入 pending 需求池）
- [x] 启动 Run（选择/自动分配 Agent + worktree）
- [x] RunConsole 实时输出 + 可继续对话
- [x] 查看变更与 diff
- [x] 创建 PR（GitLab MR / GitHub PR）
- [x] 合并 PR 并推进 Issue done
- [ ] CI/Webhook 闭环（待实现，见 `docs/ROADMAP.md`）

**预期时间**: 3-4 周

---

## 📦 交付物

### 代码仓库结构

```
project-root/
├── backend/           # Orchestrator
├── frontend/          # Web UI
├── acp-proxy/         # ACP Proxy
├── docs/              # 文档集
├── docker-compose.yml # Postgres（开发用）
└── pnpm-workspace.yaml
```

### 最终文档

- [x] 系统架构图（见 `docs/01_SYSTEM_ARCHITECTURE.md`）
- [ ] API 文档（可选：OpenAPI/Swagger）
- [x] 部署/启动手册（见 `docs/02_ENVIRONMENT_SETUP.md`、`docs/06_QUICK_START_GUIDE.md`）
- [ ] 用户操作手册（后续补充）
- [ ] 测试报告（后续补充）

---

**祝实施顺利！有任何问题随时沟通。** 🚀
