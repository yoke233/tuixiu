## ADDED Requirements

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
