## Why

当前项目的 skills 主要以本地目录形式存在（例如各节点的 `.codex/skills` / `.agents/skills`），缺少一个可管理、可搜索、可审计的“全局真源”。在多台多 proxy 的部署下，skills 的分发与版本一致性容易漂移，且运行时临时联网安装不利于稳定性与合规。

我们需要一个平台级 Skill Registry，把 skills 当作可版本化的资源包管理，并提供管理后台的统一搜索入口，让每个项目/角色可以选择启用哪些 skills，为后续的下载/挂载/全量更新打好基础。

## What Changes

- 新增平台级 Skill Registry：存储技能元数据、来源信息、版本记录（hash/时间/引用），作为全局 skills 的“真源”。
- 新增统一的技能搜索接口：定义可扩展的 provider 机制；一期先实现 `registry` provider（搜索已安装/已入库的技能），并保持接口形态稳定以便后续接入外部网站/源。
- 新增管理后台 Skills 分区：支持关键词/标签等条件搜索、查看技能详情与版本信息（一期不做上传导入与分发）。
- 新增“按项目/角色启用技能”的配置能力：在 Project 的 RoleTemplate 维度维护启用的 skills（以及版本策略如 latest/pinned 的扩展位），用于决定该角色运行时可加载的 skills 集合。

## Capabilities

### New Capabilities

- `skill-registry`: 全局技能库与版本/来源元数据（供搜索与后续导入/更新/回滚使用）
- `skill-search`: 统一技能搜索 API（provider 可扩展；一期实现 `registry` provider）
- `role-skill-bindings`: 项目/角色维度的技能启用配置（决定运行时可加载的 skills 集合）

### Modified Capabilities

<!-- 无：目前 openspec/specs 下没有既有 capability，需要新增为主 -->

## Impact

- Backend：新增 Prisma 数据模型与迁移；新增 `/api/admin` 下的 skills 搜索与管理接口；扩展 RoleTemplate 的技能启用配置读写。
- Frontend：新增 Admin Skills 分区与基础交互（搜索/详情/版本展示）。
- Runtime（acp-proxy / agent）：一期仅落地配置与搜索，不改变 agent 行为；后续要实现“按 run 挂载 skills”需要补齐 proxy 侧的分发/缓存与安全的 env 白名单透传机制。
