---
title: "GitLab 集成（当前实现）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# GitLab 集成（当前实现）

本文档说明当前仓库如何对接 GitLab API，实现“创建/合并 GitLab Merge Request”。  
注意：**GitLab 侧术语是 MR**，但系统在数据层与 API/UI 抽象统一称 **PR**（artifact.type=`pr`）。

---

## 1. 当前已实现的能力

- ✅ 创建 PR（GitLab MR）：`POST /api/runs/:id/create-pr`
- ✅ 合并 PR（GitLab MR）：`POST /api/runs/:id/merge-pr`
- ✅ 将 PR 信息写入 `Artifact(type=pr)`，并在合并成功后推进 `Issue.status=done`

未实现（规划中，见 `docs/00_overview/roadmap.md`）：

- ❌ GitLab Webhook/CI 闭环（pipeline 状态回写、自动推进 `waiting_ci`）

实现入口：

- GitLab API：`backend/src/integrations/gitlab.ts`
- PR 统一抽象：`backend/src/services/runReviewRequest.ts`

---

## 2. Project 配置（写入数据库）

创建 Project 时填写（`POST /api/projects` 或 Web UI）：

- `scmType`: `gitlab`
- `repoUrl`: GitLab 仓库地址（https / ssh 均可）
- `defaultBranch`: 默认 `main`
- `gitlabProjectId`: GitLab 数字 project id
- `gitlabAccessToken`: PAT（至少需要创建 MR、读取 MR、合并 MR；以及推送分支所需权限）
- `gitlabWebhookSecret`: 可选（后续接 webhook 时使用）

> 安全提示：当前实现 token 存 DB 明文字段；生产建议改为加密存储或外部 secret 管理。

---

## 3. 创建 PR（GitLab MR）

端点：

- `POST /api/runs/:id/create-pr`

请求体（可选）：

```json
{
  "title": "可选：PR 标题（默认 Issue.title）",
  "description": "可选：PR 描述（默认 Issue.description）",
  "targetBranch": "可选：目标分支（默认 Project.defaultBranch）"
}
```

执行流程（后端）：

1. 读取 Run/Issue/Project，确认：
   - Run 有 `branchName`（或已有 `Artifact(type=branch)`）
   - Project 配置了 `gitlabProjectId` 与 `gitlabAccessToken`
2. 对分支执行 `git push -u origin <branch>`
3. 调用 GitLab API 创建 MR：
   - `POST /projects/:id/merge_requests`
4. 写入 `Artifact(type=pr)`（provider=gitlab）
5. best-effort：将 `Run.status` 推进为 `waiting_ci`

---

## 4. 合并 PR（GitLab MR）

端点：

- `POST /api/runs/:id/merge-pr`

请求体（可选）：

```json
{
  "squash": false,
  "mergeCommitMessage": "可选：合并提交信息"
}
```

执行流程（后端）：

1. 读取 Run/Issue/Project，找到 `Artifact(type=pr)`（provider=gitlab）
2. 调用 GitLab API 合并 MR：
   - `PUT /projects/:id/merge_requests/:iid/merge`
3. best-effort：再 `GET /merge_requests/:iid` 刷新最终状态（GitLab 可能最终一致）
4. 更新 `Artifact(type=pr)` 中的 `state/merge_status/detailed_merge_status`
5. 若 state=merged：推进 `Issue.status=done` 与 `Run.status=completed`

---

## 5. PR Artifact 结构（GitLab）

`Artifact(type=pr)` 的 `content`（provider=gitlab）包含：

- `provider`: `"gitlab"`
- `baseUrl`: 从 `Project.repoUrl` 推导（例如 `https://gitlab.example.com`）
- `projectId`: `Project.gitlabProjectId`
- `iid`: MR 的 iid（项目内序号）
- `id`: MR 的全局 id
- `webUrl`: MR 页面地址
- `state`: `opened/merged/closed/...`
- `title`
- `sourceBranch` / `targetBranch`
- `merge_status` / `detailed_merge_status`（如可用）

---

## 6. repoUrl 推导规则

后端会从 `Project.repoUrl` 推导 GitLab `baseUrl`（见 `backend/src/integrations/gitlab.ts`）：

- `https://host/group/repo(.git)` → `https://host`
- `git@host:group/repo(.git)` → `https://host`

若无法推导，将返回 `BAD_REPO_URL` 错误。

---

## 7. 常见问题

### Q1: 创建 PR 失败，提示权限不足

检查：

- `gitlabAccessToken` 是否有足够权限（建议至少具备 `api` scope）
- 分支是否能 push 到远端（后端会先 `git push`，这里失败也会导致创建 PR 失败）

### Q2: PR 已存在（同分支）

当前实现若 Run 已有 `Artifact(type=pr)` 会直接返回该 artifact，避免重复创建。

---

## 8. 后续：Webhook/CI（规划）

建议落地方式：

- 新增 `backend/src/routes/webhooks.gitlab.ts`（或合并到 `routes/webhooks.ts`）
- 支持接收：
  - MR 事件：opened/merged/closed
  - pipeline 事件：success/failed/running
- 将 CI 结果写入 `Artifact(type=ci_result)` 并驱动：
  - `Run.status: waiting_ci → completed/failed`
  - Issue 状态推进与前端提示
