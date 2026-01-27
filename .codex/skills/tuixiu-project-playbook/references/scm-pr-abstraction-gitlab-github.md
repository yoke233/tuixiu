# GitLab/GitHub 统一抽象为 PR（artifact）并支持创建/合并

**提取时间：** 2026-01-26  
**适用上下文：** 产品层面只想暴露“PR”概念，但底层需同时对接 GitLab（MR）与 GitHub（PR）并提供创建/合并能力

## 问题

- 现象：实现 PR 流程时容易把 GitLab 的 “MR” 概念泄露到抽象层（接口命名/变量命名/前端文案），导致跨 SCM 体验不一致。
- 根因：
  - GitLab 与 GitHub API 结构差异大（`projectId + iid` vs `owner/repo + number`）。
  - 业务层需要统一：状态机、artifact 结构、UI 展示与动作（创建 PR、查看状态、合并 PR）。

## 解决方案

1. **抽象层统一使用 `PR`**
   - 数据层：Run 的产物统一用 `artifact.type = "pr"`。
   - content 内通过 `provider: "gitlab" | "github"` 区分，并存储 provider-specific 字段。
2. **基于 Project 的 SCM 配置分流**
   - `Project.scmType` 决定走 GitLab/GitHub。
   - token 与必要参数（GitLab projectId / GitHub token）放在 Project 配置里。
3. **创建 PR 的一致流程**
   - `git push` 分支
   - 调用 provider API 创建 PR
   - 写入 pr artifact
   - 更新 run 状态（例如 `waiting_ci`）
4. **合并 PR 的一致流程**
   - 调用 provider API merge
   - best-effort 拉取最新状态再更新 artifact
   - 合并成功后推进 Issue/Run 状态（例如 `done/completed`）

## 示例

- 统一入口（抽象层）：`backend/src/services/runReviewRequest.ts`
- provider 实现（细节层）：`backend/src/integrations/gitlab.ts`、`backend/src/integrations/github.ts`

## 何时使用

- 你要在 UI/API 上统一“PR”概念，同时支持多种代码托管平台。
- 你计划未来扩展（例如 Gitee/企业 GitHub），希望新增 provider 不影响既有抽象与 UI。

