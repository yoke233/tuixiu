# 修复 worktree 中 ORIG_HEAD 损坏导致的 refs/lock 报错

**提取时间：** 2026-01-27  
**适用上下文：** Windows + `git worktree` 项目里，某个 worktree 的 `git stash` / `rebase` / `merge` 突然报 “Invalid argument / could not lock ref”，且错误路径指向 `.git/worktrees/<name>/...`。

## 问题

- `git stash` / `git rebase --continue` / `git merge` 报错类似：
  - `fatal: .../.git/worktrees/<wt>/ORIG_HEAD: Invalid argument`
  - `fatal: cannot lock ref 'ORIG_HEAD': ...`
- 同一个仓库的其他 worktree 正常，只有某个 worktree “坏了”。

## 解决方案

1. **定位该 worktree 的真实 gitdir（不要在仓库根 `.git/` 里盲删）**
   - 在 worktree 根目录查看 `.git` 文件内容：里面是 `gitdir: <path>`。
2. **备份并删除损坏的 `ORIG_HEAD`**
   - `ORIG_HEAD` 是 Git 用来记录“操作前 HEAD”的辅助指针；删除会失去“回到上一步”的便利，但通常不影响仓库一致性。
   - 若你正处于 rebase/merge 过程中，建议先确认 `$gitdir` 下是否有 `rebase-apply/`、`rebase-merge/`、`MERGE_HEAD` 等状态文件，再决定是否 `--abort` 或继续。
3. **重试原操作**
   - 删除后重新执行 `git stash` / `git rebase --continue` 等，通常可恢复。

## 示例

```powershell
# 在 worktree 根目录执行
$gitdir = (Get-Content .git -TotalCount 1) -replace '^gitdir:\\s*', ''
$orig = Join-Path $gitdir 'ORIG_HEAD'

# 可选备份
Copy-Item -Force $orig ($orig + '.bak') -ErrorAction SilentlyContinue

# 删除损坏文件
Remove-Item -Force $orig

# 重试原操作
git stash -u
```

## 何时使用

- 某个 worktree 单独出现 refs/lock/Invalid argument，而其他 worktree 正常。
- 报错路径明确包含 `.git/worktrees/<name>/ORIG_HEAD`。

