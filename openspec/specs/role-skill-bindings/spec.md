# role-skill-bindings

## Purpose

在 Project 的 RoleTemplate 维度维护“启用的 skills”配置，为后续运行时按角色加载 skills 集合提供依据（TBD：与运行时挂载/分发/版本发布策略对接）。

## Requirements

### Requirement: 角色维度的技能启用配置
系统 SHALL 支持在 Project 的 RoleTemplate 维度配置“启用的 skills”，满足：

- 绑定关系 MUST 隶属于某个 `projectId` 且指向该项目下的 `roleTemplateId`
- 每条绑定 MUST 指向一个平台 Skill（通过 `skillId`）
- 绑定 MUST 支持 `versionPolicy`（至少 `latest` 与 `pinned`）
- 当 `versionPolicy=pinned` 时，绑定 MUST 指定 `pinnedVersionId`
- 当 `versionPolicy=latest` 时，绑定 MUST 不指定 `pinnedVersionId`（或其值为 `null`）
- 删除 RoleTemplate 时，其绑定关系 SHOULD 被级联删除

#### Scenario: 为某个角色启用多个技能
- **WHEN** 管理员为某 Project 的某个 RoleTemplate 保存启用的 skill 列表
- **THEN** 系统记录这些启用关系，并在后续读取时返回相同集合（包含 `versionPolicy` 与 `pinnedVersionId`）

### Requirement: 读取角色启用技能列表接口
系统 SHALL 提供管理员接口读取某个 RoleTemplate 的技能启用配置，满足：

- 接口路径 MUST 为 `GET /api/admin/projects/:projectId/roles/:roleId/skills`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 当 `projectId` 或 `roleId` 不存在时 MUST 返回业务错误（错误码 `NOT_FOUND`，HTTP status=200；鉴权失败除外）
- 返回体 MUST 至少包含 `roleId/projectId/items[]`
- 每个 item MUST 至少包含 `skillId/name/versionPolicy`
- 当 `versionPolicy=pinned` 时，item MUST 包含 `pinnedVersionId`
- 当 `versionPolicy=latest` 时，item MUST 不包含 `pinnedVersionId`（或其值为 `null`）

#### Scenario: 读取空配置
- **WHEN** 管理员读取一个尚未配置任何技能的 RoleTemplate
- **THEN** 系统返回 `items=[]`

#### Scenario: 读取 pinned 版本信息
- **WHEN** 管理员读取一个包含 `versionPolicy=pinned` 的 RoleTemplate 配置
- **THEN** 返回的对应 item 包含非空 `pinnedVersionId`

### Requirement: 写入角色启用技能列表接口（原子替换）
系统 SHALL 提供管理员接口写入某个 RoleTemplate 的技能启用配置，满足：

- 接口路径 MUST 为 `PUT /api/admin/projects/:projectId/roles/:roleId/skills`
- 写入语义 MUST 为“原子替换”（以请求体为准覆盖既有配置）
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 请求体每个 item MUST 指定 `skillId` 与 `versionPolicy`
- 当 `versionPolicy=pinned` 时，item MUST 指定 `pinnedVersionId`
- 当 `versionPolicy=latest` 时，item MUST 不指定 `pinnedVersionId`（或其值为 `null`）
- 若请求体引用了不存在的 `skillId` MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）
- 若 `versionPolicy=latest` 但该 Skill 未发布 `latestVersionId`，系统 MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）

#### Scenario: 原子替换生效
- **WHEN** 管理员先保存技能集合 A，再保存技能集合 B
- **THEN** 再次读取时系统返回的集合 MUST 等于 B（不包含 A 中被移除的技能）

#### Scenario: latest 未发布时拒绝保存
- **WHEN** 管理员提交 `versionPolicy=latest` 且该 Skill 的 `latestVersionId` 为空
- **THEN** 系统返回业务错误且错误码为 `BAD_INPUT`

### Requirement: versionPolicy 基本校验
当绑定条目指定 `versionPolicy=pinned` 时，系统 MUST 验证其引用的版本信息一致性（至少保证“存在且属于该 skill”），否则 MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）。

此外：

- 当 `versionPolicy=pinned` 时，`pinnedVersionId` MUST 存在且指向该 `skillId` 下的某个 SkillVersion
- 当 `versionPolicy=latest` 时，系统 MUST 能将其解析为该 Skill 的 `latestVersionId`（非空且指向有效版本），否则 MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）

#### Scenario: pinned 版本不属于该 skill
- **WHEN** 管理员提交 `versionPolicy=pinned` 且 `pinnedVersionId` 指向另一个 skill 的版本
- **THEN** 系统返回业务错误且错误码为 `BAD_INPUT`

#### Scenario: pinned 缺少 pinnedVersionId
- **WHEN** 管理员提交 `versionPolicy=pinned` 但未提供 `pinnedVersionId`
- **THEN** 系统返回业务错误且错误码为 `BAD_INPUT`

#### Scenario: latest 无法解析为有效版本
- **WHEN** 管理员提交 `versionPolicy=latest` 且该 Skill 的 `latestVersionId` 为空或无效
- **THEN** 系统返回业务错误且错误码为 `BAD_INPUT`

### Requirement: 角色技能启用配置变更审计
系统 SHALL 记录 RoleTemplate 的技能启用配置变更审计，满足：

- 每次对 `PUT /api/admin/projects/:projectId/roles/:roleId/skills` 的成功写入，系统 MUST 记录审计事件
- 审计事件 MUST 包含 `actor`（管理员身份）、`projectId`、`roleId`、时间戳，以及变更前后 `items[]` 的差异信息（至少能还原 from/to）

#### Scenario: 写入成功会产生审计记录
- **WHEN** 管理员成功更新某 RoleTemplate 的 skills 启用配置
- **THEN** 系统新增一条审计记录并关联该 `projectId/roleId`

### Requirement: API 响应封装一致性
Role-Skill-Bindings 相关接口 SHALL 统一使用 API Envelope：

- 成功：`{ success: true, data: <payload> }`
- 失败：`{ success: false, error: { code: string, message: string, details?: unknown } }`

#### Scenario: 成功响应结构
- **WHEN** 任一 Role-Skill-Bindings 接口成功返回
- **THEN** 响应 MUST 为 JSON 且包含 `success: true` 与 `data`
