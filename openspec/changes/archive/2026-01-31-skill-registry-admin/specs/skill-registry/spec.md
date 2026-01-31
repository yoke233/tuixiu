## ADDED Requirements

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
