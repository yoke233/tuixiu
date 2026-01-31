## 1. 数据模型与迁移

- [x] 1.1 明确外部来源标识：`sourceType=skills.sh` 与 `sourceKey=<owner>/<repo>@<skill>`
- [x] 1.2 Prisma：补齐 `Skill.sourceType/sourceKey/latestVersionId`（及必要索引/唯一约束）
- [x] 1.3 Prisma：补齐 `SkillVersion.sourceRevision/packageSize/manifestJson`（如本期需要）
- [x] 1.4 Prisma：补齐 `RoleSkillBinding.versionPolicy/pinnedVersionId` 约束（含校验所需索引）
- [x] 1.5 Prisma：新增 `SkillAuditLog`（import/update/publish/bind-change 等事件）
- [x] 1.6 生成并应用 DB migration（含回滚验证）

## 2. skills.sh 搜索 Provider（基于 `npx skills find`）

- [x] 2.1 Backend：扩展 `GET /api/admin/skills/search` 支持 `provider=skills.sh`
- [x] 2.2 Backend：实现 `npx skills` runner（固定 `skills@<pinnedVersion>`、timeout、NO_COLOR、独立 cwd）
- [x] 2.3 Backend：解析 `skills find` 输出（仅从 `https://skills.sh/<owner>/<repo>/<skill>` 提取信息）
- [x] 2.4 Backend：生成标准化结果字段：`sourceType/sourceKey/sourceRef` + 派生 `githubRepoUrl/skillDir`（若输出结构支持）
- [x] 2.5 Backend：计算导入状态（按 `(sourceType, sourceKey)` 命中平台 Skill），并填充 `installed/skillId/latestVersion`
- [x] 2.6 Backend：对 `q` 为空直接返回空结果；限制 `limit` 上限；`cursor`/`nextCursor` 按规范返回
- [x] 2.7 Frontend：Skills 页 provider 下拉增加 `skills.sh`，展示 skills.sh/GitHub 链接与导入状态

## 3. 导入管线（`npx skills add` → 打包入库 → SkillVersion）

- [x] 3.1 Backend：新增 `POST /api/admin/skills/import`（支持 `dry-run/new-skill/new-version`）
- [x] 3.2 Backend：`provider=skills.sh` 导入：在临时工作目录执行 `npx skills add <sourceKey> -y`（project scope）
- [x] 3.3 Backend：定位安装产物 `./.agents/skills/<skill>/` 并校验 `SKILL.md` 存在
- [x] 3.4 Backend：解析 `SKILL.md` 元信息（name/description/tags 等）并对展示渲染做 sanitize
- [x] 3.5 Backend：计算 `contentHash`（基于文件序列，避免打包元数据导致不稳定）
- [x] 3.6 Backend：幂等处理：同 Skill 下相同 `contentHash` 不重复创建 SkillVersion
- [x] 3.7 Backend：打包技能目录为 zip 并写入存储，生成 `storageUri`
- [x] 3.8 Backend：写入/更新 `Skill` 与新增 `SkillVersion`，并记录 `SkillAuditLog(action=import)`
- [x] 3.9 Frontend：skills.sh 搜索结果支持“一键导入/导入新版本”，并展示导入结果

## 4. 版本策略（latest / pinned）与角色绑定补齐

- [x] 4.1 Backend：读取角色启用 skills 接口返回 `pinnedVersionId`（当 `versionPolicy=pinned`）
- [x] 4.2 Backend：写入接口校验：`pinnedVersionId` 存在且属于该 `skillId`
- [x] 4.3 Backend：写入接口校验：`versionPolicy=latest` 时该 Skill 已发布 `latestVersionId`
- [x] 4.4 Frontend：Role 绑定 UI 增加 `latest/pinned` 切换与 pinned 版本选择器
- [x] 4.5 Backend：记录 Role bindings 变更审计（bind-change）

## 5. 更新检查与更新（平台版 check/update）

- [x] 5.1 Backend：新增 `POST /api/admin/skills/check-updates`（任务化或同步 MVP）
- [x] 5.2 Backend：对 `skills.sh` 来源实现“试装/dry-run 导入”计算候选 `contentHash` 并与当前版本对比
- [x] 5.3 Backend：新增 `POST /api/admin/skills/update` 支持批量导入新版本
- [x] 5.4 Backend：支持可选 `publishLatest=true`（默认 false），并记录 `publish-latest/rollback-latest` 审计
- [x] 5.5 Frontend：提供更新检查/批量更新入口与确认（默认不自动发布 latest）

## 6. 运行时挂载 MVP（Backend → acp-proxy）

- [x] 6.1 Backend：增加项目级开关 `enableRuntimeSkillsMounting`（读取/写入/默认关闭）
- [x] 6.2 Backend：run 初始化时解析角色启用配置（latest/pinned → skillVersionIds）并下发 `skillsManifest`
- [x] 6.3 Backend：提供 skill 包下载能力（proxy 可访问、鉴权、带缓存头；或签名 URL）
- [x] 6.4 acp-proxy：新增 `skillsMountingEnabled` 配置开关（默认关闭）
- [x] 6.5 acp-proxy：按 `contentHash` 下载并缓存技能包，校验 hash（重试/限流）
- [x] 6.6 acp-proxy：安全解压（防 ZipSlip），并生成 run 专用只读 `CODEX_HOME/skills` 视图
- [x] 6.7 acp-proxy：实现 env allowlist 透传并注入 `CODEX_HOME`（仅记录 key，不记录 value）
- [x] 6.8 acp-proxy：run 结束清理 run 视图目录（TTL 或立即清理）
- [x] 6.9 端到端验证：启用某 skill 后 run 内可见且 agent 生效（开关可回滚）

## 7. 测试与可观测性

- [x] 7.1 Backend：skills.sh provider 搜索单测/路由测试（mock `npx skills` runner）
- [x] 7.2 Backend：导入/更新幂等与校验失败测试（含审计落库）
- [x] 7.3 acp-proxy：缓存命中、解压安全、env allowlist 的单测/集成测试
- [x] 7.4 增加关键日志/指标：下载失败率、缓存命中率、挂载耗时、导入失败原因
- [x] 7.5 文档补充：skills.sh provider、导入/更新策略、运行时挂载开关与排障
