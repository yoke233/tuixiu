# ACP 驱动的 Agent 执行与研发协作系统 - 完整文档集

> **Agent**: Codex CLI  
> **SCM**: GitLab (自建)  
> **目标**: MVP 快速上线

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
   环境搭建指南 - 工具安装、数据库初始化、GitLab 配置、项目初始化

---

## ✅ 本仓库当前可运行的 MVP

已实现并可本地跑通：
- `backend/`：Fastify + WebSocket Gateway + Prisma ORM（迁移使用 `prisma migrate` 自动生成/执行）
- `acp-proxy/`：Node/TypeScript 实现 WS ↔ ACP(JSON-RPC/stdin/stdout)，基于 `@agentclientprotocol/sdk`；默认使用 `npx --yes @zed-industries/codex-acp`
- `frontend/`：React + Vite Web UI（Issue 列表/详情/创建 + WS 实时刷新）
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
pnpm dev
```

再开一个终端启动前端：

```powershell
cd frontend
pnpm dev
```

浏览器打开 `http://localhost:5173`，先创建 Project，再创建 Issue。

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

- [ ] 技术栈确认（Node.js vs Python）
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
4. GitLab 集成（4 小时）→ 参考 05 文档
5. 调度器实现（4 小时）→ 参考 03 文档

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

| 文件名                                 | 页数 | 关键内容                     | 优先级    |
| -------------------------------------- | ---- | ---------------------------- | --------- |
| PRD_ACP_Driven_Dev_Collab_System_v2.md | 40+  | 产品定位、数据模型、流程设计 | P0        |
| 00_POC_IMPLEMENTATION_GUIDE.md         | 15+  | 里程碑、团队分工、风险       | P0        |
| 01_SYSTEM_ARCHITECTURE.md              | 25+  | 架构图、组件职责、技术选型   | P0        |
| 02_ENVIRONMENT_SETUP.md                | 18+  | 工具安装、配置文件           | P0        |
| 03_COMPONENT_IMPLEMENTATION.md         | 28+  | 数据库 Schema、API、算法     | P0        |
| 04_ACP_INTEGRATION_SPEC.md             | 20+  | ACP 协议、Proxy 实现         | **P0** ⭐ |
| 05_GITLAB_INTEGRATION.md               | 15+  | GitLab API、Webhook          | P0        |
| 06_QUICK_START_GUIDE.md                | 20+  | 完整代码片段、快速启动       | **P0** ⭐ |
| 07_TESTING_PLAN.md                     | 12+  | 测试用例、验收标准           | P1        |

---

## ⚡ 关键技术点速查

### 数据库关键表

```sql
-- 核心表关系
projects (1) → issues (N) → runs (N) → events / artifacts
                              ↓
                            agents (N)

-- 关键字段
runs.status: pending → running → waiting_ci → completed
runs.acp_session_id: 绑定 ACP 会话
runs.branch_name: 格式 acp/issue-{id}/run-{short_id}
```

### API 端点速查

```bash
# Issues
POST   /api/issues          # 创建任务
GET    /api/issues          # 列表
GET    /api/issues/:id      # 详情

# Runs
GET    /api/runs/:id        # Run 详情
GET    /api/runs/:id/events # 事件时间线
POST   /api/runs/:id/cancel # 取消

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
  "session_id": "sess-abc",
  "prompt": "任务描述"
}

// Proxy → Orchestrator
{
  "type": "agent_update",
  "run_id": "run-123",
  "content": "进度更新",
  "timestamp": "..."
}
```

### GitLab API 关键

```bash
# 创建 Merge Request（GitLab）
POST /api/v4/projects/:id/merge_requests
Headers: PRIVATE-TOKEN: glpat-xxx

# 查询 Pipeline
GET /api/v4/projects/:id/pipelines/:pipeline_id
```

---

## 🔧 常见问题速查

### Q: Agent 连接失败？

**检查**:

1. Orchestrator 是否运行: `curl http://localhost:3000/api/issues`
2. WebSocket 是否可访问: `wscat -c ws://localhost:3000/ws/agent`
3. Proxy 配置中的 URL 是否正确

### Q: Codex 无输出？

**检查**:

1. 手动测试 Codex: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | codex --acp`
2. 查看 Proxy 日志: `tail -f proxy.log`
3. 检查 stderr 是否有错误

### Q: PR 未创建？

**检查**:

1. GitLab Token 是否有效
2. Proxy 是否检测到 "branch created"
3. Orchestrator 日志是否有 API 调用错误

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

运行 10 个真实任务，至少 7 个成功完成：

- [x] 创建 Issue
- [x] Agent 自动执行
- [x] 创建 PR
- [x] CI 运行
- [x] 合并后标记 Done

**预期时间**: 3-4 周

---

## 📦 交付物

### 代码仓库结构

```
project-root/
├── backend/           # Orchestrator
├── frontend/          # Web UI
├── acp-proxy/         # ACP Proxy
├── database/          # 迁移脚本
├── docker/            # Docker 配置
└── docs/              # 本文档集
```

### 最终文档

- [ ] 系统架构图（更新版）
- [ ] API 文档（Swagger）
- [ ] 部署手册
- [ ] 用户操作手册
- [ ] 测试报告

---

**祝实施顺利！有任何问题随时沟通。** 🚀
