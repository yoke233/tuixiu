# Roadmap（ACP 协作台）

> 更新时间：2026-01-26  
> 目标：在浏览器里完成“需求池 → 执行（ACP）→ Review → PR → Merge → Done”的闭环。

## 已完成（MVP 可用）

- **Node/TypeScript `acp-proxy/`**：WS ↔ ACP（`@agentclientprotocol/sdk`），支持 `session/load` 尝试复用、`cwd` 绑定、chunk 聚合、Windows `npx` 启动兼容
- **Issue/Run 基本流转**：Issue 默认进入 `pending` 需求池；启动 Run 后进入 `running`；Run 结束进入 `reviewing`
- **Run 工作区**：每个 Run 自动创建独立 `branch + git worktree`（`.worktrees/run-<worktreeName>`），并把 `cwd` 透传给 proxy/ACP
- **变更查看**：Run 详情支持查看变更文件列表与 diff
- **PR（后端一键）**
  - GitLab：`/api/runs/:id/create-pr`、`/api/runs/:id/merge-pr`
  - GitHub：同一套端点（Project 需配置 `githubAccessToken`）
- **前端体验**：浅色/深色主题切换；详情页可调宽；控制台输出更接近 CLI（减少逐字/闪动）
- **测试**：`backend/`、`frontend/`、`acp-proxy/` 均有单元测试并可 `pnpm -r test` 验证
- **清理**：旧 Go 版 proxy 已从仓库移除

## 未完成（P0：下一步优先）

- **CI/Webhook 闭环**：接收 GitLab/GitHub webhook，写入 `ci_result` 产物并驱动 `Run.status=waiting_ci` → `completed/failed`
- **Review 工作流**：PR 创建后进入 `reviewing`，支持“通过/打回/重跑”并驱动 Issue 状态
- **会话/在线状态面板**：Agent 是否在线、Run 是否绑定到有效 ACP session、断线重连策略与提示
- **Project/Agent 维度分配**：Project 负责人/可用 Agent 列表/策略（例如固定/轮询/按负载）

## 未完成（P1：增强体验）

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
- `POST /api/runs/:id/prompt`：在同一个 Run 上继续对话（尽量复用 `acpSessionId`）
- `GET /api/runs/:id/changes` / `GET /api/runs/:id/diff`：查看变更
- `POST /api/runs/:id/create-pr` / `POST /api/runs/:id/merge-pr`：创建/合并 PR
