# skill-registry

## Purpose

定义平台级 Skill Registry 的元数据与版本记录模型，以及管理员查询接口（用于管理后台展示与后续导入/更新/回滚/挂载能力的基础，TBD）。

## Requirements

### Requirement: Skill 元数据模型
系统 SHALL 在平台级 Skill Registry 中存储 Skill 元数据，并满足：

- `name` MUST 在平台内唯一；`name` SHOULD 为 kebab-case（小写字母/数字/`-`，由导入/写入流程保证）
- `description` SHOULD 支持空值（但搜索与展示时按空字符串处理）
- `tags` SHALL 为字符串数组；tags 的去重/清洗/归一化 SHOULD 由导入/写入流程保证
- 记录 `createdAt` / `updatedAt`

#### Scenario: 管理员读取 Skill 元数据
- **WHEN** 管理员通过接口读取某个 Skill
- **THEN** 系统返回该 Skill 的 `id/name/description/tags/createdAt/updatedAt`

### Requirement: SkillVersion 版本记录模型
系统 SHALL 为 Skill 维护 0..N 个版本记录（SkillVersion），并满足：

- 每个 SkillVersion MUST 关联到一个 Skill
- 每个 SkillVersion MUST 存储 `contentHash`（用于内容去重/一致性校验）
- 每个 SkillVersion MUST 存储 `importedAt`
- 每个 SkillVersion SHOULD 存储 `source` 元数据（例如来源 provider、repo/ref、commit 等），用于审计与追溯
- SkillVersion 记录一旦创建 SHOULD 视为不可变（仅允许追加新版本，不允许覆盖旧版本内容标识）

#### Scenario: 管理员查看 SkillVersion 列表
- **WHEN** 管理员请求某个 Skill 的版本列表
- **THEN** 系统返回按 `importedAt` 倒序排列的 SkillVersion 列表（可为空）

### Requirement: 管理员获取 Skill 详情接口
系统 SHALL 提供管理员接口获取 Skill 详情，满足：

- 接口路径 MUST 为 `GET /api/admin/skills/:skillId`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 若 `skillId` 不存在 MUST 返回业务错误（错误码 `NOT_FOUND`，HTTP status=200；鉴权失败除外）

#### Scenario: 查询不存在的 Skill
- **WHEN** 管理员请求一个不存在的 `skillId`
- **THEN** 系统返回业务错误，错误码为 `NOT_FOUND`

### Requirement: 管理员获取 SkillVersion 列表接口
系统 SHALL 提供管理员接口获取 SkillVersion 列表，满足：

- 接口路径 MUST 为 `GET /api/admin/skills/:skillId/versions`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 若 `skillId` 不存在 MUST 返回业务错误（错误码 `NOT_FOUND`，HTTP status=200；鉴权失败除外）
- 返回体 MUST 使用统一 API Envelope：`{ success: true, data: ... }`

#### Scenario: 查询 Skill 的版本列表（空列表）
- **WHEN** 管理员请求一个存在但尚无版本记录的 Skill 的版本列表
- **THEN** 系统返回 `versions=[]`

### Requirement: API 响应封装一致性
Skill Registry 相关接口 SHALL 统一使用 API Envelope：

- 成功：`{ success: true, data: <payload> }`
- 失败：`{ success: false, error: { code: string, message: string, details?: unknown } }`

#### Scenario: 成功响应结构
- **WHEN** 任一 Skill Registry 接口成功返回
- **THEN** 响应 MUST 为 JSON 且包含 `success: true` 与 `data`

### Requirement: Skill 记录来源标识并支持按来源去重
系统 SHALL 为通过外部 provider 导入的 Skill 记录来源标识，并支持去重，满足：

- Skill MUST 存储 `sourceType`（例如 `skills.sh`）与 `sourceKey`
- 当 `sourceType=skills.sh` 时，`sourceKey` SHOULD 采用 `<owner>/<repo>@<skill>` 的规范格式（与 skills.sh/CLI 安装入参一致）
- 对于 `sourceType/sourceKey` 均非空的 Skill，系统 MUST 保证 `(sourceType, sourceKey)` 在平台内唯一
- 导入流程 MUST 以 `(sourceType, sourceKey)` 作为优先匹配键：若已存在匹配 Skill，则导入 MUST 作为该 Skill 的新版本导入（或幂等命中），而不是创建重复 Skill

#### Scenario: 同一来源的 skill 重复导入不会创建重复 Skill
- **WHEN** 管理员对同一 `sourceType/sourceKey` 执行两次导入
- **THEN** 两次导入返回的 `skillId` MUST 相同

### Requirement: Skill 发布 latest 版本指针
系统 SHALL 支持对 Skill 的版本进行“发布为 latest”，满足：

- Skill MUST 维护 `latestVersionId: string | null`
- 当 `latestVersionId` 非空时，它 MUST 指向该 Skill 的某个 SkillVersion
- 系统 MUST 支持将某个 SkillVersion 设置为 `latestVersionId`，并支持回滚到旧版本
- 对 `latestVersionId` 的变更 MUST 被审计记录（见审计要求）

#### Scenario: 发布某个版本为 latest
- **WHEN** 管理员将某 Skill 的某个 `versionId` 发布为 latest
- **THEN** 随后读取该 Skill 时，返回的 `latestVersionId` 等于该 `versionId`

### Requirement: 管理员导入 skill 形成 SkillVersion（Import Pipeline）
系统 SHALL 提供管理员导入接口，将外部 skill 导入为 Skill/SkillVersion，满足：

- 接口路径 MUST 为 `POST /api/admin/skills/import`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 请求体 MUST 至少包含 `provider` 与 `sourceRef`，并可包含 `mode`：
  - `dry-run`：仅预览与校验，不落库、不写入存储
  - `new-skill` / `new-version`：执行导入（实现可对 mode 做兼容处理）
- 当 `provider=skills.sh` 时，`sourceRef` MUST 至少支持 `<owner>/<repo>@<skill>` 格式字符串
- 导入过程中系统 MUST NOT 执行外部仓库中的任何脚本/命令
- 导入成功时，系统 MUST 计算并保存 `contentHash`、写入 `storageUri`，并创建一个新的 SkillVersion（除非幂等命中）
- 若同一 Skill 下已存在相同 `contentHash` 的版本，导入 MUST 幂等返回已存在的 SkillVersion（不创建重复版本）

#### Scenario: dry-run 不产生版本记录
- **WHEN** 管理员以 `mode=dry-run` 调用导入接口
- **THEN** 系统返回预览信息，但随后查询该 Skill 的版本列表时不包含该次导入产生的新版本

#### Scenario: 重复导入相同内容命中同一版本
- **WHEN** 管理员对同一 Skill 重复导入，且导入内容的 `contentHash` 相同
- **THEN** 两次导入返回的 `skillVersionId` MUST 相同

### Requirement: SkillVersion 包可被运行时拉取
系统 SHALL 为每个 SkillVersion 提供可检索的技能包存储位置，满足：

- 每个 SkillVersion MUST 存储 `storageUri`，指向该版本的技能包（zip 或 tar.gz 等封装形式不限，但 MUST 是不可变内容）
- `storageUri` MUST 可被 acp-proxy 在运行时访问（在启用运行时挂载时）
- 技能包内容 SHOULD 与 `contentHash` 一致；若下载后校验失败，运行时 MUST 视为错误并拒绝使用该包

#### Scenario: 导入后的版本具有可下载的 storageUri
- **WHEN** 管理员成功导入一个 SkillVersion
- **THEN** 返回的 SkillVersion 信息包含非空 `storageUri`

### Requirement: 管理员检查更新（Check Updates）
系统 SHALL 提供管理员更新检查能力，满足：

- 接口路径 MUST 为 `POST /api/admin/skills/check-updates`
- 请求体 SHOULD 支持限定范围（例如按 `skillId[]` 或按 `sourceType`），未指定时表示扫描所有具备外部来源标识的 skills
- 系统 MUST 基于外部来源的 `sourceRef/sourceRevision`（或等价指纹）判断是否存在新版本
- 响应 MUST 返回可更新项列表；若无可更新项 MUST 返回空列表且不报错

#### Scenario: 没有可更新项时返回空列表
- **WHEN** 管理员发起一次更新检查且所有 skills 均无新版本
- **THEN** 系统返回 `items=[]`

### Requirement: 管理员更新（Update）与可选发布 latest
系统 SHALL 提供管理员更新执行能力，满足：

- 接口路径 MUST 为 `POST /api/admin/skills/update`
- 系统 MUST 支持对单个或批量 skill 执行“拉取外部最新版本 → 导入为新 SkillVersion”
- 默认情况下，更新操作 MUST 仅导入新 SkillVersion，不自动推进 `latestVersionId`
- 当请求显式指定 `publishLatest=true`（或等价选项）时，系统 MUST 在导入成功后将该新版本发布为 latest，并记录审计日志

#### Scenario: 默认更新不推进 latest
- **WHEN** 管理员执行更新且未选择发布为 latest
- **THEN** 系统新增 SkillVersion，但该 Skill 的 `latestVersionId` 保持不变

### Requirement: 技能导入/更新/发布的审计日志
系统 SHALL 记录 Skill Registry 的关键操作审计，满足：

- 系统 MUST 为以下操作写入审计记录：import、check-updates、update、publish-latest、rollback-latest
- 每条审计记录 MUST 包含 `actor`（管理员身份）、`action`、`skillId`、时间戳，以及必要的 `sourceType/sourceKey/sourceRevision` 与 `from/to` 版本指针信息（如适用）
- 审计记录 MUST 可被管理员查询（实现可复用现有审计日志通道）

#### Scenario: 导入会产生审计记录
- **WHEN** 管理员成功导入一个 skill 版本
- **THEN** 系统新增一条 `action=import` 的审计记录并关联该 `skillId`
