# PoC 实施指南总览（当前仓库）

本文档是 PoC/MVP 的“总览与边界说明”。具体实现细节请按文档导航进入对应章节；当前进度与下一步请以 `docs/ROADMAP.md` 为准。

---

## 文档导航（按阅读顺序）

1. `docs/02_ENVIRONMENT_SETUP.md`：把仓库跑起来（Windows/pwsh 友好）
2. `docs/01_SYSTEM_ARCHITECTURE.md`：真实架构与数据流（已按当前实现更新）
3. `docs/04_ACP_INTEGRATION_SPEC.md`：ACP/Session/Proxy 关键机制（已按当前实现更新）
4. `docs/03_COMPONENT_IMPLEMENTATION.md`：代码导航与关键文件入口（已按当前实现更新）
5. `docs/06_QUICK_START_GUIDE.md`：快速跑通一次闭环（UI + API）
6. `docs/05_GITLAB_INTEGRATION.md`：GitLab MR（系统统一称 PR）与当前实现边界
7. `docs/07_TESTING_PLAN.md`：测试与验收（将持续更新）
8. `docs/08_PRD_AI_PROJECT_MANAGER.md`：AI 项目管理员（PM Agent）PRD（分阶段方案）

---

## PoC 目标（MVP）

在浏览器里完成“需求池 → 执行（ACP）→ Review → PR → Merge → Done”的闭环：

```
创建 Project（配置 repo + token）
   ↓
创建 Issue（进入 pending 需求池）
   ↓
启动 Run（选择/自动分配 Agent + 创建 worktree）
   ↓
Agent 执行 & 输出事件流（Web UI 像 CLI 一样展示）
   ↓
创建 PR（GitLab MR / GitHub PR）
   ↓
Review / Merge（先支持后端一键合并）
   ↓
Issue 进入 done
```

---

## PoC 范围（P0）

### ✅ 已包含/已实现（MVP 可用）

- Web UI：Issue 列表/详情、RunConsole、对话输入、变更 diff、主题切换
- Orchestrator：REST API + WebSocket Gateway + Prisma/PostgreSQL
- Run 工作区：每个 Run 自动创建分支 + git worktree，并把 `cwd` 透传给 proxy/ACP
- PR（统一抽象）：GitLab/GitHub 创建与合并（后端端点：`/api/runs/:id/create-pr`、`/api/runs/:id/merge-pr`）
- Proxy：Node/TypeScript 实现 WS ↔ ACP（session/load 尝试复用、context 注入降级、chunk 聚合、Windows `npx` 兼容）

### ❌ 暂不包含/尚未实现（后续迭代）

- CI/Webhook 闭环（从 GitLab/GitHub webhook 推进 `waiting_ci → completed/failed`）
- Review 的“打回/返工/重跑”闭环与评论聚合
- 文件浏览器（当前仅变更 diff）
- 权限/审计/密钥加密存储（目前 token 存 DB 明文字段）

---

## 当前进度与下一步

请直接查看：`docs/ROADMAP.md`

---

## 团队分工建议（3 人 PoC）

- 后端：Orchestrator API、worktree/PR、事件与状态机、（未来 webhook）
- 前端：Issue/Run 详情页体验、控制台展示、变更/PR 侧栏、拖拽看板（未来）
- 客户端：acp-proxy、session 策略、稳定性（Windows/macOS/Linux）

---

## 风险与应对（聚焦当前实现）

1. **Agent/Session 不稳定**
   - 优先 `session/load` 复用；丢失时注入 `context` 降级恢复
2. **Windows 环境差异**
   - `npx`/`pnpm` 启动走 `cmd.exe /c` shim；API 调用建议 `curl.exe --noproxy`
3. **Git/权限问题**
   - PR 创建前需要 `git push`；token 权限不足会直接失败（需要清晰错误提示）
