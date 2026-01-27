# 工作流优化方案（参考 BMAD Method，BMAD-Lite for ACP 协作台）

> 更新时间：2026-01-27  
> 目标读者：本仓库贡献者/维护者（PM/Dev/Reviewer/Admin）  
> 适用范围：`backend/` + `acp-proxy/` + `frontend/`  

## 1. 背景与目标

当前系统已经具备以数据库为主的工作流抽象：`Issue → Task → Step → Run(Execution)`，并提供内置模板（4A）、多执行器（agent/ci/human/system）、回滚重跑与基础门禁（Human submit、CI waiting）。

当我们把更多的人与更多“任务类型”接入时（PRD、测试、代码评审、合并审批、发布/交付、CI 门禁等），核心挑战从“能不能跑”变成：

- 多人/多 agent 并行时如何避免“各写各的风格/架构/约定”导致冲突与返工
- 让流程可规模化：不同复杂度的任务走不同轨道，避免一刀切的重流程
- 让“打回重跑”可控：原因可见、门禁明确、重跑路径清晰
- 让交付有证据：产物/报告/门禁结果可追溯、可审计、可回放

本方案借鉴 BMAD Method 的可复用部分（不是照搬），提出一个“BMAD-Lite”优化路线：在不改变现有核心模型的前提下，补齐 **Track（轨道选择）**、**Context Pack（共享上下文）**、**Gate/DoD（门禁与完成定义）**、**Review（对抗式评审）** 四个关键能力。

## 2. 参考 BMAD 的核心启发（我们要“学什么”）

BMAD 的价值不在某个具体工具，而在一套面向多 agent/多人协作的“上下文工程 + 门禁”机制：

1. **Track Selection（轨道选择）**
   - 小变更走 Quick Flow：`quick-spec → quick-dev`
   - 大/复杂变更走 Planning：`PRD → Architecture/ADR → Epics/Stories → Gate → 实施循环`
2. **Artifact-driven Context（产物驱动上下文）**
   - 用 PRD/架构/故事文件把“决策”固定下来，后续执行只围绕这些产物做增量
3. **Gate / DoD（门禁与完成定义）**
   - 在实施前做 Implementation Readiness Gate（PASS/CONCERNS/FAIL/WAIVED）
   - 对“完成”的标准显式化（Definition of Done），减少模糊空间
4. **Adversarial Review（对抗式评审）**
   - 强制 reviewer“必须找问题”，并强调信息不对称（看产物/差异，而不是看作者推理）
5. **Context Management（棕地项目上下文）**
   - 用 `project-context.md` 固化“仓库现实情况 + 约定 + 禁区”，所有执行自动加载
   - 支持把大文档 sharding，避免上下文过大导致失真
6. **测试与 CI 的关系**
   - 本地/工作区快速反馈 + CI 权威门禁是组合，而不是二选一；并鼓励引入 burn-in 抓 flaky、选择性测试、分片并行等工程化实践

## 3. 与本项目现状的映射（我们已有的基础）

我们已经具备承接 BMAD-Lite 的“骨架”：

- **工作流数据结构**：`Task/Step/Run/Artifact`（DB 为单一真相）
- **执行器**：`agent/ci/human/system`
- **回滚重跑**：回滚到任意 step 并从该处继续（attempt 保留）
- **模板**：`backend/src/services/taskTemplates.ts`（目前 3 个模板）
- **Agent 指令结构化输出**：`REPORT_JSON`、`CI_RESULT_JSON`（在 `backend/src/executors/acpAgentExecutor.ts` 中已有约束）

因此“优化”不需要推翻重做，重点是补齐“轨道选择/上下文/门禁/评审”在系统里的落点与标准。

## 4. BMAD-Lite 优化方案（推荐落地形态）

### 4.1 Track（轨道选择）= 模板之上再抽一层

新增概念：**track**（或用模板 key 前缀表达），用于表达“任务复杂度与协作方式”。

推荐最小集合：

- `track.quick`：小改动/缺陷修复/明确范围  
  - 目标：快速实现+测试+（可选）评审+PR/CI/合并
- `track.planning`：需求不清/多人协作/跨模块/高风险  
  - 目标：先固化 PRD/架构/拆解，再进入实施循环
- `track.enterprise`（预留）：合规/审计/强门禁（可先不实现，仅预留）

落地方式（不改变数据模型也能先做）：

- 在 `Task.templateKey` 约定前缀：`quick.*`、`planning.*`
- 或新增 `Task.track` 字段（更清晰，已支持）
- PM 自动推荐 track（结合 issue 标签/目录变更/风险词），用户可覆盖
  - 已支持：PM 分析输出 `recommendedTrack`，并可在 UI 中一键应用（后续可继续增强信号与模板升级）

当前内置模板（建议优先使用带 track 前缀的新 key；legacy `template.*` 仍兼容）：

- `quick.dev.full`：实现→测试→评审→PR→CI→合并
- `planning.prd.dev.full`：PRD→实现→测试→评审→PR→CI→合并
- `planning.prd.only`：PRD 生成→评审→发布
- `quick.test.only`：测试运行→发布

### 4.2 Context Pack（共享上下文）= 解决“多人/多 agent 冲突”的根因

新增仓库级文档（推荐落在 `docs/`）：

- `docs/project-context.md`：棕地事实与约束（目录结构、命名/格式、测试命令、PR 规则、禁改目录、常见坑）
- `docs/dod.md`：DoD 清单（实现/测试/文档/安全/回滚/审计）
- `docs/adr/`（可选）：架构决策记录（ADR）

并新增一个“上下文清单”（manifest，建议 JSON/YAML，未来可放 DB）：

- `docs/context-manifest.json`（当前实现）
  - 针对 `step.kind` 声明需要加载的文档与片段
  - 例如：`dev.implement` 默认加载 `project-context.md` + 相关 ADR；`code.review` 加载 `dod.md`；`prd.generate` 加载产品约束/术语表

这样可以做到：

- 不同执行器/不同 agent 共享同一套“硬约束”
- 把分歧点提前固化为 ADR/规范，降低并行冲突概率

### 4.3 Gate（门禁）= 把“能继续吗”显式化、结构化

在现有 Step 基础上引入 Gate 类 step kind（建议逐步增加）：

- `gate.implementation_readiness`：实施前就绪检查（对齐 PRD/架构/拆解/测试策略）
- `gate.review`：评审门禁聚合（AI review + Human review + DoD）
- `gate.release`（预留）：发布/合并前门禁（审计与证据归档）

Gate 输出建议统一为结构化 Artifact：

- `Artifact.kind = "gate_decision"`  
  - `decision: "PASS" | "CONCERNS" | "FAIL" | "WAIVED"`
  - `reasons[]`、`requiredActions[]`、`evidence[]`（关联 PRD/报告/CI）

规则建议：

- Gate = FAIL → Task 自动 `blocked`（必须 rollback / correct-course 后才能继续）
- Gate = CONCERNS → 可继续，但必须记录 mitigation（审计可见）
- Gate = WAIVED → 允许越过门禁，但必须要求 human reviewer/admin 明确确认（审批）

### 4.4 DoD（完成定义）= 可审计的“done”

把“故事/步骤是否完成”的标准统一成一个 checklist（可在 UI 上勾选或由系统自动检查一部分）：

- **Code DoD（实现）**：变更最小化、无明显安全问题、关键路径覆盖
- **Test DoD（测试）**：本地/CI 至少一种通过；失败有解释与复现步骤
- **Review DoD（评审）**：高风险点已说明；changes_requested 能明确定位到 step 与修复建议
- **Docs DoD（文档）**：变更影响有记录（至少 README/ROADMAP 或 report）
- **Audit DoD（审计）**：关键动作有 actor、有证据、有产物

### 4.5 Review（对抗式）= 默认提高信噪比

建议把 AI review 默认切换为“对抗式评审”模式：

- 规则：必须给出问题清单；如果 “0 findings”，必须解释“为什么确信没问题”并列出检查项
- 评审输入：只看 `git diff`、关键文件、运行结果与产物（信息不对称）
- 评审输出：结构化 `REPORT_JSON(kind=review)` + Markdown

Human review 的价值是做最终裁决与风险兜底，因此建议：

- Human review 必须引用 DoD（最少要求：测试证据 + 风险说明）
- changes_requested 自动引导用户“回滚到哪一步/重跑哪一步”

### 4.6 测试：workspace 快速 + CI 权威（并明确降级策略）

建议把“测试双模”变成明确策略（而不是默认约定）：

- `workspace test`：用于快速反馈（agent 可直接跑 `pnpm -r test`）
- `ci gate`：用于权威结论（webhook/查询同步）
- CI 不可用/超时：
  - 允许降级：以 workspace test 产物推进，但 Gate 必须标记 `CONCERNS` 或要求 human waiver
  - 或强制阻断：必须等待 CI（由 Project policy 控制）

可选增强（P1/P2）：

- burn-in：重复执行 N 次抓 flaky（PR 上或 nightly）
- selective test：根据 diff 只跑受影响包（monorepo 优先）
- 并行分片：把 `pnpm -r test` 拆分为 backend/frontend/acp-proxy 并行

### 4.7 correct-course（与 rollback 区分）：偏“重规划”的打回

现有 rollback 是“回到某一步重跑”，但复杂协作经常需要“改计划”：

- 增加 `correct-course`（可以先表现为一种 system/human step）：
  - 输入：当前任务状态 + 打回原因 + 已产物
  - 输出：新的剩余 steps（增删改顺序）或创建子 task（拆分）

这能覆盖“需求变更、范围扩大、策略改变”这类打回原因。

### 4.8 “下一步做什么？”做成系统能力（类 bmad-help）

建议实现一个统一的“next action”建议入口（先做读接口即可）：

- 输入：`issueId|taskId`
- 输出：当前阻塞原因、缺失产物、推荐下一步（可直接触发的按钮/接口）
- 规则：根据 step 状态 + gate 结果 + policy 自动生成

这能显著提升“新加入的人/新 agent”上手速度，也能减少流程卡顿。

## 5. 推荐落地路线（不增加不必要复杂度）

### P0（最少增量，立刻收益）

- 新增 `docs/project-context.md`（手工维护即可）
- 新增 `docs/dod.md`（review 与 merge 的最低标准）
- 新增 `gate_decision` Artifact schema（不一定要改 DB，先用 JSON content 约定；见 `docs/gate_decision.schema.json`）
- AI review 改为默认对抗式 + 结构化输出更严格
- 新增 “next action” 读接口/前端提示（减少“下一步做什么”的沟通成本）

### P1（增强一致性与可规模化）

- 引入 `track` 字段或模板体系升级（quick/planning）
- 增加 `gate.implementation_readiness` 与 `correct-course`（结合 Policy/Approval）
- 引入 `context-manifest.json`（按 step.kind 自动拼上下文）
- 文档 sharding（PRD/架构过长时拆分，减少 agent 上下文漂移）

### P2（工作流可配置化与生态）

- 模板持久化（DB）+ 编辑器（UI）
- 执行器插件化（更多 CI provider、远程 runner、容器化）
- 更强的审计/合规导出（release gate 归档）

## 6. 非目标（避免“为流程而流程”）

- 不强制所有 Issue 都跑 PRD/架构（靠 track 选择）
- 不把 DB 状态迁回文件（例如 `sprint-status.yaml`）；文件仅作为可选导出/归档产物
- 不在短期内引入完整企业级 RBAC/多租户（先用现有 Policy/Approval 演进）

## 7. 参考

- BMAD Method（官方文档）：`https://docs.bmad-method.org/`（workflow map、adversarial review、sharding、TEA CI 等章节）

