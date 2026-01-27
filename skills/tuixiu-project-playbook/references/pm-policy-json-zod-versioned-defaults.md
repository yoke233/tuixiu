# 用 Zod 维护“可演进”的 Project Policy（存 JSON、带版本与默认值）

**提取时间：** 2026-01-27  
**适用上下文：** 想快速引入可配置策略（Policy），但不希望立即加新表/做 DB migration；同时需要前后端一致的类型与默认行为。

## 问题

- Policy 要可配置、可演进，但一上来就加表/迁移成本高。
- Policy 字段会逐步扩展（例如自动化开关越来越多），历史数据可能缺字段。
- 如果只在后端改 schema，前端类型/默认模板/测试很容易不同步导致隐藏 bug。

## 解决方案

1. **把 Policy 存在现有 JSON 字段里**
   - 例如存到 `Project.branchProtection.pmPolicy`（避免新表迁移）。
2. **用 Zod 做“版本化 + 默认值 + 严格校验”**
   - `version: 1` 固定版本号（后续升级可引入 v2 schema）。
   - 字段全部给 `.default(...)`，保证旧数据缺字段也能被补齐。
   - `.strict()` 防止未知字段悄悄进入（避免配置污染/拼写错误不报）。
3. **API 层只接收 unknown，先 safeParse 再落库**
   - 校验失败返回 `BAD_POLICY`，并带 `details`。
4. **跨层同步（必须）**
   - 更新前端 `PmPolicy` 类型与默认 JSON 模板。
   - 更新后端路由/服务测试（默认返回值、PUT 更新后的结构）。

## 示例

```ts
// 后端：pmPolicy.ts（示意）
export const pmPolicyV1Schema = z.object({
  version: z.literal(1).default(1),
  automation: z.object({
    autoStartIssue: z.boolean().default(true),
    autoReview: z.boolean().default(true),
  }).default({ autoStartIssue: true, autoReview: true }),
}).strict();
```

## 何时使用

- 你想快速上线“策略配置”，并且可以接受先把配置放在 JSON 字段里（后续再迁移到专用表）。
- 你预计策略字段会频繁迭代，需要兼容历史配置且不想每次都手动补全。
- 你需要前端 Admin 页面直接编辑 JSON，并要求保存前强校验、防止写坏配置。

