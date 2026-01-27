# PRD：多执行器任务系统（Task/Step/Execution）与步骤回滚重跑（ACP 协作台）

> 说明：本 PRD 面向当前仓库（`backend/` + `acp-proxy/` + `frontend/`）的下一阶段演进：把“一个 Issue 只能跑一个 coding Run”的模型，升级为“一个 Work Item（默认就是 Issue）下可编排多个 Step，由不同执行器（Agent/CI/人）完成，并支持打回回滚与重跑”。  
> 决策已按你确认的默认项固化：**人 + Agent 都支持**、**测试双模（workspace 快速 + CI 权威门禁，CI 不可用自动降级）**、**交付物默认落库并可一键落盘 commit**、**MVP 采用内置工作流模板（4A）但预留可配置扩展**、**支持回滚到任意 Step 并从该处继续（复用同一分支）**、**轻量登录与角色（admin/pm/reviewer/dev）**。

---

## 1. Executive Summary

- **Problem Statement**：当前系统把执行强绑定为 `Issue → Run(ACP coding)`，难以表达“PRD 生成 / 测试执行 / 代码评审 / 人工审批 / CI 门禁”等多角色协作任务；一旦被打回，缺少“回滚到某一步并重跑”的可追溯机制，导致返工成本高且过程不可审计。
- **Proposed Solution**：引入通用的 `Task / Step / Execution` 抽象与 `Executor` 执行器接口，把一次协作拆为多个步骤（内置模板），每个步骤可由 **AcpAgentExecutor / CiExecutor / HumanExecutor** 完成；所有步骤产物统一沉淀为 `Artifact(report/ci_result/patch/branch/pr)`，并提供“回滚到任意 Step → 重跑”能力（保留历史尝试）。
- **Success Criteria**（MVP，可量化）：
  - 在同一 `Issue` 下可创建并运行 ≥ 5 个 Step（PRD/实现/测试/评审/CI），每个 Step 的状态、执行日志与产物可回放（历史保留率 100%）。
  - 支持 **3 类执行器**（Agent/CI/人），且同一 Step 可切换执行器（例如“AI Review → 人工 Review 接管”）。
  - **打回重跑**：任意 Step 可被“Request changes”打回；用户可回滚到任意历史 Step 并一键重跑；回滚操作在 2s 内完成状态更新并广播到 Web UI。
  - **测试双模**：当 Project 配置 CI/Webhook 时，CI 结果驱动门禁（`waiting_ci → passed/failed`）；未配置时自动降级为 workspace 测试，并产出结构化 `ci_result`（本地模拟）。
  - **交付物**：PRD/评审/测试报告默认落库为 `Artifact(type=report)`；支持“一键落盘到仓库并 commit 到同一分支”，且系统侧不会把 token/密钥写入 Artifact/Event（脱敏覆盖率 100%）。

---

## 2. User Experience & Functionality

### 2.1 User Personas

- 平台管理员（admin）：维护系统策略、用户与权限、默认模板与审计。
- 项目成员（dev）：在 Issue 下发起协作任务、执行实现/测试、查看结果并推进到 PR/Merge。
- 产品经理（pm）：生成/维护 PRD、接受评审意见并更新需求。
- 审核人员（reviewer）：对变更进行评审并给出通过/打回结论；必要时人工接管。

### 2.2 User Stories

- **Story A（启动协作任务）**：As a 项目成员, I want to 从 Issue 选择一个“内置工作流模板”并启动任务 so that 我能把 PRD/实现/测试/评审串成一个可追踪的流程。
- **Story B（PRD 生成）**：As a PM, I want to 让 Agent 生成 PRD 并沉淀为可读的交付物 so that 研发能按同一份规格实施与验收。
- **Story C（测试执行）**：As a 开发者, I want to 一键运行测试并获得结构化结果 so that 我能在提交/提 PR 前快速发现回归，并在 CI 可用时用 CI 作为权威门禁。
- **Story D（代码评审）**：As a Reviewer, I want to 基于 diff/PR 进行评审并给出“通过/打回” so that 质量决策可审计且可驱动后续步骤。
- **Story E（步骤回滚与重跑）**：As a 开发者, I want to 在被打回后回滚到指定 Step 并从那里继续执行 so that 我能最小化返工并保留历史轨迹。
- **Story F（交付物落盘）**：As a 项目成员, I want to 把 PRD/评审/测试报告一键写入仓库并 commit so that 交付物与代码同源管理、可在 PR 中审阅。
- **Story G（轻量权限）**：As an 管理员, I want to 区分 dev/pm/reviewer/admin 的操作权限 so that 只有合适的人能审批/打回/合并与修改模板。

### 2.3 Acceptance Criteria

- **AC-A 启动协作任务**
  - UI 在 Issue 详情页提供“创建任务”入口：选择 `templateKey`（内置模板列表）→ 生成 Step 列表（只读顺序/依赖）。
  - 创建后立即生成 `Task` 与其 `Steps`（状态 `pending/ready`），并在页面展示时间线。
  - Step 支持为本次任务覆盖：`executorType`（agent/ci/human）、`roleKey`（用于 Agent）、以及测试命令/目标分支等参数（仅覆盖参数，不改变步骤拓扑）。

- **AC-B PRD 生成**
  - 支持 `prd.generate` Step：输入至少包含 `Issue.title/description/acceptanceCriteria/constraints`；输出为 `Artifact(type=report)`，`report.kind="prd"`，格式为 Markdown。
  - PRD 报告必须包含：Executive Summary、User Stories、Acceptance Criteria、Non-Goals、Technical Notes（最少字段校验）。
  - PRD Step 可由 Agent 或人执行：人执行时，UI 提供富文本/Markdown 编辑器并保存为同样的 report 产物。

- **AC-C 测试执行（双模）**
  - 支持 `test.run` Step：
    - 若 Project 配置了 CI（TBD：GitHub Actions / GitLab Pipeline）与 webhook：触发 CI 并进入 `waiting_ci`；收到 webhook 后写入 `Artifact(type=ci_result)` 并更新 Step。
    - 若未配置 CI：由 Agent 在 workspace 执行测试命令（默认从 Project/模板读取，如 `pnpm -r test`），并把结果解析为 `ci_result`（本地模拟）+ 可选 `report`（摘要）。
  - 测试结果必须结构化：包含 `passed/failed`、失败用例数量、耗时、关键日志摘录（长度上限与脱敏规则）。

- **AC-D 代码评审**
  - 支持 `code.review` Step（AI 或人）：
    - 输入支持两种来源：`Run diff`（基于 workspace）或 `PR`（基于 provider）。
    - 输出为 `Artifact(type=report)`，`report.kind="review"`，包含 `verdict=approve|changes_requested`、关键问题列表、建议修改点、风险等级。
  - 人工评审需支持在 UI 中：查看 diff/文件列表 → 填写意见 → 选择“通过/打回”。
  - “打回”会将 Task 置为 `blocked`，并提示可回滚到哪个 Step（默认回滚到 `dev.implement` 或用户选择）。

- **AC-E 步骤回滚与重跑**
  - 支持“回滚到任意 Step”：
    - 回滚会把该 Step 之后的所有 Step 状态重置为 `pending`（保留历史执行记录），并把 Task 的 `currentStep` 指向目标 Step。
    - 重跑会创建新的 `Execution`（attempt++），并与旧执行记录并存可回放。
  - 分支策略默认复用同一分支（`branchName` 不变）；如用户选择“新分支重跑”（v1.1+），则创建新分支并记录到 Artifact。

- **AC-F 交付物落盘**
  - 对任意 `report` 产物提供“发布到分支”动作：
    - 目标路径默认：`docs/tuixiu/<issueKey>/<reportKind>.md`（可配置），写入 workspace 并 commit 到同一分支。
    - 发布动作本身必须可审计（Event 记录 actor、路径、commit hash）。
  - 发布过程中不得把 token/密钥写入文件；需执行脱敏扫描（最少：`GITHUB_TOKEN/GH_TOKEN`、`OPENAI_API_KEY`、`*ACCESS_TOKEN*` 的值匹配与阻断）。

- **AC-G 轻量权限**
  - 系统提供登录（用户名 + 密码或一次性口令，具体实现 TBD），并在 API 层校验角色权限：
    - `reviewer/admin` 可执行“通过/打回”与 Merge；
    - `pm/admin` 可编辑 PRD（人类执行）与发布；
    - `dev` 可执行实现/测试、请求 review、创建 PR；
    - `admin` 可管理用户、模板、Project/RoleTemplate。
  - 所有关键动作写入 `Event(source=user, type=...)` 并包含 `actorUserId/role`。

### 2.4 Non-Goals

- MVP **不做**可视化工作流编辑器/任意 DAG 编排（仅内置模板，允许覆盖参数但不改拓扑）。
- MVP **不做**复杂 RBAC（项目级细粒度权限、审计导出、组织/团队层级）。
- MVP **不做**“自动合并策略编排”（按 label/规则自动 merge 等）。
- MVP **不做**跨仓库/多 repo 的统一 Work Item（仍以 Issue 为主；无 Issue 的临时任务放 v1.1+）。

---

## 3. AI System Requirements (If Applicable)

### 3.1 Tool Requirements

- ACP 执行通道：复用现有 `execute_task / prompt_run / cancel_task`（`acp-proxy/`）。
- Git 工具链：worktree/branch/commit/diff（复用 `backend/src/utils/gitWorkspace.ts`）。
- SCM API：
  - GitHub：PR 创建/合并（已具备）；CI/Webhook（新增：check-runs/statuses 或 workflow_run）。
  - GitLab：MR 创建/合并（已具备）；Pipeline/Webhook（新增）。
- 报告生成与脱敏：Markdown 生成、敏感信息检测（正则 + allowlist/denylist）。

### 3.2 Evaluation Strategy

- **结构化合规**：PRD/review/test report 的 JSON/Markdown 必须满足最小字段校验（schema pass rate ≥ 95%）。
- **可用性抽检**（每周抽样 N=20）：
  - PRD：验收标准可执行性（reviewer 评分 ≥ 4/5）。
  - Review：命中关键缺陷率（与人工 review 对齐度 ≥ 80%）。
  - Test：失败原因可定位性（开发者反馈“可直接行动”的比例 ≥ 80%）。
- **流程效率**：
  - 被打回后从回滚到重跑启动的 P50 ≤ 10s（不含实际执行耗时）。
  - 从创建任务到产出首个可审阅交付物（PRD 或实现 diff）的 P50 ≤ 15min（取样真实任务）。

---

## 4. Technical Specifications

### 4.1 Architecture Overview

- **核心概念**
  - `WorkItem`：工作的载体（MVP=现有 `Issue`）。
  - `Task`：在一个 WorkItem 下的一次“协作流程实例”（由模板生成 Step 列表）。
  - `Step`：Task 的一个步骤（如 `prd.generate` / `dev.implement` / `test.run` / `code.review` / `ci.gate` / `merge`）。
  - `Execution`：对某个 Step 的一次执行尝试（attempt），可能由 Agent/CI/人完成；产出 Events 与 Artifacts。
  - `Executor`：执行器接口，负责把 Step 启动/取消，并把外部信号归一成状态与产物。

- **组件交互（数据流）**
  1. 前端创建 Task（选择内置模板）→ backend 创建 Task/Steps
  2. 用户启动某 Step → backend 选择 executor 并创建 Execution
  3. `AcpAgentExecutor`：创建/复用 workspace（如需要）→ 通过 `/ws/agent` 下发 `execute_task` → 写入 Event/Artifact
  4. `HumanExecutor`：创建 `human_action_required` 事件 → UI 提供表单与“通过/打回”按钮 → 写入 report artifact
  5. `CiExecutor`：触发 CI → Step 进入 `waiting_ci` → webhook 回调写入 `ci_result` → 更新 Step/Task

- **内置模板（MVP，示例）**
  - `quick.dev.full`：`dev.implement (agent)` → `test.run (dual)` → `code.review.ai (agent)` → `code.review.human (human)` → `pr.create (system)` → `ci.gate (ci)` → `merge (human)`
  - `planning.prd.only`：`prd.generate (agent|human)` → `prd.review (human)` → `report.publish (agent|system)`
  - `quick.test.only`：`test.run (dual)` → `report.publish (optional)`

### 4.2 Integration Points

- **Backend API（建议）**
  - `POST /api/issues/:id/tasks`：基于 `templateKey` 创建 Task
  - `GET /api/tasks/:id`：获取 Task + Steps + 最新 Execution/Artifacts
  - `POST /api/steps/:id/start`：启动 Step（可覆盖 executorType/roleKey/params）
  - `POST /api/steps/:id/rollback`：回滚 Task 到目标 Step
  - `POST /api/executions/:id/cancel`：取消执行
  - `POST /api/executions/:id/submit`：HumanExecutor 提交表单/approve/changes_requested
  - `POST /api/artifacts/:id/publish`：把 report 落盘并 commit（或创建一个 publish Step）
  - `POST /api/webhooks/github` / `POST /api/webhooks/gitlab`：接收 CI 状态并更新

- **WebSocket / Events**
  - 复用现有 `/ws/client` 广播：新增事件类型（例如 `task.created`, `step.status_changed`, `execution.started`, `execution.completed`, `human.action_required`, `ci.updated`）。
  - `acp-proxy` 通道不强制新增消息类型：Agent 执行依然通过 `execute_task/prompt_run`，差异主要在 prompt 与上下文拼装。

- **DB 模型（建议，方向性）**
  - 新增：`User`（轻量登录与角色）、`Task`、`Step`、`Execution`（或在现有 `Run` 上演进为 Execution：允许 `agentId` 可空、增加 `executorType/taskId/stepId/attempt`）。
  - 复用：`Event`、`Artifact`（推荐在 `Artifact.content` 里规范 `report.kind`、`ci_result` schema）。

### 4.3 Security & Privacy

- **权限边界**
  - API 层按角色做 allowlist；关键动作必须记录 actor（用于审计与追责）。
  - HumanExecutor 的 approve/merge 必须是 `reviewer/admin`。

- **敏感信息处理**
  - Artifact/Event 落库前执行脱敏：移除/遮盖 token、cookie、Authorization header、常见密钥 env。
  - “发布到分支”前执行扫描：命中高危模式直接阻断并提示用户手动处理。

- **执行安全（脚本/命令）**
  - Agent 侧仍可能执行任意命令；MVP 先沿用现有模型（由用户环境与 ACP 许可控制）。
  - v1.1+ 建议引入 `Engine Profile`/allowlist：限制可用 agent CLI、默认 env、sandbox provider，以降低越权风险。

---

## 5. Risks & Roadmap

### 5.1 Phased Rollout

- **MVP（本 PRD 交付）**
  - 引入 `Task/Step/Execution` 与 `Executor` 抽象（至少实现：AcpAgentExecutor、HumanExecutor、CiExecutor）。
  - 内置模板（4A）：提供 2~3 个模板；允许 per-step 覆盖 roleKey/executor/参数。
  - 步骤回滚/重跑：保留历史 attempt；复用同一分支；UI 可操作。
  - 测试双模：CI 配置存在则门禁；否则 workspace 测试降级并产出结构化结果。
  - 交付物落库 + 一键落盘 commit（带脱敏扫描）。
  - 轻量登录与角色（admin/pm/reviewer/dev）+ 关键动作审计事件。

- **v1.1（增强）**
  - 工作流可配置（模板存 DB + 基础编辑器），支持条件/可选步骤与更丰富依赖。
  - “新分支重跑”与 worktree 生命周期策略（清理/保留/归档）。
  - CI 集成增强：支持多 provider、多工作流、多检查门禁聚合；失败重试与限流处理。
  - Engine Profiles：把 agent/执行参数从 proxy 配置提升为后台可管理对象（引用/继承/allowlist）。

- **v2.0（进阶）**
  - WorkItem 抽象：支持非 Issue 的临时任务（跑一次测试、做一次评审）与跨 repo。
  - 更完整的 RBAC/审计导出与合规（签名、不可抵赖日志）。
  - 执行器插件生态：支持更多 executor（容器化、远程 runner、第三方质量门禁）。

### 5.2 Technical Risks

- **状态机一致性**：Task/Step/Execution 三层状态与现有 Issue/Run 状态并存，容易出现“一个完成另一个未完成”的不一致；需要统一驱动规则与幂等更新。
- **CI/Webhook 复杂度**：不同 provider 的状态语义不同，且 webhook 丢失/延迟常见；需要重放查询与超时策略。
- **安全风险**：报告/日志中可能夹带密钥；必须落库前脱敏 + 发布前扫描，否则会把 secret 写进 repo。
- **可用性风险**：内置模板若太刚性会限制团队；但若过早做可配置工作流又会膨胀范围（因此按 4A 分期）。

