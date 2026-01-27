# 基于事件的 Run 自动推进（串行队列 + Policy gate + best-effort 降级）

**提取时间：** 2026-01-27  
**适用上下文：** 需要在现有 Issue/Run 流程上“尽量全自动闭环”，但必须保持同一 Issue 串行；高危动作需要审批；自动化失败不能阻塞主流程。

## 问题

- 自动化触发点很多（Run 完成、CI 回写、webhook 更新），如果直接并发执行会互相打架（重复创建 PR/重复发起审批等）。
- 同一 Issue 必须串行（避免多 Run 同时推进导致混乱）。
- 自动化动作需要受策略控制：能自动做什么、不能自动做什么。
- 自动化任何一步失败，都不能把系统卡死：要降级为“提示/待人工处理”，且保留审计事件。

## 解决方案

1. **以 Issue 为 key 做串行队列**
   - `Map<string, Promise<void>>` + `enqueueByKey()`，确保同一 Issue 的自动推进永远顺序执行。
2. **把自动推进挂到“可靠事件点”**
   - Run 完成：在 ACP `prompt_result` 处理后触发（Run 状态已落库）。
   - CI 回写：在 webhook 写入 `ci_result` 并更新 Run 状态后触发。
3. **先 gate 再行动**
   - 总开关：`PM_AUTOMATION_ENABLED=true` 才运行。
   - 项目策略：`pmPolicy.*` 控制每一步（例如 `automation.autoStartIssue` 等）。
4. **best-effort + 可观测**
   - 失败只记录 event（例如 `pm.pr.auto_create.failed`），不阻塞；后续可在 UI/日志追踪。
5. **避免错误决策**
   - auto-review：若 diff 失败或无变更，建议降级为 `manual_review/none`，不要盲目建议 create_pr。
   - 非 Task 流：聚合 PR/CI 仅按 `run.id`（避免跨 Run 污染）；Task 流另走 Step 状态机。

## 示例

```ts
// 触发点（示例）：Run 完成 / CI 完成
triggerPmAutoAdvance({ prisma }, { runId, issueId, trigger: "run_completed" });
triggerPmAutoAdvance({ prisma }, { runId, issueId, trigger: "ci_completed" });
```

## 何时使用

- 你已经有 Issue/Run/CI/Webhook，但缺“自动推进到 PR/审批”的闭环。
- 你必须保证同一 Issue 串行（不并行），且希望自动化失败不影响正常使用。
- 你需要把“自动化决策”纳入 Project Policy，并能逐步扩展更多 gate（publish/merge 等）。

