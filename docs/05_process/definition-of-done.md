---
title: "Definition of Done（DoD）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# Definition of Done（DoD）

> 目的：把“完成”的标准显式化、可审计，并让人类与 Agent 在 Review / Merge 前有统一检查清单。

## 1. 总体 DoD（任何改动都适用）

- 变更范围最小化：不做无关重构/格式化/改名
- 代码可运行：TypeScript 编译/类型检查通过（或明确解释无法通过的原因与风险）
- 测试有证据：本地或 CI 至少一种通过；若失败必须给出复现步骤与修复计划
- 文档同步：对外行为/配置/运行方式有变化时，更新 `docs/` 或 README（最少写入 report）
- 安全合规：不引入密钥泄漏、危险默认配置、绕过鉴权；敏感变更需显式说明风险与缓解措施
- 可回滚：必要时给出回滚/降级方案（尤其是迁移、配置、鉴权、发布相关改动）

## 2. Review DoD（评审完成的最低标准）

- 评审结论必须可执行：明确指出问题位置/影响/建议修复方式
- 高风险点必须覆盖：鉴权、权限、数据迁移、外部调用、命令执行、文件系统、网络访问
- 评审必须引用证据：
  - `git diff`（关键文件/关键片段）
  - 测试/CI 结果（日志摘要或链接）
  - 相关产物（`report`/`ci_result`/`pr`）

## 3. Gate/决策（为后续自动化预留）

> 系统后续会把关键门禁输出为 `gate_decision`（PASS/CONCERNS/FAIL/WAIVED）。

- **PASS**：满足 DoD，可继续自动推进
- **CONCERNS**：允许继续，但必须记录风险与 mitigation（审计可见）
- **FAIL**：必须打回（rollback 或 correct-course），修复后再继续
- **WAIVED**：允许越过门禁，但必须由 human/admin 明确确认（审批）

## 4. Step 级 DoD（按常见 step.kind）

### `dev.implement`

- 完成实现并 `git commit`（提交信息清晰、可追踪）
- 给出验证方式：如何运行/如何测试/如何复现

### `test.run`

- 运行约定测试命令（默认 `pnpm -r test`，或按 Issue/Step 说明）
- 输出结构化摘要（`CI_RESULT_JSON`），并限制日志节选长度

### `code.review`（对抗式默认）

- 必须输出结构化 JSON（`REPORT_JSON`）+ Markdown 报告
- 必须给出 findings；若 “0 findings”，必须解释为什么确信没问题，并列出已检查项清单
- verdict 规则：
  - 存在高/中风险问题且无明确缓解 → `changes_requested`
  - 仅低风险或已给出可接受缓解 → 可 `approve`（仍需说明风险）

### `pr.create`

- PR 描述包含：变更摘要、测试证据、风险说明、回滚建议（如适用）
- 若命中 `sensitivePaths`：必须走审批或明确 human 确认（由 policy 决定）

### `merge_pr`（高危动作）

- 默认必须审批（除非 policy 明确允许自动合并）
- 合并前必须具备：PR 存在 + 测试/CI 通过（或按策略允许的降级结论）+ 风险说明/mitigation（如有）
