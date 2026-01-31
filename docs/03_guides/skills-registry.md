---
title: "Skills Registry（Phase 2）：skills.sh Provider / 导入 / 更新 / 版本策略"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-31"
---

# Skills Registry（Phase 2）使用指南

本文档描述当前仓库实现的 Skills Registry Phase 2：接入 `skills.sh` 外部生态、导入/更新/审计、以及角色绑定的 `latest/pinned` 版本策略。运行时挂载见 `docs/06_runbooks/runtime-skills-mounting.md`。

---

## 1. skills.sh Provider（外部搜索）

后台接口：`GET /api/admin/skills/search?provider=skills.sh&q=<keyword>`

- 数据来源：backend 调用 `https://skills.sh/api/search?q=<keyword>&limit=<limit>` 获取结构化结果。
- 标准化来源字段：
  - `sourceType=skills.sh`
  - `sourceKey=<owner>/<repo>@<skill>`（由 `topSource@id` 生成）
  - `sourceRef=https://skills.sh/<owner>/<repo>/<skill>`
- 导入状态：平台以 `(sourceType, sourceKey)` 命中 Skill 判断 `installed=true|false`。
- 安全：`q` 为空时直接返回空列表，避免外部全量搜索。

前端入口：Admin → Skills → Provider 选择 `skills.sh`。

---

## 2. 导入（skills.sh → Skill/SkillVersion）

后台接口：`POST /api/admin/skills/import`

请求体（示例）：

```json
{
  "provider": "skills.sh",
  "sourceRef": "acme/repo@my-skill",
  "mode": "new-skill"
}
```

行为要点：

- 执行方式：backend 在临时目录运行 `npx skills add <sourceKey> -y`（project scope），定位 `./.agents/skills/<skill>/SKILL.md`。
- 指纹：基于“相对路径 + 文件内容”的稳定序列计算 `contentHash`（sha256）。
- 幂等：同一 Skill 下相同 `contentHash` 不会重复创建 `SkillVersion`。
- 打包：技能目录打包为 zip 并写入存储，生成 `storageUri`（供运行时下载）。
- 审计：导入/更新/发布 latest/回滚 等关键动作会写入 `SkillAuditLog`。

前端入口：

- Admin → Skills → Provider=skills.sh：`导入` / `导入新版本`
- 导入成功后会刷新列表，并可打开该 Skill 的详情与版本列表。

---

## 3. 更新检查与批量更新（MVP）

后台接口：

- `POST /api/admin/skills/check-updates`
- `POST /api/admin/skills/update`

策略：

- “检查更新”对 `skills.sh` 来源执行一次“试装/计算候选 contentHash”，与当前已导入版本对比。
- “批量更新”默认 **仅导入新版本**，不会自动推进 `latest`；可显式选择 `publishLatest=true`。

前端入口：

- Admin → Skills → Provider=registry：`检查 skills.sh 更新` / `批量更新`

---

## 4. 版本策略（latest / pinned）

角色绑定接口：`/api/admin/projects/:projectId/roles/:roleId/skills`

- `latest`：运行时解析为 `Skill.latestVersionId`（要求已发布）。
- `pinned`：运行时解析为 `RoleSkillBinding.pinnedVersionId`（要求存在且属于该 Skill）。

前端入口：Admin → 角色模板 → 启用 Skills

- 可为每个 skill 选择 `latest/pinned`
- `pinned` 需要选择具体版本（`pinnedVersionId`）

---

## 5. 安全与约束

- 导入与运行时都不执行外部仓库脚本：只做拉取、解析、打包、下载、解压与挂载。
- 前端展示来自 `SKILL.md` 的文本必须经过 sanitize（当前后端已做基础 sanitize）。
- 运行时通过 env allowlist 透传 `init.env`（默认包含必要 `TUIXIU_*` 与常用 Token；可按需扩展）。
