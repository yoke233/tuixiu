---
name: tuixiu-project-playbook
description: Tuixiu 项目特定运行手册与排障指南。用于在本仓库开发/运维时处理 git worktree 与 gh PR 合并/清理冲突、worktree refs 损坏、分支漂移导致文件缺失、PM 自动化与 Policy（Zod 版本化默认值）、pnpm+Prisma generate/typecheck、Windows 下 acp-proxy/runner Node spawn npx/pnpm ENOENT，以及 GitHub/GitLab 统一 PR 抽象与 UUIDv7 约定。
---

# Tuixiu Project Playbook

按问题类型打开对应参考文档（只加载必要部分，避免上下文膨胀）。

## 参考索引

- **Worktree / gh / 分支漂移**
  - `references/gh-pr-merge-worktree-branch-cleanup.md`
  - `references/worktree-branch-drift-file-missing-detach-origin-main.md`
  - `references/git-worktree-orig-head-corruption-repair.md`
- **PM 自动化 / Policy**
  - `references/pm-auto-advance-run-completed-ci-webhook.md`
  - `references/pm-policy-json-zod-versioned-defaults.md`
- **Prisma / typecheck**
  - `references/pnpm-backend-prisma-generate-for-typecheck.md`
- **SCM 集成（GitLab/GitHub）**
  - `references/scm-pr-abstraction-gitlab-github.md`
- **Windows 兼容（Node spawn）**
  - `references/windows-node-spawn-cmd-shim.md`
- **ID 约定（UUIDv7）**
  - `references/uuidv7-sortable-ids.md`

