# PoC 实施指南总览

## 文档导航

本文档集提供了从零搭建 ACP 驱动的研发协作系统 MVP 的完整指南。

### 文档列表

1. **00_POC_IMPLEMENTATION_GUIDE.md**（本文档）
   - PoC 目标与范围
   - 整体实施路线图
   - 团队分工建议
   - 里程碑定义

2. **01_SYSTEM_ARCHITECTURE.md**
   - 系统架构图
   - 组件职责说明
   - 数据流图
   - 技术栈选型

3. **02_ENVIRONMENT_SETUP.md**
   - 开发环境准备
   - 依赖项安装
   - GitLab 配置
   - Codex Agent 准备

4. **03_COMPONENT_IMPLEMENTATION.md**
   - 各组件实现要点
   - 接口定义
   - 数据库 Schema
   - 关键算法说明

5. **04_ACP_INTEGRATION_SPEC.md**
   - ACP 协议详解
   - Proxy 实现要点
   - 协议转换规则
   - 错误处理策略

6. **05_GITLAB_INTEGRATION.md**
   - GitLab API 使用
   - Webhook 配置
   - PR 操作流程
   - CI 集成方案

7. **06_QUICK_START_GUIDE.md**
   - 数据库 Schema（可直接执行）
   - 后端/Proxy/前端核心代码
   - 端到端测试流程
   - 常见问题排查

8. **07_TESTING_PLAN.md**
   - 测试策略
   - 测试用例
   - 验收标准
   - 已知限制

---

## PoC 目标

### 核心目标

**能够完成一个完整的任务执行闭环**：

```
创建 Issue（Web 界面）
   ↓
系统分配给 Codex Agent（自动）
   ↓
Agent 执行任务（本地通过 ACP Proxy）
   ↓
产出 PR（GitLab Merge Request）
   ↓
CI 检查通过（GitLab CI）
   ↓
人工审批合并（GitLab 界面）
   ↓
任务标记完成（Web 界面）
```

### PoC 范围（P0-Minimal）

#### ✅ 包含的功能

1. **Web UI（基础版）**
   - 任务列表页（看板风格，简化为单列）
   - 任务创建表单（Issue 基本信息）
   - 任务详情页（状态、日志、时间线）
   - Agent 状态监控页（在线/离线、当前任务）

2. **后端 Orchestrator**
   - RESTful API（Issue CRUD、Run 管理）
   - WebSocket 接口（Agent 连接、实时日志推送）
   - 任务调度逻辑（Issue → Run → Agent）
   - 状态管理（Run 状态机）
   - 事件时间线（基础版，存储 ACP 消息）

3. **ACP Proxy（本地部署）**
   - WebSocket 客户端（连接 Orchestrator）
   - Agent 进程管理（启动 Codex CLI）
   - 协议转换（WebSocket ↔ stdio）
   - 心跳保活

4. **GitLab 集成**
   - 创建 PR（通过 GitLab API）
   - 监听 Webhook（PR 状态变更、CI 结果）
   - 读取 CI 状态

5. **数据库**
   - PostgreSQL
   - 核心表：projects, issues, runs, agents, events, artifacts

#### ❌ 不包含的功能（留待后续迭代）

- ❌ Review 评论聚合与返工闭环
- ❌ 自动失败诊断与重试
- ❌ 复杂的权限控制（PoC 只有管理员角色）
- ❌ 云端 Agent（只支持本地 Proxy）
- ❌ 多项目并行（PoC 单项目）
- ❌ 完善的监控告警

---

## 实施路线图

### 阶段 0: 准备工作（1-2 天）

**目标**: 环境就绪、工具准备完毕

**任务清单**:

- [ ] 搭建开发环境（Node.js / Golang / PostgreSQL）
- [ ] 配置 GitLab 项目与 Personal Access Token
- [ ] 安装并验证 Codex CLI 可用（`codex --version`）
- [ ] 准备测试仓库（在 GitLab 上创建一个示例项目）
- [ ] 阅读 ACP 协议文档（https://agentclientprotocol.com）

**交付物**:

- [ ] 开发环境配置清单（文档）
- [ ] GitLab 测试项目 URL
- [ ] Codex CLI 运行截图

---

### 阶段 1: 核心数据模型与 API（3-4 天）

**目标**: 后端 Orchestrator 基础框架搭建完成

**任务清单**:

- [ ] 设计数据库 Schema（见 03_COMPONENT_IMPLEMENTATION.md）
- [ ] 实现 Issue CRUD API
  - `POST /api/issues` - 创建任务
  - `GET /api/issues` - 列表
  - `GET /api/issues/:id` - 详情
  - `PATCH /api/issues/:id` - 更新状态
- [ ] 实现 Run 管理 API
  - `POST /api/runs` - 创建执行实例
  - `GET /api/runs/:id` - 查询状态
- [ ] 实现 Agent 注册 API
  - `POST /api/agents/register` - Agent 注册
  - `POST /api/agents/:id/heartbeat` - 心跳
- [ ] 实现 WebSocket 接口
  - 连接认证
  - 消息路由（Agent ID → WebSocket 连接映射）

**技术栈建议**:

- Node.js + Express / Fastify（或 Python + FastAPI）
- PostgreSQL + Sequelize/TypeORM（或 SQLAlchemy）
- ws / socket.io（WebSocket 库）

**验收标准**:

- [ ] 可以通过 API 创建 Issue
- [ ] 可以通过 WebSocket 连接并发送消息
- [ ] 数据持久化到 PostgreSQL

---

### 阶段 2: ACP Proxy 实现（3-4 天）

**目标**: 本地 Proxy 可以连接 Orchestrator 并启动 Codex

**任务清单**:

- [ ] 实现 WebSocket 客户端（连接到 Orchestrator）
- [ ] 实现 Agent 进程管理
  - 启动 Codex CLI 子进程（`codex --acp`）
  - 监听 stdout/stderr
  - 写入 stdin
- [ ] 实现协议转换逻辑
  - WebSocket 消息 → JSON-RPC（写入 Codex stdin）
  - JSON-RPC（从 Codex stdout 读取）→ WebSocket 消息
- [ ] 实现心跳机制（每 30 秒发送一次）
- [ ] 实现配置文件解析（`config.json`）
- [ ] 实现日志记录（本地日志文件）

**技术栈建议**:

- Golang 1.21+（推荐，单二进制部署，跨平台编译）
- 依赖：gorilla/websocket

**技术优势**:

- ✅ 无依赖部署（单个可执行文件）
- ✅ 跨平台编译（一次编译，多平台运行）
- ✅ 性能优异（内存占用 ~10MB）
- ✅ 并发友好（goroutine 天然适合双向转发）

**验收标准**:

- [ ] Proxy 启动后自动连接到 Orchestrator
- [ ] 收到任务时可以启动 Codex 子进程
- [ ] Codex 的输出可以实时转发到 Orchestrator

---

### 阶段 3: 任务调度与执行流程（2-3 天）

**目标**: 打通"创建 Issue → 分配 Agent → 执行"流程

**任务清单**:

- [ ] 实现任务调度器
  - Issue 创建后自动创建 Run
  - 选择可用的 Agent（简单策略：选第一个在线的）
  - 通过 WebSocket 发送任务给 Proxy
- [ ] 实现 Run 状态机
  - 定义状态：pending → running → completed / failed
  - 状态转换逻辑
- [ ] 实现事件时间线
  - 监听 WebSocket 消息
  - 存储为 Event 记录
  - 提供查询 API：`GET /api/runs/:id/events`
- [ ] 实现 ACP session/prompt 发送
  - 构造符合 ACP 规范的 JSON-RPC 请求
  - 包含 Issue 描述、验收标准

**验收标准**:

- [ ] 创建 Issue 后，Agent 自动收到任务
- [ ] Codex 开始执行（可以在 Proxy 日志中看到）
- [ ] Orchestrator 可以查询到 Run 的实时状态

---

### 阶段 4: GitLab 集成（2-3 天）

**目标**: Agent 可以创建 PR，系统可以接收 PR 状态

**任务清单**:

- [ ] 封装 GitLab API 客户端
  - 创建 PR（GitLab Merge Request）：`POST /projects/:id/merge_requests`
  - 查询 PR（GitLab Merge Request）：`GET /projects/:id/merge_requests/:mr_id`
  - 查询 CI 状态：`GET /projects/:id/pipelines/:pipeline_id`
- [ ] 实现 Webhook 接收器
  - 路由：`POST /webhooks/gitlab`
  - 验证签名（GitLab Secret Token）
  - 解析事件类型：PR created / updated / merged
  - 解析 CI 事件：pipeline success / failed
- [ ] 实现 PR 创建逻辑
  - 监听 Codex 输出（识别"已创建分支"的消息）
  - 调用 GitLab API 创建 PR
  - 记录 Artifact（type: 'pr'）
- [ ] 实现 CI 状态回写
  - 收到 Webhook 后更新 Run 状态
  - 创建 Event（type: 'ci.check.passed' / 'ci.check.failed'）

**GitLab 配置**:

- 创建 Personal Access Token（scope: api, write_repository）
- 配置 Webhook（URL: `https://your-domain.com/webhooks/gitlab`）
- 设置 Secret Token

**验收标准**:

- [ ] Codex 完成后，GitLab 上出现新的 PR
- [ ] PR 触发 CI，结果回写到系统
- [ ] 可以在任务详情页看到 PR 链接和 CI 状态

---

### 阶段 5: Web UI 实现（3-4 天）

**目标**: 用户可以通过界面完成整个流程

**任务清单**:

- [ ] 实现任务列表页
  - 显示所有 Issue（状态、标题、分配的 Agent）
  - 创建按钮 → 表单页
  - 点击任务 → 详情页
- [ ] 实现任务创建表单
  - 字段：标题、描述、验收标准（多行）、约束、测试要求
  - 提交后调用 API 创建 Issue
- [ ] 实现任务详情页
  - 顶部：状态、标题、描述、验收标准
  - 中部：时间线（事件流，实时更新）
  - 底部：产物（PR 链接、分支名称）
  - 右侧：Agent 信息、操作按钮（取消、重试）
- [ ] 实现 Agent 监控页
  - 列表显示所有 Agent
  - 状态：在线/离线
  - 当前任务（如果有）
- [ ] 实现 WebSocket 客户端（前端）
  - 连接到 Orchestrator
  - 订阅 Run 更新
  - 实时刷新时间线

**技术栈建议**:

- React + TypeScript（或 Vue / Svelte）
- Ant Design / Material-UI（组件库）
- Socket.io-client（WebSocket）
- Axios（HTTP 请求）

**验收标准**:

- [ ] 可以在界面上创建任务
- [ ] 可以实时看到执行进度（时间线滚动）
- [ ] 可以看到 PR 链接并点击跳转到 GitLab

---

### 阶段 6: 集成测试与调优（2-3 天）

**目标**: 端到端流程稳定运行

**任务清单**:

- [ ] 编写端到端测试用例（见 07_TESTING_PLAN.md）
- [ ] 执行冒烟测试
  - 创建简单任务："修复 README.md 的拼写错误"
  - 验证 Codex 可以完成
  - 验证 PR 创建成功
  - 验证 CI 通过
  - 手动合并 PR
  - 验证任务标记为 Done
- [ ] 修复发现的 Bug
- [ ] 性能测试
  - 单 Agent 处理 5 个任务（串行）
  - 2 个 Agent 并发处理 4 个任务
  - 记录响应时间、错误率
- [ ] 优化日志输出（结构化日志）
- [ ] 编写操作手册（README）

**验收标准**:

- [ ] 端到端成功率 ≥ 80%
- [ ] 单任务完成时间 < 5 分钟（简单任务）
- [ ] 无明显内存泄漏（运行 1 小时）

---

## 团队分工建议

### 配置 1: 3 人团队（推荐最小配置）

| 角色            | 职责                              | 关键产出     |
| --------------- | --------------------------------- | ------------ |
| **后端工程师**  | Orchestrator + API + 数据库       | 阶段 1, 3, 4 |
| **全栈工程师**  | ACP Proxy + Web UI                | 阶段 2, 5    |
| **DevOps/测试** | 环境搭建 + GitLab 配置 + 集成测试 | 阶段 0, 6    |

### 配置 2: 2 人团队（精简）

| 角色         | 职责                                   | 关键产出           |
| ------------ | -------------------------------------- | ------------------ |
| **后端主导** | Orchestrator + ACP Proxy + GitLab 集成 | 阶段 0, 1, 2, 3, 4 |
| **前端主导** | Web UI + 集成测试                      | 阶段 5, 6          |

> 注：2 人配置需要 4-5 周完成，3 人配置 3-4 周。

---

## 里程碑定义

### Milestone 1: Hello World（Week 1）

**定义**: 可以通过 API 创建 Issue，Proxy 可以连接

**验收**:

```bash
# 1. 创建 Issue
curl -X POST http://localhost:3000/api/issues \
  -H "Content-Type: application/json" \
  -d '{"title": "Test task", "description": "..."}'

# 2. Proxy 连接成功
tail -f proxy.log
# 应该看到: "Connected to Orchestrator"
```

### Milestone 2: Agent Execution（Week 2）

**定义**: Codex 可以接收任务并执行

**验收**:

```bash
# 1. 创建 Issue 后，查看 Proxy 日志
tail -f proxy.log
# 应该看到:
#   "Received task: sess-xxx"
#   "Starting Codex process"
#   "Codex output: ..."

# 2. 查询 Run 状态
curl http://localhost:3000/api/runs/{run_id}
# 应该返回: {"status": "running", ...}
```

### Milestone 3: PR Created（Week 2-3）

**定义**: Codex 完成后，GitLab 上出现 PR

**验收**:

- 在 GitLab 项目的 Merge Requests 页面可以看到新的 PR
- PR 描述包含 Issue 信息
- PR 关联了正确的分支

### Milestone 4: End-to-End（Week 3）

**定义**: 完整流程可以运行

**验收**:

- 从 Web UI 创建任务
- Agent 自动执行
- 创建 PR
- CI 运行并通过
- 手动合并后任务标记 Done

### Milestone 5: MVP Release（Week 3-4）

**定义**: 可以交付给内部用户试用

**验收**:

- [ ] 通过所有测试用例（见 07_TESTING_PLAN.md）
- [ ] 有完整的部署文档
- [ ] 有用户操作手册
- [ ] 至少完成过 10 个真实任务

---

## 技术栈建议

### 后端 Orchestrator

**方案 A: Node.js**

- 框架: Express / Fastify
- ORM: TypeORM / Prisma
- WebSocket: ws / socket.io
- 优点: 异步 I/O 性能好，社区丰富
- 适合: 熟悉 JavaScript/TypeScript 的团队

**方案 B: Python**

- 框架: FastAPI / Flask
- ORM: SQLAlchemy
- WebSocket: websockets / socket.io
- 优点: 开发速度快，AI 生态丰富
- 适合: 熟悉 Python 的团队

### ACP Proxy

**方案 A: Golang（强烈推荐）** ⭐⭐⭐⭐⭐

- 子进程管理: os/exec（标准库）
- WebSocket: gorilla/websocket
- 并发: goroutine
- **优点**:
  - ✅ 单二进制文件部署（无依赖）
  - ✅ 跨平台编译（Windows/macOS/Linux）
  - ✅ 内存占用小（~10MB vs Python ~50MB）
  - ✅ 启动速度快（毫秒级）
  - ✅ 非技术用户友好（双击运行）
- **推荐理由**: 最适合分发到客户端的方案

**方案 B: Python**

- 子进程管理: subprocess（标准库）
- WebSocket: websockets
- 优点: 开发速度快，调试方便
- 缺点: 需要用户安装 Python 环境
- 适合: 仅内部使用场景

### 前端 Web UI

**推荐**: React + TypeScript + Ant Design

- 理由: 组件丰富、文档完善、易于上手

**备选**: Vue 3 + Element Plus（如果团队更熟悉）

### 数据库

**推荐**: PostgreSQL 14+

- 理由: 成熟稳定、支持 JSON 字段（存储事件 payload）

### 部署

**开发环境**: Docker Compose（一键启动所有服务）
**生产环境**: Kubernetes（可选，PoC 可以用单机 Docker）

---

## 风险与应对

### 风险 1: Codex CLI 不稳定

**表现**: 经常崩溃、卡死、返回错误

**应对**:

- 设置超时机制（15 分钟无输出则 kill）
- 实现自动重试（最多 2 次）
- 记录详细的错误日志
- 准备降级方案（手动创建 PR）

### 风险 2: 网络连接不稳定

**表现**: Proxy 与 Orchestrator 连接断开

**应对**:

- 实现指数退避重连（5s, 10s, 20s, ...）
- Session 恢复机制（重连后继续之前的任务）
- 心跳超时时间设置合理（60 秒）

### 风险 3: GitLab Webhook 不触发

**表现**: PR 创建了，但系统没收到事件

**应对**:

- 验证 Webhook 配置（URL、Secret Token）
- 检查防火墙（确保 GitLab 可以访问 Orchestrator）
- 实现主动轮询（备选方案，每 30 秒查询一次）

### 风险 4: 数据库性能瓶颈

**表现**: Event 表记录数过多（每个任务 100+ 条）

**应对**:

- 添加索引（run_id, timestamp）
- 定期归档历史数据（> 30 天的 Run）
- 考虑时序数据库（InfluxDB）用于存储 Event（未来优化）

---

## 成功标准

PoC 被认为成功，需满足以下条件：

### 功能性指标

- [ ] 可以创建至少 3 种不同类型的任务（前端、后端、文档）
- [ ] Agent 执行成功率 ≥ 70%（10 个任务中至少 7 个成功）
- [ ] PR 创建成功率 = 100%（只要 Agent 说"完成"，必须有 PR）
- [ ] CI 集成正常（所有 PR 都触发 CI）

### 性能指标

- [ ] 任务响应时间 < 10 秒（从创建到 Agent 开始执行）
- [ ] 简单任务完成时间 < 5 分钟（如修复拼写错误）
- [ ] 中等任务完成时间 < 30 分钟（如实现一个简单功能）
- [ ] 系统稳定运行 > 4 小时（不崩溃、不内存泄漏）

### 可用性指标

- [ ] 有完整的用户操作手册（5 页以内）
- [ ] 有故障排查指南（常见问题 FAQ）
- [ ] 新用户可以在 30 分钟内完成第一个任务（含学习时间）

---

## 交付物清单

### 代码仓库

```
project-root/
├── backend/               # Orchestrator 后端
├── frontend/              # Web UI 前端
├── acp-proxy/             # ACP Proxy
├── database/              # 数据库迁移脚本
├── docker/                # Docker 配置
└── docs/                  # 本文档集
```

### 文档

- [ ] 系统架构文档
- [ ] API 接口文档（Swagger / OpenAPI）
- [ ] 部署文档
- [ ] 用户操作手册
- [ ] 开发者指南
- [ ] 测试报告

### 配置文件

- [ ] `.env.example` - 环境变量模板
- [ ] `docker-compose.yml` - Docker 编排
- [ ] `acp-proxy/config.json.example` - Proxy 配置模板
- [ ] `gitlab-webhook.json` - Webhook 配置说明

---

## 下一步

**立即行动**:

1. ✅ **阅读本文档集**（你正在做）
2. ⏭️ **阅读 01_SYSTEM_ARCHITECTURE.md**（理解整体架构）
3. ⏭️ **阅读 02_ENVIRONMENT_SETUP.md**（准备环境）
4. ⏭️ **启动阶段 0**（环境搭建）

**每日站会建议**:

- 每天 15 分钟
- 同步进度、阻塞点
- 根据实际情况调整计划

**周报内容**:

- 本周完成的里程碑
- 遇到的主要问题
- 下周计划
- 风险预警

---

## 联系与支持

**问题反馈**: 在文档中标记 `[需澄清]` 的地方需要进一步讨论

**技术决策**: 标记为 `[待定]` 的选项需要团队决策

**优先级**: 标记为 `[P0]` 的任务必须完成，`[P1]` 可以后续迭代

---

祝实施顺利！🚀
