## Context

当前 tuixiu 的管理后台与后端（Fastify + Prisma/Postgres）已经有成熟的 Admin 分区与接口模式（`/api/admin/*` + `admin` 权限校验），适合承载“平台级 Skill Registry”的管理能力。

现状下 skills 主要以“节点本地目录”的方式存在（例如 `.codex/skills` / `.agents/skills` / acp-proxy 容器内 `/root/.codex/skills`），缺少：

- 平台可观测的技能清单与元数据（无法统一搜索/展示/审计）
- 版本化与一致性（多台多 proxy 下容易漂移）
- 明确的“角色/任务 → 技能集合”映射（只能靠运行时临时手工配置）

本次变更的首要目标是落地“全局技能库 + 可扩展搜索接口 + 按项目/角色选择启用”的骨架；下载/上传/挂载/全量更新属于后续迭代，但需要在设计中预留扩展点，避免返工。

约束与假设：

- 多台多 acp-proxy，且 proxy 可以访问 backend HTTP（便于后续分发/缓存技能包）。
- 一期优先做“搜索与管理视图”，不要求运行时立即挂载 skills。
- 平台使用 Postgres（Prisma），前端为 Vite + React 的 Admin 页分区。

## Goals / Non-Goals

**Goals:**

- 建立平台级 Skill Registry 的数据模型（skills/versions/来源/标签等最小字段），支撑管理后台展示与后续版本化/导入/更新。
- 定义一个稳定的、可扩展 provider 的“技能搜索接口”，一期实现 `registry` provider（搜索本地入库技能）。
- 在管理后台增加 Skills 分区：支持关键词搜索、筛选与详情查看（含版本与来源信息）。
- 支持“按项目/角色启用 skills”的配置：RoleTemplate 维度维护启用项，为未来运行时加载提供依据。

**Non-Goals:**

- 一期不做：从外部网站实时抓取搜索结果（只定义 provider 接口形态，后续实现）。
- 一期不做：zip 上传导入、git 镜像拉取、全量更新任务、回滚发布流程（但数据模型与 API 需可扩展）。
- 一期不做：运行时自动挂载/分发 skills 到 agent（仅落地“可配置的启用关系”与“可搜索的 registry”）。
- 不允许 skills 内容触发任何自动执行命令；展示/存储均按“不可信内容”处理。

## Decisions

### 1) 搜索接口采用 Provider 化，但一期只实现 `registry`

**Decision**

- 新增统一接口：`GET /api/admin/skills/search`
- 通过 `provider` 参数选择实现（默认 `registry`），返回稳定结构。

**Rationale**

- 先把前后端契约定住，后续接入 `skills_sh` / `github` / `custom_http` 等 provider 时不需要改 UI/调用方。
- 多 proxy 场景下，运行时更应该依赖“平台真源 + 分发缓存”，而不是 agent 直接联网搜；provider 机制既能支撑“外部源搜索”，也能支撑“导入/索引后搜索”。

**Alternatives**

- 直接做 `GET /skills`：简单但难以演进到多来源搜索；后期必然破坏接口或重复造轮子。

### 2) 平台技能库使用“Skill + SkillVersion”模型，RoleTemplate 通过绑定表启用

**Decision**

- 新增核心表（命名可在实现阶段微调）：
  - `Skill`：全局技能元数据（`name`/`description`/`tags`/`createdAt`/`updatedAt` 等）
  - `SkillVersion`：版本记录（`skillId` + `contentHash` + `storageUri` + `importedAt` 等）
  - `RoleSkillBinding`：`roleTemplateId` 关联到 `skillId` 或 `skillVersionId`，并带 `versionPolicy`（`latest`/`pinned`）与启用状态

**Rationale**

- “全局一套技能库”与“按项目/角色决定使用加载”天然是“平台资源”与“租户配置”的分层；RoleTemplate 已经是项目配置入口，绑定表最贴合现有模型（`Step.roleKey → RoleTemplate.key`）。
- `SkillVersion` 为后续“全量更新/回滚/审计”提供基础；即使一期不做导入，也应避免将来重建数据模型。

**Alternatives**

- 直接把 skills 列表塞进 `RoleTemplate.envText` 或新增 JSON 字段：实现快但不可查询、不可版本化、难审计，且不利于未来分发与回滚。

### 3) “启用关系”只影响平台配置与可观测性；运行时挂载留作后续能力

**Decision**

- 一期只实现：查询/编辑 RoleTemplate 对应启用的 skills（供后续执行链路消费）。
- 不在一期改动 acp-proxy/agent 启动行为（避免引入跨节点一致性与安全面扩大）。

**Rationale**

- 多 proxy + 多运行时环境下，挂载链路涉及缓存、分发、权限、审计、以及对 agent 进程环境变量/只读卷挂载的控制，需要单独设计与验证。

**Alternatives**

- 一期就做按 run 挂载：短期能“看到效果”，但会把分发/缓存/安全问题一次性引入，风险过高。

### 4) 后续“按 run 挂载”预留点：通过 proxy 拉取 + 本地缓存 + 白名单 env 透传

**Decision（预留）**

- 后续实现方向：backend 计算该 run 需要的 `skillVersionIds` → 下发给 acp-proxy → proxy 从 backend 拉取并缓存 skill 包 → 生成 run 专用 `CODEX_HOME/skills` 视图目录（只读）→ 启动 agent 时仅透传白名单 env（至少 `CODEX_HOME`）。

**Rationale**

- 多台 proxy 下必须避免“后台写本地磁盘、每台不一致”的问题；proxy 侧拉取与缓存是最自然的分发路径。
- 目前 `host_process` 启动 agent 未透传 `init.env`，后续必须以“白名单 env”方式补齐，否则既做不到按 run 设置 `CODEX_HOME`，也会有泄露敏感 env 的风险。

**Alternatives**

- 共享文件系统/NFS：实现上可行但运维复杂、跨平台差异大；仍需要版本/审计。
- agent 运行时联网安装：不稳定、不可控、合规风险高（明确不采纳）。

## Risks / Trade-offs

- [搜索结果质量不足（仅 registry）] → 一期明确为“已入库技能搜索”；在 UI 上标注 provider，并预留接入外部 provider 的入口。
- [数据模型过早设计导致返工] → 采取最小字段集 + 预留扩展字段（如 `metadata Json?`）的策略；版本/分发相关字段先定义但不强依赖。
- [未来挂载需要修改 acp-proxy] → 设计中提前识别该风险；后续以“白名单 env 透传 + proxy 缓存”作为明确路线，减少不确定性。
- [技能内容不可信导致 XSS/注入] → 后端存储仅当作文本/二进制，不执行；前端展示使用安全渲染（markdown 需严格 sanitize 或纯文本展示）。
- [多 proxy 一致性与回滚复杂] → 后续引入“发布策略”（latest/pinned）、审计记录与候选版本，不在一期强行解决。

## Migration Plan

1. 增加 Prisma 数据模型与迁移（创建 Skill/SkillVersion/RoleSkillBinding 等表）。
2. 后端新增 Admin 接口：
   - `/api/admin/skills/search`（provider=registry）
   - skills 详情/版本列表接口（用于详情页展示）
   - RoleTemplate 的 skills 绑定读写接口（可独立路由或扩展 role routes）
3. 前端 Admin 新增 Skills 分区：
   - 搜索框 + 过滤项
   - 列表与详情抽屉/页面
   - 角色配置页增加“启用 skills”编辑能力（可放在 RolesSection 中）
4. 灰度与回滚：
   - 回滚代码即可停用新功能；新表不影响既有业务。
   - 接口需保持向后兼容（新增字段不破坏旧 UI）。

## Open Questions

- Skill 的唯一标识采用什么：`name`（kebab-case）作为全局唯一，还是单独 `id` + `name` 可重复？（倾向：`id` 唯一，`name` 全局唯一约束，便于引用与搜索）
- tags 的存储形式：`string[]` vs `Json`；以及是否需要为标签/名称建立索引以支持更大规模的查询。
- RoleSkillBinding 绑定到 `skillId` 还是 `skillVersionId`：
  - `skillId + versionPolicy` 更灵活（latest/pinned）
  - 纯 `skillVersionId` 更严格（每次都显式选择版本）
- provider 的扩展机制：
  - 外部 provider 的结果是否允许“临时结果”（不入库）？
  - 是否需要“导入/索引”流程才能进入 registry？
