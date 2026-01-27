# backend typecheck 缺 @prisma/client：pnpm install + prisma:generate

**提取时间：** 2026-01-27  
**适用上下文：** pnpm workspace 项目中 backend 使用 Prisma。首次拉代码/切分支后跑 `pnpm -C backend typecheck` 报依赖缺失或 Prisma Client 缺失。

## 问题

- `pnpm -C backend typecheck` 报错类似：
  - `Cannot find module '@prisma/client'`
  - 或 Prisma Client 相关类型/导入异常

## 解决方案

1. 在仓库根目录安装 workspace 依赖：`pnpm install`
2. 生成 Prisma Client：
   - `pnpm -C backend prisma:generate`
   - 或首次需要迁移：`pnpm -C backend prisma:migrate`（通常也会触发 generate）
3. 重新执行 typecheck：`pnpm -C backend typecheck`

## 示例

```powershell
pnpm install
pnpm -C backend prisma:generate
pnpm -C backend typecheck
```

## 何时使用

- 看到 `@prisma/client` 缺失或 Prisma 类型异常。
- 刚切换分支/刚 clone/刚清理 node_modules 后第一次跑 typecheck。

