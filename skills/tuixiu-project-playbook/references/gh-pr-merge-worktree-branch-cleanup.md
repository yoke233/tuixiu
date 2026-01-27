# Git worktree 场景下的 gh PR 合并/清理与分支占用排障

**提取时间：** 2026-01-27  
**适用上下文：** 仓库使用 `git worktree`（例如每个 Run 一个 worktree）时，进行 `gh pr merge`、切换 `main`、或清理分支经常被“某个 worktree 正在使用该分支”阻塞。

## 问题

- `gh pr merge <n> --delete-branch` 报错：`failed to delete local branch ... used by worktree at ...`
- `git switch main` 报错：`fatal: 'main' is already used by worktree at ...`
- `gh pr view <n> --json merged` 报错：`Unknown JSON field: "merged"`（字段名不对）

## 解决方案

1. **先判定 PR 实际状态（避免误判为“没合并”）**
   - 用 `gh pr view` 读取 `state/mergedAt/mergeCommit` 判断是否已合并；不要用不存在的 `merged` 字段。
2. **`gh pr merge` 因 worktree 占用失败时，用 `gh api` 直接合并（不依赖本地 checkout）**
   - 典型报错：`failed to run git: fatal: 'main' is already used by worktree at ...`
   - 直接调用 GitHub merge API：`PUT /repos/:owner/:repo/pulls/:number/merge`
3. **把“本地分支删除失败”当作可选清理**
   - 只要 PR 已合并且远端分支已删/不需要删，`gh` 的 local delete 失败不影响交付。
4. **worktree 占用分支时的标准清理**
   - 找到占用该分支的 worktree（错误信息通常带路径；或用 `git worktree list`）。
   - 进入该 worktree，把它切到其他分支或 detached HEAD（例如 `git switch --detach`）。
   - 再删除本地分支：`git branch -D <branch>`；或直接移除 worktree：`git worktree remove <path> --force`。
5. **想查看 `origin/main` 但本地 `main` 被别的 worktree 占用**
   - 直接 detached 到远端：`git fetch origin` 后 `git switch --detach origin/main`（不占用本地 `main` 分支）。

## 示例

```powershell
# 1) 确认 PR 是否已合并（字段用 state/mergedAt/mergeCommit）
gh pr view <pr-number> --json number,state,mergedAt,mergeCommit,headRefName,baseRefName,url

# 1.1) worktree 冲突导致 gh pr merge 失败时，改用 API 合并（不需要本地 checkout main）
gh api -X PUT repos/<owner>/<repo>/pulls/<pr-number>/merge -f merge_method=merge

# 2) 确认远端分支是否还存在
git ls-remote --heads origin <branch>

# 2.1) 如需删除远端分支（可选）：API 删除 refs（注意 branch 名要 URL-safe）
gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>

# 3) 如果提示“分支被 worktree 占用”，定位并清理
git worktree list
cd <path-to-the-blocking-worktree>
git switch --detach
git branch -D <branch>

# 4) 需要看 main 但 main 被占用：使用 detached
git fetch origin
git switch --detach origin/main
```

## 何时使用

- 看到任何包含 `used by worktree at` 的 git/gh 报错。
- 需要合并 PR 后顺手清理分支，但项目使用了多 worktree（尤其是“每个任务/Run 一个 worktree”）。
- 本地无法 `switch main`、或 `gh pr merge --delete-branch` 的“删除本地分支”步骤失败时。

