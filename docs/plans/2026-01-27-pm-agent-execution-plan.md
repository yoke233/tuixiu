# PM Agent 执行计划（v1 基线 → v2）

> 更新时间：2026-01-27  
> 范围：`backend/` + `acp-proxy/` + `frontend/`  
> 目标：把 “Issue → Run → PR → Merge → Done” 尽量全自动闭环；仅高危动作需要审批；同一 Issue 串行（不并行）。

## 0. 当前实现状态（已合入 `main`）

### 已完成 ✅

- [x] **多来源接入**：GitHub（import + webhook）、GitLab webhook、消息入口 → 幂等 upsert `Issue`
- [x] **PM 分析/分配/启动**：`POST /api/pm/issues/:id/analyze`、`POST /api/pm/issues/:id/dispatch`；开启 `PM_AUTOMATION_ENABLED` 后 Issue upsert 自动启动 Run（同一 Issue 串行）
- [x] **LLM 接入**：OpenAI 兼容接口（`PM_LLM_*`）；严格 JSON schema 校验；失败回退 fallback
- [x] **GitHub Issue 自动评论**（best-effort，不阻塞主流程）：分配/开始执行/创建 PR 等状态回写（格式化 Markdown）
- [x] **高危动作审批**（MVP）：`POST /api/runs/:id/merge-pr` 默认创建审批并返回 `APPROVAL_REQUIRED`；审批通过后执行合并；审计写入 `Run events` 并回写 GitHub 评论
- [x] **前端接入**：Issue 详情页 PM 面板（分析/分配并启动）；Admin 审批队列（批准/拒绝）；RunChangesPanel 发起合并审批与展示状态
- [x] **GitHub 合并阻塞修复**：移除 `main` 上导致 PR “无法合并/被 BLOCKED” 的规则集/保护配置
- [x] **多执行器任务系统**：`Task/Step` 引擎 + `agent/ci/human/system` executor（为后续 Policy gate、自动验收、自动 PR 提供结构化状态机）
- [x] **Task 级 Review/打回/推进**：Human Step 支持 `approve/changes_requested`；changes_requested 会把 Task 置为 `blocked`，可回滚并继续（保留历史 attempt）
- [x] **交付物发布**：支持把 `report/ci_result` 发布到 workspace 并提交 commit（带脱敏与敏感信息拦截）
- [x] **轻量登录与角色（JWT）**：新增 `/api/auth/bootstrap|login|me`；默认对非 GET API 做登录校验，关键配置（Project/Role）限制 admin
- [x] **GitHub CI 结果回写（基础）**：GitHub webhook 兼容 `workflow_run/check_suite/check_run`，可驱动 `waiting_ci` Run 结束并写入 `ci_result`
- [x] **Policy MVP（Project 级）**：`GET/PUT /api/policies?projectId=...`（存储于 `Project.branchProtection.pmPolicy`）；Admin 页提供 JSON 配置入口；PM 自动化会尊重 `automation.autoStartIssue`
- [x] **Policy/审批扩展（动作级 gate）**：支持 `create_pr` / `publish_artifact` 动作级审批门禁；命中 `sensitivePaths` 时自动升级进入审批（Task 流 system step 会停在 `waiting_human`）
- [x] **Run 自动验收（auto-review）**：`POST /api/pm/runs/:id/auto-review` 生成 `report(kind=auto_review)`；Run 变更面板提供“一键自动验收”按钮
- [x] **Run 自动推进（非 Task 流）**：Run 完成自动生成 auto-review；检测到变更时自动 `create-pr`；GitHub CI 通过后自动发起 `merge_pr` 审批（仍需人工批准/执行合并）；受 `PM_AUTOMATION_ENABLED` 与 `pmPolicy.automation.*` 控制
- [x] **Task 自动推进（Task 流）**：Task 创建/回滚后自动启动首个 `ready` 且非 `human` 的 Step；Run/CI 完成后自动启动下一个 `ready` 且非 `human` 的 Step；遇到 `human` Step 自动停（`pr.create` 受 `pmPolicy.automation.autoCreatePr` 门禁）
- [x] **BMAD-Lite P0**：Context Pack（docs + 注入）、next-action 读接口+前端提示、对抗式 `code.review`、`gate_decision` schema

**来源（已合入 `main`）**
- PR `#26`：PM automation v1（多来源 + 自动分析/分配/启动 + GitHub 评论 + 审批队列初版）
- PR `#27`：审批硬化（强制 merge-pr 走审批 + 审批审计/评论）
- PR `#28`：多执行器 `Task/Step` 引擎（含 JWT 登录、交付物发布、GitHub CI 基础回写）
- PR `#29`：Roadmap/Task 状态更新（docs）
- PR `#30`：PM Agent 执行计划与 Roadmap 补齐（docs）
- PR `#34`：Policy MVP（后端策略 API + Admin 配置入口 + PM autoStart gate）
- PR `#35`：auto-review（后端端点 + 前端一键触发）
- PR `#41`：Run 自动推进（auto-review 自动触发 + 自动 create-pr + CI 通过自动发起 merge 审批）
- PR `#45`：Task 自动推进（Task/Step ready 自动启动非 human executor）
- PR `#46`：GitHub Issue 回写增强（创建 PR 与 auto-review 摘要 best-effort 评论）
- PR `#50`：动作级 gate（`create_pr`/`publish_artifact`）+ `sensitivePaths` 命中升级审批（Task system step 等待 `waiting_human`）
- PR `#58`：BMAD-Lite P0（Context Pack + next-action + 对抗式 review + gate_decision schema）

### 已知缺口 ⚠️（当前主线未完成）

- [ ] **Gate/DoD 聚合（预备）**：已具备 `gate_decision` schema，但仍缺 gate step（`implementation_readiness/review/release`）聚合能力与可视化
- [ ] **Track（轨道选择）**：缺少显式 `track` 字段/模板体系（quick/planning/enterprise）；目前只能通过 `templateKey`/人工约定实现
- [ ] **Policy/策略系统（扩展）**：已支持 Project policy 存取与 PM autoStart gate；已完成 `create_pr`/`publish_artifact` 动作级 gate 与敏感目录升级；仍缺更多动作（`ci/test/merge auto-exec` 等）的门禁聚合与策略化
- [ ] **auto-review（回写增强）**：已支持手动触发与自动触发（含 GitHub Issue best-effort 摘要回写）；仍缺测试结果聚合增强（例如更完整的测试摘要、diff 摘要压缩与证据链接）
- [ ] **自动推进到 PR（Task 流）门禁完善**：已支持 Task 的 `ready` Step 自动推进；已为 `pr.create`/`report.publish` 接入 gate + `sensitivePaths` 升级；仍缺对更多 Step(kind)（test/ci 等）的动作级门禁与策略聚合
- [ ] **CI/Webhook 闭环（增强）**：GitHub 已基础接入；仍缺 GitLab pipeline 回写、CI Run 关联增强（`head_sha/PR`）、CI 不可用时的 workspace test 降级策略
- [ ] **Review Gate 聚合**：Task 级打回/回滚已具备，但缺少 “AI review / 人 review / 合并审批” 的统一门禁聚合与可视化
- [ ] **安全/可靠性增强**：webhook secret 强制、幂等 eventId、限流；token 加密存储与脱敏审计；覆盖率门槛与 CI 对齐（若启用 `test:coverage`）
- [ ] **worktree 生命周期**：完成/合并后自动清理/归档策略未实现
- [ ] **PM × Task/Step 对齐**：把“分析/分配/启动/验收/交付”映射到 `TaskTemplate + Step`（避免仅靠散落的 Run/Artifact 做状态推断）

## 1. 里程碑（BMAD-Lite P0 已完成）

> 对齐文档：`docs/09_WORKFLOW_OPTIMIZATION_BMAD_LITE.md`（P0/P1/P2 路线图与定义）。

- [x] Context Pack 文档：`docs/project-context.md`、`docs/dod.md`
- [x] Context Pack 注入：Task 流 agent prompt 按 `step.kind` 自动加载 docs（含限长/截断）
- [x] Next Action：`GET /api/pm/issues/:id/next-action` + Issue 详情页 PM 面板提示
- [x] 对抗式 Review：`code.review` 默认更严格，且上下文引用 DoD
- [x] Gate schema：`docs/gate_decision.schema.json`（后端提供 Zod schema，供后续 gate step 聚合复用）

## 2. 后续执行计划（P1/P2）

### P1：CI/Webhook 闭环 + Review 流转

- [ ] 引入 `track`（quick/planning/enterprise）字段或模板升级（先预留，后续做推荐与 UI）
- [ ] 引入 `docs/context-manifest.yaml`（按 `step.kind` 自动注入上下文；支持片段/截断策略）
- [ ] 增加 `gate.implementation_readiness` 与 `correct-course`（重规划）并与 Policy/Approval 对齐
- [ ] 接入 GitLab `pipeline` webhook：写 `Artifact(type=ci_result)` 并驱动 `Run.status=waiting_ci → completed/failed`（同时增强 CI 关联：`head_sha/PR` 等）
- [ ] 自动/半自动合并 gate：CI 全绿 + Policy 允许 → auto merge，否则进入审批
- [ ] Review Gate 聚合：把 “AI review / 人 review / 合并审批” 做统一门禁与状态机（对 Task/Run/PR 一致）

### P2：安全、可观测、生命周期

- [ ] 模板持久化（DB）+ 编辑器（UI）：可配置 TaskTemplate/Step，支持企业级流程扩展
- [ ] 执行器插件化：更多 CI provider、远程 runner、容器化（减少本机依赖）
- [ ] Webhook：secret 强制校验（prod 模式）、幂等 eventId、限流与重放保护
- [ ] Token：Project token 加密存储/脱敏审计（避免明文）
- [ ] 指标与审计：LLM tokens/latency/成本按 Project 汇总；自动化决策可回放
- [ ] worktree 生命周期：按策略自动清理/保留/归档；减少磁盘占用

## 3. 统一约束（必须保持）

- **默认全自动**：满足门禁就自动推进；失败要降级为可执行的“手动步骤”，不阻塞主流程
- **只对高危动作审批**：例如 `merge_pr`、触碰敏感目录/鉴权/密钥/迁移/发布等
- **不并行**：同一 Issue 任意时刻最多一个运行中的 Run；返工用新 Run 串行推进

