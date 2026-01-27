# Roadmap（ACP 协作台）

> 更新时间：2026-01-27  
> 目标：在浏览器里完成“需求池 → 执行（ACP）→ Review → PR → Merge → Done”的闭环。

## 已完成（MVP 可用）

- **Node/TypeScript `acp-proxy/`**：WS ↔ ACP（`@agentclientprotocol/sdk`），支持 `session/load` 尝试复用、`cwd` 绑定、chunk 聚合、Windows `npx` 启动兼容
- **Issue/Run 基本流转**：Issue 默认进入 `pending` 需求池；启动 Run 后进入 `running`；Run 结束进入 `reviewing`
- **Run 工作区**：每个 Run 自动创建独立 `branch + git worktree`（`.worktrees/run-<worktreeName>`），并把 `cwd` 透传给 proxy/ACP
- **变更查看**：Run 详情支持查看变更文件列表与 diff
- **多执行器任务系统（Task/Step/Execution）**：一个 Issue 下可创建 Task（内置模板 4A），分步执行（agent/ci/human/system），支持回滚到任意 Step 并重跑（保留历史 attempt）
- **PR（后端一键）**
  - GitLab：`/api/runs/:id/create-pr`、`/api/runs/:id/merge-pr`
  - GitHub：同一套端点（Project 需配置 `githubAccessToken`）
- **Review/打回/推进（Task 级别）**：Human 步骤可提交 `approve/changes_requested`；changes_requested 会把 Task 置为 `blocked`，可手动回滚后继续
- **交付物发布（落盘并 commit）**：支持把 `report/ci_result` 发布到 workspace 并提交 commit（带脱敏与敏感信息拦截）
- **轻量登录与角色（JWT）**：新增 `/api/auth/bootstrap|login|me`；默认对非 GET API 做登录校验，关键配置（Project/Role）限制 admin
- **GitHub CI 结果回写（基础）**：GitHub webhook 兼容 `workflow_run/check_suite/check_run`，可驱动 `waiting_ci` Run 结束并写入 `ci_result`
- **PM Agent v1（任务管理员雏形）**：多来源接入（GitHub/GitLab/webhook/消息入口）→ 自动分析/分配/启动（可开关）；GitHub Issue 状态回写评论
- **高危动作审批（MVP）**：`merge-pr` 默认进入审批队列，通过后才执行；审批审计写入 Run events 并回写 GitHub 评论
- **前端体验**：浅色/深色主题切换；详情页可调宽；控制台输出更接近 CLI（减少逐字/闪动）
- **前端 Tasks 面板**：Issue 详情页支持创建 Task、启动 Step、回滚、Human Submit；新增登录页与 Auth Provider
- **测试**：`backend/`、`frontend/`、`acp-proxy/` 均有单元测试并可 `pnpm -r test` 验证
- **清理**：旧 Go 版 proxy 已从仓库移除

## 未完成（P0：下一步优先）

- **CI/Webhook 闭环（增强）**
  - GitLab pipeline/webhook 事件回写（当前只覆盖 GitHub）
  - CI Run 的精确关联（当前主要按 `branchName` 匹配，需补充按 `head_sha/PR` 等更稳的映射）
  - “双模测试”策略落地：CI 不可用/超时自动降级到 workspace 测试（或提供手动 `sync-ci`）
- **Review 工作流（增强）**：把 “AI review / 人 review / 合并审批” 做更清晰的门禁与状态机（目前已能打回/回滚/继续，但缺少统一的 gate 聚合与可视化）
- **会话/在线状态面板**：Agent 是否在线、Run 是否绑定到有效 ACP session、断线重连策略与提示
- **Project/Agent 维度分配**：Project 负责人/可用 Agent 列表/策略（例如固定/轮询/按负载）
- **Policy/审批扩展**：按 Project 配置“可自动执行/必须审批”的动作与敏感目录门禁（不仅限 `merge_pr`）
- **Run 自动验收报告（auto-review）**：汇总 diff/测试/风险/建议，并作为自动 create-pr/merge gate
- **自动推进到 PR**：满足门禁后自动 `create-pr`；失败降级为可执行的手动步骤（不阻塞）

## 未完成（P1：增强体验）

- **工作流可配置（编辑器）**：当前仅内置模板（4A），已在数据结构中预留 `params/dependsOn`；后续补“模板存库 + 编辑器 + 条件/可选步骤”
- **文件浏览器**：在浏览器中查看 workspace 文件树、单文件内容、与 diff 联动（当前仅 diff）
- **worktree 生命周期管理**：取消/完成/合并后自动清理 worktree；支持保留/归档策略
- **权限与密钥管理**：对 GitLab/GitHub token 做加密存储或外部 secret 管理（目前为明文字段）

## 未完成（P2：扩展）

- **更多 SCM**：Gitee 等
- **多会话/多实例**：一个 agent 并行多个 ACP 会话的可视化选择与资源治理
- **观测与审计**：更完整的日志、指标、审计轨迹与告警

## 现有关键端点（摘要）

- `POST /api/issues`：创建 Issue（进入 `pending`）
- `POST /api/issues/:id/start`：选择/自动分配 Agent 并启动 Run（创建 worktree）
- `GET /api/task-templates`：列出内置 Task 模板（4A）
- `POST /api/issues/:id/tasks` / `GET /api/issues/:id/tasks`：创建/列出 Task
- `POST /api/steps/:id/start`：启动 Step（按 executorType 分发）
- `POST /api/tasks/:id/rollback`：回滚到指定 Step
- `POST /api/runs/:id/submit`：Human 步骤提交（approve/changes_requested 或 merge）
- `POST /api/artifacts/:id/publish`：发布交付物到 workspace 并 commit（带脱敏与拦截）
- `POST /api/auth/bootstrap` / `POST /api/auth/login` / `GET /api/auth/me`：轻量登录与角色
- `POST /api/runs/:id/prompt`：在同一个 Run 上继续对话（尽量复用 `acpSessionId`）
- `GET /api/runs/:id/changes` / `GET /api/runs/:id/diff`：查看变更
- `POST /api/runs/:id/create-pr` / `POST /api/runs/:id/merge-pr`：创建/合并 PR
