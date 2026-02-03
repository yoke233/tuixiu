---
title: "GitCredential 与 SCM 配置（项目级）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-02-03"
---

# GitCredential 与 SCM 配置（项目级）

本仓库已将 Git/SCM 相关的 secret 与配置从 `Project` / `RoleTemplate.envText` 拆出：

- **GitCredential（项目级凭证）**
  - `run`（低权限）：用于 Run 执行时的 `git clone/fetch/push`（以及必要的 `GH_TOKEN/GITLAB_TOKEN`）。
  - `scm_admin`（高权限）：用于后台 SCM 自动化/审批/PR 操作（GitHub/GitLab API）。
- **ProjectScmConfig（项目级 SCM 配置）**
  - GitLab：`gitlabProjectId` / `gitlabWebhookSecret`
  - GitHub：`githubPollingEnabled` / `githubPollingCursor`（cursor 只读）

## 1) 在哪里配置

在 Admin UI 的 Project 管理页：

- **Git 凭证（低权限 Run）**：配置/选择 `run` 凭证
- **SCM Admin 凭证（高权限）**：配置/选择 `scm_admin` 凭证
- **SCM 配置**：配置 GitLab ProjectId / Webhook Secret、GitHub Polling 等

## 2) RoleTemplate.envText 不再承载 Git 认证

`RoleTemplate.envText` 仍可用于注入其它环境变量，但 **禁止**以下 keys（会直接被后端拒绝）：

- `TUIXIU_GIT_*`
- `GH_TOKEN` / `GITHUB_TOKEN`
- `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN`

命中时会返回错误码：`ROLE_ENV_GIT_KEYS_FORBIDDEN`（提示你改到 Project 的 GitCredential 中配置）。

## 3) Run 会拿到哪些 Git 相关环境变量

当 Workspace Policy 解析为 `git` 时，系统会基于 “Project + run GitCredential” 自动下发：

- `TUIXIU_GIT_AUTH_MODE`（`https_pat` / `ssh`）
- `https_pat`：`TUIXIU_GIT_HTTP_USERNAME` / `TUIXIU_GIT_HTTP_PASSWORD`
- `ssh`：`TUIXIU_GIT_SSH_COMMAND` / `TUIXIU_GIT_SSH_KEY(_B64)` 等
- 兼容性 token：`GH_TOKEN`/`GITHUB_TOKEN`、`GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`（来自 run 凭证）

如果 Project 未配置 `run` 凭证且 Policy 为 `git`，启动会报：`RUN_GIT_CREDENTIAL_MISSING`。

## 4) 哪些功能需要 scm_admin 凭证

涉及 GitHub/GitLab API 的后台能力（如：审批评论、PR 自动评审、创建/合并 PR、issues 导入、轮询等）需要 `scm_admin` 凭证中对应平台的 access token。

