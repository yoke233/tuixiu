## Context

Phase 1 已落地“平台内 Skill Registry 骨架”：`Skill/SkillVersion/RoleSkillBinding` 数据模型、Admin 管理界面与 API、以及 registry provider 的平台内搜索与角色启用配置。但现状仍缺少关键闭环：

- 外部生态（`skills.sh` / GitHub 仓库里的 `SKILL.md`）无法搜索与导入为平台真源
- 缺少“导入/更新/发布 latest/审计”的版本化运营能力
- 运行时仍不会按 run 挂载 skills（acp-proxy/agent 启动行为未消费平台启用关系）

本次 Phase 2 目标是打通“搜得到 → 导得进 → 管得住 → 用得上”的端到端链路，且保持安全基线：skills 内容按不可信处理，不执行脚本，运行时通过白名单 env 透传使 agent 生效。

关键约束/假设：

- 多 acp-proxy 部署；proxy 可访问 backend（HTTP/WS），便于分发与缓存 skill 包。
- agent 本身不联网、不自安装；平台侧完成导入与版本化，运行时仅消费只读 skills 目录。
- 需要可灰度：项目级开关 + proxy 配置开关；关闭后不影响已入库与角色配置。

## Goals / Non-Goals

**Goals:**

- 接入至少一个外部 provider（优先 `skills.sh`，通过 `npx skills find`），在 UI 与 API 上支持 provider 切换与统一结果 DTO。
- 实现导入管线：外部技能 → 平台 `Skill/SkillVersion`（含来源、指纹、存储 URI、导入时间、审计）。
- 落地版本策略：角色绑定支持 `latest`/`pinned`，并实现对应校验与 UI。
- 实现更新机制 MVP：检查外部新版本、导入新 `SkillVersion`，可选择发布为 `latest`（默认不自动发布）。
- 实现运行时挂载 MVP：backend 下发 skills manifest，proxy 拉取/缓存/挂载到 run 专用 `CODEX_HOME`，并通过 env 白名单透传生效。

**Non-Goals:**

- 不执行外部内容中的脚本/命令；导入与运行时只做拉取、打包、解压与只读挂载。
- 不做复杂发布流水线（审批/多环境 promotion）；只做最小 `latest/pinned` + 审计。
- 不做多存储多活；先实现单一存储适配（本地/对象存储其一），保留演进空间。

## Decisions

### 1) 外部搜索：先落地 `skills.sh` provider（基于 `npx skills find`）

**Decision**

- 在现有 provider 架构上新增 `provider=skills.sh`，支持关键词搜索并返回统一的“候选技能 DTO”（包含 `sourceType/sourceRef/sourceKey`、展示信息、导入状态）。
- 搜索实现优先复用 `skills` CLI 的行为（对应 `npx skills find <query>`），并以 skills.sh URL（`https://skills.sh/<owner>/<repo>/<skill>`）作为解析锚点生成稳定的 `sourceKey=<owner>/<repo>@<skill>`（避免 ANSI/空格导致的解析歧义）。
- UI 增加 provider 下拉：`registry` / `skills.sh`（后续如有必要再补 `github` 等 provider）。

**Rationale**

- `npx skills find` 已经封装了“如何在 skills.sh 生态中发现 skill”的经验，能快速获得接近 skills find 的产品体验，且无需实现 GitHub 搜索/索引。
- 以 `sourceKey=<owner>/<repo>@<skill>` 作为平台内的唯一外部引用，天然对齐后续“导入/更新/审计/去重”的数据模型。

**Alternatives**

- 直接做 `github` provider（GitHub Code Search / org allowlist）：可控性更强，但实现复杂且容易受限流/权限影响；可作为后续增强。

### 2) 导入管线由 backend 完成外部拉取与打包；proxy 仅从 backend 拉取包

**Decision**

- 新增 `POST /api/admin/skills/import`（支持 `dry-run`/导入新技能/导入新版本），由 backend：
  - 根据 `provider + sourceRef/sourceKey` 拉取 skill 根目录内容（不得执行任何脚本）
  - 对 `provider=skills.sh`，导入实现优先复用 `npx skills add <owner>/<repo>@<skill> -y`：在临时工作目录以“project scope”安装，读取生成的 `./.agents/skills/<skill>/` 目录作为 skill 内容根目录，然后打包入库（避免污染 backend 进程工作区与用户全局 `~/.agents/skills`）。
  - 解析 `SKILL.md` 元信息（用于展示；渲染仍需 sanitize）
  - 计算 `contentHash`（建议 `sha256`：对“相对路径 + 文件内容”的规范化序列求 hash，避免 zip 元数据导致 hash 不稳定）
  - 将 skill 目录打包为 zip（或 tar.gz），写入存储并生成 `storageUri`
  - 写入/更新 `Skill`、新增 `SkillVersion`，并记录审计日志
- acp-proxy 不直接访问 GitHub/skills.sh；运行时仅按 `storageUri` 从 backend（或其托管的对象存储）下载，降低外部依赖与安全面。

**Rationale**

- 统一“平台真源”，并使运行时链路可审计、可缓存、可控（避免每台 proxy 自行抓取导致漂移与限流问题）。

**Alternatives**

- proxy 直接拉取 GitHub：实现快但外部依赖更重、难审计、也更难灰度与治理。

### 3) 版本与发布：`SkillVersion` 追加不等于自动发布；`latest` 由显式发布指针控制

**Decision**

- `Skill` 维护 `latestVersionId`（或等价机制），作为“已发布 latest”的显式指针。
- 导入新版本默认只新增 `SkillVersion`，不自动推进 `latestVersionId`；管理员可选择“发布为 latest”或回滚到旧版本。
- `RoleSkillBinding` 采用 `skillId + versionPolicy(latest|pinned) + pinnedVersionId?` 的模型：
  - `latest`：运行时解析为 `Skill.latestVersionId`
  - `pinned`：运行时解析为指定 `SkillVersion`

**Rationale**

- 防止版本漂移影响线上行为；关键角色可固定版本，运营可控推进。

**Alternatives**

- `latest` 直接等于“导入时间最新”：简单但无法表达“导入但不发布”的安全策略，也难回滚。

### 4) 更新检查与批量更新：以 sourceKey 为锚点做“检测 → 导入 → 可选发布”

**Decision**

- 新增 Admin API：
  - `POST /api/admin/skills/check-updates`：按 `Skill.sourceType/sourceKey` 检测外部是否有新版本。对 `skills.sh` 来源，MVP 可通过“dry-run 导入/试装”计算候选 `contentHash`（或同时采集 `sourceRevision`），与当前已导入/已发布版本对比，输出候选更新列表与摘要。
  - `POST /api/admin/skills/update`：对候选更新执行“导入新版本”，并支持显式 `publishLatest=true|false`。
- 长耗时操作以后台任务方式执行（可同步返回 taskId，并在 UI 展示进度/结果/失败原因）。

**Rationale**

- 与 CLI “check/update” 心智一致，但以平台可审计的方式落地；并避免默认自动发布导致的不可控。

### 5) 运行时挂载 MVP：backend 下发 skills manifest；proxy 以 `contentHash` 缓存并生成 run 专用只读视图

**Decision**

- backend 在 run 启动（或下发 init 配置）时，计算该 run 需要的 `skillVersionIds`，并下发 `skillsManifest`：
  - `runId`
  - `skillVersions[]`: `{ skillId, skillName, versionId, contentHash, storageUri }`
  - （可选）`mountHints`：目录布局/兼容信息
- acp-proxy：
  - 按 `contentHash` 下载 zip 并缓存到 `skills-cache/<contentHash>/`
  - 安全解压（防 ZipSlip：拒绝 `..`、绝对路径、符号链接等）
  - 为每个 run 创建 `runs/<runId>/CODEX_HOME/skills/` 视图目录：
    - 优先使用 symlink/junction 指向 cache（节省空间）
    - 不支持时回退复制（copy-on-write 视图）
  - 启动 agent 时通过“env 白名单”设置 `CODEX_HOME=runs/<runId>/CODEX_HOME`
- 灰度开关：
  - 项目级：`enableRuntimeSkillsMounting`
  - proxy 配置：`skillsMountingEnabled`

**Rationale**

- cache 以 `contentHash` 作为全局去重键，天然适配多 run/多 proxy；
- run 视图隔离避免运行时互相影响，并为未来的 run 清理、审计与复现打基础。

**Alternatives**

- 共享磁盘/NFS：运维复杂、跨平台差异大；仍需版本/审计治理。

### 6) env 白名单透传是硬约束：解决“无法按 run 设置 CODEX_HOME”与“敏感 env 泄露”双风险

**Decision**

- acp-proxy 启动 agent 的 env 构造改为“显式 allowlist”，默认只包含运行必需项 + `CODEX_HOME`（以及少量无敏感变量）。
- 允许在 proxy 配置中追加白名单 key（并在日志中输出“透传了哪些 key”，但不输出 value）。

**Rationale**

- 既满足 run 级 `CODEX_HOME`，也避免把宿主机/容器环境中的敏感变量无意带入 agent。

## Risks / Trade-offs

- [skills.sh/CLI 依赖与版本漂移] → 在后端固定 `skills` CLI 版本（例如 `npx skills@<pinnedVersion>`）；对 search/import 做缓存与退避重试；必要时将 CLI 逻辑下沉为可替换的 provider 实现。
- [外部技能目录结构差异大] → 以“`SKILL.md` 所在目录”为 skill 根目录；导入时限制文件数量/总大小，并提供 dry-run 预览打包范围。
- [zip 解压安全与路径穿越] → 严格校验条目路径；仅解压到受控目录；禁止覆盖既有文件；校验解压后 hash（可选）。
- [run 目录膨胀/缓存无界增长] → cache/ run 视图增加 TTL 清理策略；记录引用计数或按 LRU 清理；暴露可观测指标。
- [env 白名单变更可能影响既有行为] → 先以灰度开关启用；默认 allowlist 可配置并提供回滚；对缺失 env 的错误给出明确日志。
- [latest 推进引发行为漂移] → 默认“导入不发布”；对关键角色推荐 pinned；提供 latest 回滚到上一版本能力。

## Migration Plan

1. **DB 迁移**：补充 `Skill/SkillVersion/RoleSkillBinding` 增量字段（`sourceType/sourceKey/latestVersionId/sourceRevision/versionPolicy/pinnedVersionId` 等）并新增审计表（如 `SkillAuditLog`）。
2. **Backend**
   - 扩展 `/api/admin/skills/search`：provider 化支持 `skills.sh`（基于 `npx skills find`）
   - 新增导入/更新相关 API：`import`、`check-updates`、`update`
   - 新增供 proxy 下载 skill 包的内部接口（或对象存储直链/签名 URL 方案）
   - run 启动时下发 `skillsManifest`（仅在开关开启时）
3. **Frontend**
   - Skills 页增加 provider 切换、外部搜索结果展示与“导入/导入新版本”
   - Role 绑定页补齐 `latest/pinned` 与版本选择器
   - 最小化审计/任务结果展示（导入/更新结果可追溯）
4. **acp-proxy**
   - 实现 skill 包下载/缓存/解压与 run 视图生成
   - 实现 env allowlist 透传（含 `CODEX_HOME`）与灰度开关
   - 增加 run 清理与缓存清理策略（可先做手动/定时清理 MVP）
5. **灰度与回滚**
   - 先仅开放外部搜索+导入（不启用运行时挂载）
   - 再对少量项目开启 `enableRuntimeSkillsMounting`；出现问题可随时关闭开关回滚到“无挂载”的 Phase 1 行为

## Open Questions

- `npx skills find` 输出的稳定性与解析策略：是否需要强制 `NO_COLOR=1`，并只从 skills.sh URL 解析 `owner/repo/skill`？
- 后端执行 `npx` 的安全边界：是否需要单独 worker/容器隔离、网络 egress 限制、以及对 CLI 版本做严格 pin？
- `Skill.name` 的来源：优先读取 `SKILL.md` front matter 的 `name`，还是以目录名为准？若冲突如何处理（以平台 name 为准，source 仅作引用）？
- skill 包格式：zip vs tar.gz；以及 `contentHash` 的精确定义（文件序列 hash vs 包字节 hash）。
- 运行时目录布局与跨平台：Windows 下 symlink/junction 权限问题如何兜底（复制策略、只读标记等）。
- 缓存清理策略：按 TTL/LRU/引用计数哪种更合适？是否需要对 run 失败/取消场景做快速清理？
- license/合规字段：是否在导入时解析并展示 License/来源声明（最小实现可先只记录来源 URL 与 revision）。
