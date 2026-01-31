# skill-search

## Purpose

提供统一的技能搜索接口（Provider 化），支持平台已入库技能（`registry` provider）与外部来源（`skills.sh` provider）。

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

### Requirement: 支持 skills.sh provider 搜索
系统 SHALL 在技能搜索接口中支持 `skills.sh` 作为外部 provider，满足：

- `GET /api/admin/skills/search` 的 `provider` 查询参数 MUST 支持值 `skills.sh`
- 当 `provider=skills.sh` 且 `q` 为空/缺省时，系统 MUST 返回 `items=[]` 且 `nextCursor=null`（避免触发无关键词的外部全量搜索）
- 当 `provider=skills.sh` 且 `q` 非空时，系统 MUST 基于 `q` 返回候选 skills（以 skills.sh 的 `<owner>/<repo>/<skill>` 为定位信息），并返回标准化结果
- 系统 MUST 对外部搜索请求施加 `limit` 上限（与 `registry` provider 一致）

#### Scenario: skills.sh provider 在有关键词时返回标准化结果
- **WHEN** 管理员请求 `/api/admin/skills/search?provider=skills.sh&q=skill`
- **THEN** 系统返回 `provider="skills.sh"` 且 `items[]` 中每个 item 至少包含规范字段（`skillId/name/description/tags/installed`）

### Requirement: 外部 provider 结果包含来源标识与导入状态
当 `provider` 为外部来源（例如 `skills.sh`）时，每个 `items[]` 结果项 MUST 额外包含：

- `sourceType: string`（例如 `skills.sh`）
- `sourceKey: string`（该来源下的唯一标识；用于去重与导入前置检查）
- `sourceRef: string`（人类可读的引用；例如 skills.sh URL）
- `sourceRevision?: string | null`（可选；例如 commit SHA；若获取不到可为空）

并且系统 MUST 以平台 Registry 为真源判断导入状态：

- 若平台中存在匹配 `(sourceType, sourceKey)` 的 Skill，则该结果项 MUST 设 `installed=true` 且 `skillId` MUST 为该 Skill 的平台 `skillId`
- 若平台中不存在匹配 Skill，则该结果项 MUST 设 `installed=false` 且 `latestVersion` MUST 为 `null`

#### Scenario: 未导入的外部 skill 显示为未安装
- **WHEN** 管理员使用 `provider=skills.sh` 搜索到一个尚未被平台导入的 skill
- **THEN** 返回项包含 `sourceType/sourceKey/sourceRef` 且 `installed=false` 且 `latestVersion=null`

#### Scenario: 已导入的外部 skill 显示为已安装
- **WHEN** 管理员使用 `provider=skills.sh` 搜索到一个已被平台导入的 skill
- **THEN** 返回项 `installed=true` 且 `skillId` 指向平台 Skill，并包含该 Skill 的 `latestVersion` 信息（若已发布）

### Requirement: skills.sh 的 sourceKey/sourceRef 规范化
当 `provider=skills.sh` 时，系统 MUST 将外部候选 skill 的定位信息规范化为可导入/可去重的键，满足：

- `sourceType` MUST 为 `skills.sh`
- `sourceRef` MUST 为 `https://skills.sh/<owner>/<repo>/<skill>` 格式的 URL
- `sourceKey` MUST 为 `<owner>/<repo>@<skill>` 格式的字符串，并且 MUST 与 `sourceRef` 中的 `<owner>/<repo>/<skill>` 一一对应
- `sourceKey` MUST 可直接作为导入输入（例如 `POST /api/admin/skills/import` 的 `sourceRef` 或等价字段），且 SHOULD 可直接用于 CLI 安装（`npx skills add <sourceKey>`）
- 结果项 SHOULD 提供可展示的派生信息（例如 `githubRepoUrl=https://github.com/<owner>/<repo>` 与 `skillDir=skills/<skill>`），以便 UI 展示与导入前置检查

#### Scenario: sourceKey 与 sourceRef 一致且可用于导入
- **WHEN** 管理员使用 `provider=skills.sh` 搜索返回某个结果项，其 `sourceRef=https://skills.sh/acme/repo/my-skill`
- **THEN** 该结果项的 `sourceKey` MUST 为 `acme/repo@my-skill` 且 `sourceType` MUST 为 `skills.sh`
