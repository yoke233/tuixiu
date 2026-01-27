# PM Agent 执行计划（v1 基线 → v2）

> 更新时间：2026-01-27  
> 范围：`backend/` + `acp-proxy/` + `frontend/`  
> 目标：把 “Issue → Run → PR → Merge → Done” 尽量全自动闭环；仅高危动作需要审批；同一 Issue 串行（不并行）。

## 0. 当前实现状态（已合入 `main`）

### 已完成 ✅

- [x] **多来源接入**：GitHub（import + webhook）、GitLab webhook、消息入口 → 幂等 upsert `Issue`
- [x] **PM 分析/分配/启动**：`POST /api/pm/issues/:id/analyze`、`POST /api/pm/issues/:id/dispatch`；开启 `PM_AUTOMATION_ENABLED` 后 Issue upsert 自动启动 Run（同一 Issue 串行）
- [x] **LLM 接入**：OpenAI 兼容接口（`PM_LLM_*`）；严格 JSON schema 校验；失败回退 fallback
- [x] **GitHub Issue 自动评论**（best-effort，不阻塞主流程）：分配/开始执行等状态回写（格式化 Markdown）
- [x] **高危动作审批**（MVP）：`POST /api/runs/:id/merge-pr` 默认创建审批并返回 `APPROVAL_REQUIRED`；审批通过后执行合并；审计写入 `Run events` 并回写 GitHub 评论
- [x] **前端接入**：Issue 详情页 PM 面板（分析/分配并启动）；Admin 审批队列（批准/拒绝）；RunChangesPanel 发起合并审批与展示状态
- [x] **GitHub 合并阻塞修复**：移除 `main` 上导致 PR “无法合并/被 BLOCKED” 的规则集/保护配置
- [x] **多执行器任务系统**：`Task/Step` 引擎 + `agent/ci/human/system` executor（为后续 Policy gate、自动验收、自动 PR 提供结构化状态机）

**来源（已合入 `main`）**
- PR `#26`：PM automation v1（多来源 + 自动分析/分配/启动 + GitHub 评论 + 审批队列初版）
- PR `#27`：审批硬化（强制 merge-pr 走审批 + 审批审计/评论）
- PR `#28`：多执行器 `Task/Step` 引擎（executor/task system）

### 已知缺口 ⚠️（当前主线未完成）

- [ ] **Policy/策略系统**：目前除 `merge_pr` 外缺少统一的“可自动执行/必须审批”规则（无法按 Project/标签/风险等级做门禁）
- [ ] **auto-review 验收报告**：`POST /api/pm/runs/:id/auto-review` 未实现；Run 完成后缺少自动汇总（diff/测试/风险/建议）
- [ ] **自动推进到 PR**：Run 完成后自动 `create-pr` 未实现（目前需要人工点击）
- [ ] **CI/Webhook 闭环**：未接入 GitHub CheckRun / GitLab Pipeline 结果来驱动 `waiting_ci → completed/failed`，也无法作为自动合并 gate
- [ ] **Review 工作流**：PR 创建后进入 `reviewing` 的“通过/打回/重跑”闭环未实现
- [ ] **安全/可靠性增强**：webhook secret 强制、幂等 eventId、限流；token 加密存储与脱敏审计；覆盖率门槛与 CI 对齐（若启用 `test:coverage`）
- [ ] **worktree 生命周期**：完成/合并后自动清理/归档策略未实现
- [ ] **PM × Task/Step 对齐**：把“分析/分配/启动/验收/交付”映射到 `TaskTemplate + Step`（避免仅靠散落的 Run/Artifact 做状态推断）

## 1. 下一步执行计划（P0：先把闭环跑通）

### Task P0-1：Policy MVP（Project 级配置 + 工具门禁）

**目标**
- 让系统能按 Project 配置：哪些动作可自动执行、哪些动作必须审批、哪些目录/文件触碰即升级风险并进入审批。

**建议落地（MVP 取舍）**
- 先用 `Project.branchProtection`（JSON）承载 `pmPolicy`（避免立刻加表迁移），后续再迁移到专用表。
- 默认策略：`merge_pr` 必须审批；其余动作按风险/目录门禁决定是否自动。

**Done**
- 提供 `GET/PUT /api/policies`（按 Project）用于读写策略
- PM 自动化链路在执行工具前调用 `policy.canAuto(action, context)`，不满足则创建审批
- 前端提供一个最小配置入口（Admin 页或 Project 设置页）

**验证**
- 用一个含敏感目录变更的 Run：自动 create-pr 允许，但 auto merge 必须走审批（且审批审计/评论齐全）

---

### Task P0-2：Run 自动验收报告（`auto-review`）

**目标**
- Run 完成后自动生成可 review 的“验收报告”（`Artifact(type=report)`），并给出下一步建议（创建 PR/请求审批/需要补测等）。

**Done**
- 新增 `POST /api/pm/runs/:id/auto-review`：汇总 diff、变更文件、`pnpm test`（如有）、风险点、建议
- 在 Run status 进入 `reviewing/completed/failed` 时（或由 PM 自动化触发）写入 `report` Artifact
- GitHub 来源的 Issue：在评论里追加“验收摘要”（best-effort）

**验证**
- 运行一次 Run（含变更与测试），能在 UI 看到报告；报告包含：变更摘要/测试摘要/风险点/建议下一步

---

### Task P0-3：自动 `create-pr`（满足门禁则全自动，否则给出可执行建议）

**目标**
- Run 完成后，在满足策略门禁时自动创建 PR；失败不阻塞，降级为“提示如何手动创建/重试”。

**Done**
- 在 PM 自动化里增加 `maybeCreatePr(runId)`：受 Policy 控制
- 创建 PR 成功后：写 `Artifact(type=pr)` 并在 Issue（GitHub 来源）评论回写 PR 链接
- UI 展示“已自动创建 PR / 需要人工处理”的明确状态

**验证**
- 低风险 Issue：Run 完成后自动创建 PR；高风险/不满足门禁：不自动创建但给出明确下一步

## 2. 后续执行计划（P1/P2）

### P1：CI/Webhook 闭环 + Review 流转

- [ ] 接入 GitHub `check_run` / GitLab `pipeline` webhook：写 `Artifact(type=ci_result)` 并驱动 `Run.status=waiting_ci → completed/failed`
- [ ] 自动/半自动合并 gate：CI 全绿 + Policy 允许 → auto merge，否则进入审批
- [ ] Review 工作流：PR 创建后支持“通过/打回/重跑”，驱动 Issue 状态与 GitHub 评论回写

### P2：安全、可观测、生命周期

- [ ] Webhook：secret 强制校验（prod 模式）、幂等 eventId、限流与重放保护
- [ ] Token：Project token 加密存储/脱敏审计（避免明文）
- [ ] 指标与审计：LLM tokens/latency/成本按 Project 汇总；自动化决策可回放
- [ ] worktree 生命周期：按策略自动清理/保留/归档；减少磁盘占用

## 3. 统一约束（必须保持）

- **默认全自动**：满足门禁就自动推进；失败要降级为可执行的“手动步骤”，不阻塞主流程
- **只对高危动作审批**：例如 `merge_pr`、触碰敏感目录/鉴权/密钥/迁移/发布等
- **不并行**：同一 Issue 任意时刻最多一个运行中的 Run；返工用新 Run 串行推进

