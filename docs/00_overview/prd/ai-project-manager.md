---
title: "PRD：AI 项目管理员（PM Agent）"
owner: "@tuixiu-maintainers"
status: "draft"
last_reviewed: "2026-01-26"
---

# PRD：AI 项目管理员（PM Agent）

> 版本：v0.2（草案）  
> 状态：Draft（已确认：全来源接入、默认全自动、部分高危审批、不并行）  
> 更新时间：2026-01-26  
> 适用范围：本仓库（`backend/` + `acp-proxy/` + `frontend/`）的 ACP 协作台能力扩展

## 1. Executive Summary

- **Problem Statement**：当前协作台已经能“Issue → Run(worktree) → ACP 执行 → PR/Merge”，但任务到来后仍需要人手动做：澄清需求、拆解、挑选角色/Agent、启动 Run、跟踪进度、把关风险与验收。这会造成高频上下文切换、遗漏与不稳定，难以规模化并行。
- **Proposed Solution**：引入一个“AI 项目管理员（PM Agent）”能力：以可审计、可回滚、可人工接管的方式，完成任务的**识别/澄清/拆解/分配/跟踪/验收/发布**全流程；系统层面提供**策略（Policy）与审批（Approval）**，让 AI 在可控边界内自动推进，最终尽量解放人工。
- **Success Criteria（KPIs）**：
  1. **人工介入时间**：平均每个 Issue 的人工操作时间减少 ≥ 60%（基线：手动分配+跟踪+PR 操作）。
  2. **自动推进率**：满足策略的 Issue 中，≥ 70% 可在“无需人工点击 start”的情况下自动启动 Run；≥ 40% 可自动创建 PR（含自测/报告）；可自动合并的 PR 占比 ≥ 20%（仅限低风险策略范围）。
  3. **质量门槛**：自动创建 PR 的 Run 中，`pnpm test` 通过率 ≥ 90%；回滚/返工（Review 打回）率 ≤ 15%。
  4. **来源接入时效**：外部来源（GitLab/GitHub/Webhook/消息入口）到 Issue 创建/更新的延迟 p95 ≤ 60 秒；幂等去重正确率 ≥ 99%。
  5. **可观测与可回放**：自动决策/工具调用 100% 写入审计（输入摘要、输出 JSON、执行结果）；LLM 调用记录 `model/latency/tokens` 并可按 Project 汇总。

## 2. User Experience & Functionality

### User Personas

- **你/技术负责人（Owner）**：希望把任务交给系统自动推进，只在关键节点确认。
- **项目管理员（PM）**：负责需求整理、分派与节奏管理（将由 PM Agent 逐步替代）。
- **执行 Agent（Developer Agent）**：通过 `acp-proxy` 驱动 ACP agent 执行代码修改、测试与提交。
- **审核者（Reviewer）**：关注风险、变更范围、测试与验收证据。

### User Stories

0. **多来源接入与同步**
   - As an Owner, I want 系统从 Web UI、GitLab/GitHub、以及消息入口自动创建/同步 Issue so that 任务来了就能进入同一条工作流。
1. **任务分析与澄清**
   - As an Owner, I want PM Agent 自动识别任务类型与缺失信息 so that 我不用每次先手动补齐上下文。
2. **拆解与计划**
   - As an Owner, I want PM Agent 给出可执行的分阶段计划/子任务/依赖 so that 我能快速判断是否靠谱。
3. **分配与启动**
   - As an Owner, I want 系统按策略选择合适的 `roleKey` 与 `agentId` 并启动 Run so that 可以稳定推进且少出错（同一 Issue 不并行）。
4. **跟踪与催办**
   - As an Owner, I want PM Agent 基于事件流判断阻塞并自动追问/重试/换人 so that 任务不中断。
5. **验收与交付**
   - As an Owner, I want PM Agent 自动收集变更、测试结果、风险点并生成“验收报告” so that 我能更快 review 决策。
6. **审批与安全**
   - As a Reviewer, I want 对高风险动作（如合并 PR、改生产配置、外部发布）有明确审批门槛 so that 自动化不越界。

### Acceptance Criteria（Done 定义）

- **全来源接入**：支持从 Web UI 创建 Issue，同时支持 GitLab/GitHub/Webhook/消息入口将任务写入/更新到 `Issue`（含 `externalProvider/externalId/externalUrl` 等映射），并具备幂等去重。
- **分析输出结构化**：对每个 Issue，PM Agent 产出结构化结论（至少包含：任务类型、风险等级、澄清问题、推荐 roleKey/agentId、初始验收清单），并在 UI 中可视化。
- **默认全自动 + 可接管**：在“自动化开启”的 Project 下，Issue 创建后可按策略自动执行（分析 → 分配 → 启动 Run →（可选）创建 PR →（可选）合并 PR/进入审批）；任意节点都允许人工暂停/接管/回滚。
- **可一键执行/可回滚**：Owner 能从建议一键触发对应动作（启动 Run/继续 prompt/创建 PR/合并 PR/请求审批），且任何自动动作都能被记录与撤销（例如停止自动化、取消 Run）。
- **策略可配置**：支持按 Project 配置自动化等级（关闭/半自动/自动），以及“高危动作需要人工审批”的规则集（可配置）。
- **可观测**：每个自动决策/工具调用都有审计记录（包含输入摘要、输出 JSON、执行结果、耗时、成本估算）。
- **失败可降级**：LLM 超时/输出不合法/执行失败时，系统回退到“提示你下一步怎么手动做”，不阻塞现有流程。
- **不并行约束**：同一 Issue 在任意时刻最多只有一个 `running` Run；自动化不会创建并行 Run（需要返工则创建新的 Run 串行推进）。

### Non-Goals（非目标）

- v1 不做完整的企业级权限系统/多租户（可先用“单用户/内网”假设，后续补）。
- v1 不做复杂的甘特图/资源排程算法（先用“按能力+负载+策略”分配）。
- v1 不追求“所有 PR 都自动合并”（仅在低风险策略范围内自动合并；高风险默认审批）。
- 不在本阶段训练/微调专用模型（先用可替换模型 + 可评估数据集）。

## 3. AI System Requirements (If Applicable)

### Tool Requirements（工具/能力清单）

PM Agent 不直接“随意执行命令”，而是只能通过受控工具集驱动系统能力（后端执行白名单 + 参数校验）：

- **读能力（默认允许）**：
  - 查询 Issue/Run/Agent 状态、事件流、变更列表与 diff
  - 读取 Project/RoleTemplate 配置
  - 生成总结/计划/验收清单/风险评估
- **写能力（需策略控制/可审批）**：
  - `start_run(issueId, agentId?, roleKey?)`
  - `prompt_run(runId, prompt, context?)`
  - `create_pr(runId)` / `merge_pr(runId)`
  - `update_issue_status(issueId, status)` / `assign_issue(issueId, agentId)`
  - `sync_external_issue(provider, payload)`（外部来源落库/更新，需幂等）
  - `request_approval(type, payload)`（例如 merge、外部发布、token 使用等）

要求：

- **结构化输出**：LLM 必须按 JSON Schema 输出（失败则重试/降级）。
- **工具白名单**：只允许后端显式注册的工具；每个工具有参数 schema、超时、重试与审计。
- **策略驱动**：工具是否可自动执行由 Policy 决定；否则进入 Approval 队列等待人确认。

### Model Requirements（模型接入）

- **自建大模型优先**：支持对接自建/私有部署模型服务，优先兼容 OpenAI API 形态（例如 `POST /v1/chat/completions`），并可通过配置切换模型与 base url。
- **分层用模**：支持“轻模型做分类/路由、重模型做计划/总结/风险评估”的组合，以降低延迟并提升稳定性。

### Evaluation Strategy（评估）

- **离线评估（必做）**：
  - 建立一个最小评测集（≥ 50 条真实/模拟 Issue）：覆盖 bugfix/小需求/重构/依赖升级/配置变更等类型。
  - 指标：分配正确率（roleKey/agent 选择）、澄清问题质量（人工评分）、计划可执行性（人工评分）、风险分级一致性（与人工对齐）。
- **在线评估（灰度）**：
  - 按 Project/标签灰度开启自动化（例如仅低风险、仅 docs/测试类变更）。
  - 指标：自动启动率、PR 通过率、返工率、平均交付时长、LLM 成本、失败率。
- **安全评估**：
  - prompt injection / 工具越权用例回归（确保模型无法绕过白名单与审批）。
  - 输出 JSON 的严格校验与拒绝策略（非 schema 输出一律不执行）。

## 4. Technical Specifications

### Architecture Overview（建议实现方式）

在现有架构上新增“PM 能力层”，核心原则：**模型只做决策与结构化输出，执行永远走后端受控工具**。

```
[Web UI] ──(REST/WS)──> [backend: Orchestrator + PM Service] ──(WS/agent)──> [acp-proxy] ──> [ACP agent]
                               │
                               ├─(DB)─ Issues / Runs / Events / Artifacts / Policies / Approvals / AuditLogs
                               └─(LLM)─ 结构化分析/规划/路由/总结
```

关键组件建议：

- **PM Service（backend）**：封装 LLM 调用、schema 校验、策略决策、工具执行与审计；LLM 通过环境变量配置自建模型服务（例如 `PM_LLM_BASE_URL/PM_LLM_MODEL/PM_LLM_TIMEOUT_MS`）。
- **Ingestion Adapters（backend）**：对接 GitLab/GitHub/Webhook/消息入口，把外部任务统一落到 `Issue`（并写入外部映射字段/标签/优先级）。
- **Policy/Approval**：
  - Policy：按 Project/标签/风险等级定义“允许自动执行的工具集合”与阈值。
  - Approval：需要人确认的动作进入队列；确认后由系统执行并记录。
- **Artifact 扩展**：用现有 `Artifact` 存“计划/验收报告/风险评估/测试摘要”等（建议新增 `report` 的结构约定）。
- **Agent Profiles**：利用现有 `Agent.capabilities` 与 `RoleTemplate` 表达不同执行者能力与提示词模板。

### Integration Points（API/数据/事件）

建议新增后端端点（示例，命名可调整）：

- `POST /api/integrations/gitlab/webhook`：接收 GitLab webhook（Issue/MR/Pipeline 等），签名校验+幂等，写入/更新 Issue/Artifact
- `POST /api/integrations/github/webhook`：接收 GitHub webhook（Issue/PR/CheckRun 等），签名校验+幂等，写入/更新 Issue/Artifact
- `POST /api/integrations/messages/inbound`：消息入口（如飞书/企微/Slack 等，具体 provider 以适配器实现为准），落库/更新 Issue，并回写“已受理/追问”消息（可选）
- `POST /api/pm/issues/:id/analyze`：生成分析与建议（结构化 JSON + 可视化）
- `POST /api/pm/issues/:id/plan`：生成分阶段计划（可含多个候选方案）
- `POST /api/pm/issues/:id/dispatch`：按策略选择 agent/role 并触发 `POST /api/issues/:id/start`
- `POST /api/pm/runs/:id/auto-review`：生成验收报告并建议是否创建/合并 PR
- `GET/POST /api/approvals`：审批队列（列表、通过、拒绝、备注）
- `GET/PUT /api/policies`：策略配置（按 Project）

与现有能力复用：

- `POST /api/issues/:id/start`：启动 Run（已支持自动选择在线/空闲 agent）
- `POST /api/runs/:id/prompt`：继续对话（已支持 `Run.acpSessionId` 复用与 context 注入）
- `POST /api/runs/:id/create-pr`、`POST /api/runs/:id/merge-pr`：交付动作
- `Event` 流：用于 PM 跟踪进度、生成摘要与触发下一步

### Security & Privacy（安全与合规）

- **最小权限与密钥治理**：
  - LLM/SCM token 不进入前端日志；后端审计只保存脱敏摘要。
  - Project 的 token 建议后续迁移到加密存储或外部 secret manager（当前为明文字段，风险见第 5 节）。
- **工具级防护**：
  - JSON schema 校验、字段白名单、URL 白名单（例如只允许当前 repo 的 PR 操作）。
  - 高风险动作必须走 Approval（默认）：`merge_pr`、创建/修改 CI/CD、数据库迁移、改权限/鉴权/密钥相关、对外发布/部署、以及任何触达生产环境的操作。
  - 非高风险动作可自动执行，但必须满足门禁：测试全绿 + 风险评分低 + 变更范围在阈值内（例如 diff 文件数/行数上限、禁止触碰敏感目录）。
- **提示词注入防护**：
  - PM 上下文只喂必要信息（Issue + 事件摘要 + diff 摘要），避免把未可信内容当作系统指令。
  - 明确区分 system/tool/user 消息；把“外部文本”标记为不可信引用。
 - **Webhook/消息入口防护**：
  - GitLab/GitHub webhook 必须校验 secret 签名（并记录 event id 做幂等）。
  - 消息入口必须验证来源（签名/白名单）并限流；禁止把消息原文当“系统指令”。

## 5. Risks & Roadmap

### Phased Rollout（分阶段方案）

- **MVP（阶段 1：全来源接入 + 自动分析/自动分配/自动启动）**
  - 接入：Web UI + GitLab/GitHub webhook + 消息入口，统一落库到 `Issue`（幂等去重）。
  - PM：Issue 创建后自动触发 `analyze/plan/dispatch`；按策略自动选择 agent/role 并调用 `/api/issues/:id/start`。
  - 交付：Run 结束自动生成 `report` Artifact（计划执行情况、测试摘要、风险点、下一步建议）。
- **v1.1（阶段 2：自动推进到 PR + 审批队列）**
  - 自动链路：启动 Run → agent 自测/提交 → 自动创建 PR。
  - Approval：对高风险动作启用审批队列（至少覆盖 `merge_pr` 与“高风险文件/目录/迁移”等）。
  - PM 跟踪：Run 失败/卡住自动追问/重试/换 Agent（仍保持同一 Issue 不并行）。
- **v2.0（阶段 3：低风险自动合并 + CI/Webhook 闭环）**
  - CI/Webhook：接入流水线结果，驱动 `waiting_ci → completed/failed`，并作为自动合并 gate。
  - 自动合并：仅在低风险策略范围内满足 gate 时自动 `merge_pr`；否则进入审批。

### Technical Risks（技术风险与应对）

- **LLM 幻觉/误分配**：用 schema 约束 + 多候选 + 置信度门槛；低置信度必须提问或走人工确认。
- **成本与延迟不可控**：缓存（Issue 摘要、diff 摘要）、短上下文策略、分层模型（轻模型做分类/路由，重模型做计划/总结）。
- **安全与越权**：工具白名单 + 策略 + 审批；对敏感字段脱敏；外部输入不可信标记。
- **并发与资源**：基于 `Agent.currentLoad/maxConcurrentRuns` 做调度；对自动化链路做幂等与重试退避。
- **现有数据模型限制**：当前 `Issue.status=running` 会阻止并行 Run；若要多 Agent 协同，需要设计 Task 模型或调整状态机。
  - 已确认：本需求不做并行（该限制可保持不变）。
