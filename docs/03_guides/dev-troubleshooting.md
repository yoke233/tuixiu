---
title: "开发踩坑记录"
owner: "platform"
status: "active"
last_reviewed: "2026-02-04"
---

# 开发踩坑记录

用于记录开发过程中遇到的典型问题与处理方式，便于复用与排障。

## Prisma 迁移

- **迁移漂移（migration was modified）**  
  现象：`prisma migrate dev` 提示某历史迁移被修改。  
  处理：不要修改已应用的迁移文件；使用独立开发库，或执行 `prisma migrate reset` 清库重建。

- **缺少 `DATABASE_URL`**  
  现象：`prisma migrate dev` 报 `Environment variable not found: DATABASE_URL`。  
  处理：准备 `backend/.env` 或在当前终端设置环境变量。

- **迁移锁超时（P1002 / pg_advisory_lock）**  
  现象：`Timed out trying to acquire a postgres advisory lock`。  
  处理：结束残留的 `prisma migrate dev` 进程后重试。

- **交互式迁移名称卡住**  
  现象：非 TTY 环境下提示输入迁移名导致挂起。  
  处理：使用参数直接提供名称，例如：`pnpm -C backend prisma:migrate -- --name add_refresh_sessions`。

## 前端/鉴权

- **WS 刷新地址跨域失效**  
  现象：WS 断开后调用 `"/api/auth/refresh"` 失败（跨域/反代）。  
  处理：统一使用 `apiUrl()` / `getApiBaseUrl()` 拼出后端地址。

- **401 刷新并发导致误注销**  
  现象：多并发请求触发多次 refresh，服务端复用检测触发全量注销。  
  处理：前端增加 refresh 去重锁，将并发 401 合并为一次刷新。

## 文档与 CI

- **docs lint 失败：缺少 YAML Front Matter**  
  现象：新增文档未包含 `title/owner/status/last_reviewed`。  
  处理：补齐 Front Matter；可先运行 `python scripts/docs_lint.py` 验证。

## Git / Worktree

- **worktree 删除失败**  
  现象：`git worktree remove` 提示目录不空或被占用。  
  处理：先删除 `node_modules`，执行 `git worktree prune`，必要时结束占用该目录的进程。

## PR / GH CLI

- **`gh pr create` 多行 body 转义失败**  
  现象：`--body` 多行参数解析错误。  
  处理：使用 `--body-file` 指向临时文件。
