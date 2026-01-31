# skill-search

## Purpose

提供统一的技能搜索接口（Provider 化），一期聚焦平台已入库技能（`registry` provider）。后续可扩展外部来源搜索与导入索引能力（TBD）。

## Requirements

### Requirement: 统一技能搜索接口（Provider 化）
系统 SHALL 提供统一的技能搜索接口，满足：

- 接口路径 MUST 为 `GET /api/admin/skills/search`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 接口 MUST 支持 `provider` 查询参数用于选择搜索提供方
- 当 `provider` 为空时，系统 MUST 使用默认 provider（`registry`）
- 当 `provider` 不受支持时，系统 MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）

#### Scenario: 未指定 provider 时使用默认值
- **WHEN** 管理员请求 `/api/admin/skills/search` 且不传 `provider`
- **THEN** 系统以 `registry` provider 执行搜索并返回结果

### Requirement: 搜索参数与分页
搜索接口 SHALL 支持以下查询参数（最小集合），并保证向后兼容：

- `q`：可选关键词；空/缺省表示无关键词过滤
- `tags`：可选标签过滤（逗号分隔）；当提供时结果 MUST 至少匹配其中一个 tag
- `limit`：可选，默认 50；系统 MUST 施加上限（例如 200）以防止过大响应
- `cursor`：可选游标；用于分页（provider 不支持时可忽略，但响应 MUST 给出 `nextCursor: null`）

#### Scenario: limit 超出上限时被截断
- **WHEN** 管理员请求并传入过大的 `limit`
- **THEN** 系统返回的 `items.length` MUST 不超过系统上限

### Requirement: registry provider 的匹配规则
当 `provider=registry` 时，系统 MUST 从平台 Skill Registry 中检索技能，并满足：

- `q` 为非空时：系统 MUST 以大小写不敏感方式在 `name/description` 中做包含匹配；`tags` 以数组元素精确匹配（任一字段命中即可）
- `q` 为空时：系统 MUST 返回按稳定顺序排序的技能列表（例如按 `name` 升序或 `updatedAt` 倒序；实现需稳定）
- `tags` 过滤与 `q` 过滤 MUST 同时生效（交集）

#### Scenario: 关键词命中 Skill 名称
- **WHEN** 管理员使用 `q` 搜索，且某 Skill 的 `name` 包含该关键词
- **THEN** 该 Skill MUST 出现在搜索结果中

### Requirement: 搜索结果结构稳定
搜索接口返回的 `data` MUST 具备稳定结构，至少包含：

- `items: SkillSearchItem[]`
- `nextCursor: string | null`
- `provider: string`（实际执行的 provider）

其中 `SkillSearchItem` MUST 至少包含：

- `skillId: string`
- `name: string`
- `description: string | null`
- `tags: string[]`
- `installed: boolean`（`registry` provider MUST 为 `true`）
- `latestVersion?: { versionId: string, contentHash: string, importedAt: string } | null`

#### Scenario: registry provider 的 installed 字段
- **WHEN** 管理员使用 `provider=registry` 搜索
- **THEN** 每个结果项的 `installed` MUST 为 `true`

### Requirement: 空结果
当没有任何匹配项时，系统 MUST 返回空列表且不报错。

#### Scenario: 无匹配项返回空列表
- **WHEN** 管理员使用一个不存在的关键词搜索
- **THEN** 系统返回 `items=[]` 且 `nextCursor=null`

