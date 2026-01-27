---
title: "Roadmap（ACP 协作台）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# Roadmap（ACP 协作台）

> 更新时间：2026-01-27  
> 目标：在浏览器里完成“需求池 → 执行（ACP）→ Review → PR → Merge → Done”的闭环。

## SSOT（本文只做高层进度）

- **详细执行清单 / 已知缺口**：`docs/00_overview/plans/2026-01-27-pm-agent-execution-plan.md`
- **方法论与术语（P0/P1/P2、Track、Gate、DoD）**：`docs/05_process/workflow-optimization-bmad-lite.md`

## 当前状态（MVP：闭环已跑通）

- 已形成基础闭环：Issue → Run（worktree）→ PR → CI（`waiting_ci`）→ Merge（审批）
- 已具备 Task/Step 状态机：多执行器（agent/ci/human/system）+ 回滚重跑 + Human Submit
- PM 自动化 v1：多来源接入 + 自动分析/分配/启动（可开关）+ GitHub 评论回写（best-effort）
- Policy/Approval 基线：`create_pr` / `publish_artifact` 动作级 gate；`merge_pr` 默认审批；`sensitivePaths` 命中升级
- BMAD-Lite P0：Context Pack + DoD + 对抗式 Review + next-action 能力

## P1（当前主线：闭环增强 + 统一门禁）

> P1 的定义与路线图以 `docs/05_process/workflow-optimization-bmad-lite.md` 为准；具体任务拆分以执行计划为准。

### P1 已完成（基础铺垫）

- Track：Task `quick/planning/enterprise` 持久化 + UI 展示；PM 分析输出 `recommendedTrack` 并可一键应用
- 模板体系：`quick.*` / `planning.*` 模板与 UI 分组/过滤（deprecated 默认隐藏）
- Context Pack：`docs/context-manifest.json` 支持按 `step.kind` 配置注入（无需改代码即可调整）

### P1 下一步优先级（按顺序）

1. **CI/Webhook 闭环增强**：已补 GitLab pipeline 回写 + GitHub CI 关联增强（`head_sha/PR`）；下一步：“双模测试”降级策略落地（或手动 `sync-ci`）
2. **Review Gate 聚合**：把 “AI review / 人 review / 合并审批” 聚合成统一 gate（含 DoD/证据），并在 UI 可视化
3. **Gate 实施就绪 + correct-course**：落地 `gate.implementation_readiness` 与重规划能力，并与 Policy/Approval 对齐
4. **Policy/Approval 扩展**：补齐 `ci/test/auto-merge` 等动作级门禁与聚合策略（含敏感目录联动与可审计决策）
5. **worktree 生命周期**：完成/取消/合并后自动清理；支持保留/归档策略，降低磁盘占用

## P2（后续：安全、可观测、可配置化）

- Webhook：secret 强制校验、幂等 eventId、限流与重放保护
- Token：Project token 加密存储与脱敏审计（避免明文字段长期存在）
- 观测与审计：LLM 成本/延迟汇总、自动化决策可回放、告警/指标完善
- 模板持久化 + 编辑器；执行器插件化；更多 SCM（如 Gitee）
