# worktree 环境下“文件不存在/找不到”的分支漂移排障（上游分支已删除）

**提取时间：** 2026-01-27  
**适用上下文：** 本地仓库使用 `git worktree`（例如 main 被另一个 worktree 占用），并且当前所在分支的上游已被删除（`[gone]`），导致你以为应该存在的文件/功能在本地“消失”。

## 问题

- `cat path/to/file` 报 `Cannot find path ... because it does not exist`，但你确信该文件在仓库里存在（比如刚合并的 PR）。
- `rg` 搜索不到预期符号/文件。
- `git switch main` 失败：`fatal: 'main' is already used by worktree at ...`，无法直接切回 main 确认。
- `git status -sb` 显示当前分支 `... [gone]`（远端分支已删除），本地还停留在旧提交。

## 解决方案

1. **先做仓库状态体检（确认你在哪个提交）**
   - `git status -sb`：看当前分支是否跟踪了 `[gone]` 的上游。
   - `git log -1 --oneline`：确认 HEAD 是否是你以为的最新 merge commit。
2. **刷新远端引用**
   - `git fetch origin`（必要时加 `--prune`）确保 `origin/main` 是最新。
3. **在 main 被占用时，用 detached HEAD 直接对齐到 `origin/main`**
   - `git switch --detach origin/main`
   - 这不会占用本地 `main` 分支，也不受其他 worktree “占用 main” 的影响。
4. **回到目标提交后再验证**
   - 再次 `cat/rg`，文件通常会“回来”；此时再做后续排查（避免在错误分支上浪费时间）。

## 示例

```powershell
# 1) 发现当前分支上游已删除（[gone]），且 HEAD 不是最新
git status -sb
git log -1 --oneline

# 2) 刷新 origin/main
git fetch origin

# 3) main 被其他 worktree 占用时，用 detached 对齐到远端 main
git switch --detach origin/main

# 4) 再验证文件/符号是否存在
rg -n "<symbol>" backend/src
```

## 何时使用

- “文件不存在/找不到”但你高度确定它来自已合并的 PR。
- 你在多 worktree 项目里工作，且本地 `main` 不能直接 checkout。
- `git status -sb` 出现 `... [gone]` 或你怀疑自己停在旧分支/旧提交上。

