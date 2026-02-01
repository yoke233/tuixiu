# runtime-skill-mounting

## Purpose

定义平台运行时技能挂载（backend → acp-proxy）的开关、manifest 下发与代理侧缓存/挂载/清理行为（TBD）。

## Requirements

### Requirement: Skills manifest can be applied without repo initialization
系统 SHALL 允许在无仓库初始化模式下仍下发并挂载技能包（skillsManifest），技能挂载与 workspace 初始化逻辑相互独立。

#### Scenario: Skills available in empty workspace policy
- **WHEN** workspacePolicy 为 `empty` 且角色绑定技能
- **THEN** skillsManifest 仍被下发并在运行时可用

### Requirement: Skills are visible within workspace
系统 SHALL 确保已挂载的技能包在 workspace 内可见，以便审查类角色进行列举与检查。

#### Scenario: Reviewer can list skills inside workspace
- **WHEN** workspacePolicy 为 `empty` 且技能挂载完成
- **THEN** workspace 内存在可列举的技能目录或索引文件

### Requirement: 运行时技能挂载灰度开关
系统 SHALL 支持以灰度开关控制运行时技能挂载是否启用，满足：

- 项目级开关 `enableRuntimeSkillsMounting` 与 proxy 侧开关 `skillsMountingEnabled` MUST 同时为真时，运行时技能挂载才生效
- 当任一开关为假时，系统 MUST 不下发/不执行 skills 挂载，并以“无挂载”方式启动 agent（不依赖平台 skills）

#### Scenario: 任一开关关闭时不执行挂载
- **WHEN** 某 run 所属项目未开启 `enableRuntimeSkillsMounting`
- **THEN** 系统不对该 run 执行 skills 挂载

### Requirement: run 初始化时下发 skills manifest
当运行时技能挂载启用时，backend MUST 在 run 初始化时向 acp-proxy 提供 skills manifest，满足：

- manifest MUST 包含 `runId`
- manifest MUST 包含 `skillVersions[]`
- `skillVersions[]` 的每一项 MUST 至少包含：`skillId`、`skillName`、`skillVersionId`、`contentHash`、`storageUri`
- backend MUST 将角色启用配置中的 `latest/pinned` 解析为具体的 `skillVersionId`；若无法解析（例如 latest 未发布、pinned 不存在）则 MUST 失败并给出明确错误

#### Scenario: 启用挂载时下发 manifest
- **WHEN** 运行时技能挂载启用，且该 run 的角色启用了至少一个 skill
- **THEN** backend 向 acp-proxy 下发的 manifest 中包含这些 skills 的 `skillVersionId/contentHash/storageUri`

### Requirement: acp-proxy 按 contentHash 拉取并缓存技能包
acp-proxy SHALL 依据 manifest 拉取并缓存技能包，满足：

- 对每个 `skillVersionId`，acp-proxy MUST 确保对应 `contentHash` 的技能包已在本地缓存可用
- 缓存 MUST 以 `contentHash` 为键进行去重；当缓存命中时，acp-proxy MUST 复用缓存而不重复下载
- 下载完成后，acp-proxy MUST 校验内容与 `contentHash` 一致；校验失败 MUST 视为错误

#### Scenario: 缓存命中时不重复下载
- **WHEN** acp-proxy 已缓存某个 `contentHash` 的技能包且后续 run 复用该版本
- **THEN** acp-proxy 复用缓存并跳过再次下载

### Requirement: acp-proxy 生成 run 专用只读 CODEX_HOME/skills 视图
acp-proxy SHALL 为每个 run 生成专用的只读 skills 视图目录，满足：

- acp-proxy MUST 为每个 run 创建独立的 `CODEX_HOME` 目录，并在其中创建 `skills/`
- `CODEX_HOME/skills/` 下 MUST 为每个启用的 skill 创建一个子目录，目录名 SHOULD 使用平台 `skillName`（kebab-case）
- skill 子目录内 MUST 包含该 skill 的 `SKILL.md`（及其随包文件），且 agent 在运行时不得修改其内容（只读视图）

#### Scenario: run 视图目录包含 skills
- **WHEN** acp-proxy 为某 run 完成技能挂载准备
- **THEN** 该 run 的 `CODEX_HOME/skills/` 下存在每个启用 skill 的目录且包含 `SKILL.md`

### Requirement: 仅透传 env allowlist 并设置 CODEX_HOME
acp-proxy MUST 通过 env 白名单启动 agent 并注入 `CODEX_HOME`，满足：

- acp-proxy MUST 将该 run 的 `CODEX_HOME` 通过环境变量 `CODEX_HOME` 传递给 agent
- acp-proxy MUST 仅透传 env allowlist 中的变量（allowlist 至少包含 `CODEX_HOME`），不得透传未显式允许的环境变量

#### Scenario: 非白名单环境变量不被透传
- **WHEN** 宿主环境存在某个未加入 allowlist 的环境变量
- **THEN** agent 进程环境中不包含该变量

### Requirement: skills 准备失败会阻止 agent 启动
当任一 required skill 无法成功准备（下载失败、hash 校验失败、解压失败等）时：

- acp-proxy MUST 使该 run 启动失败并给出明确失败原因
- acp-proxy MUST NOT 启动 agent（避免在不完整的 skills 集合下运行）

#### Scenario: 下载失败导致 run 启动失败
- **WHEN** acp-proxy 无法从 `storageUri` 获取某个 required skill 包
- **THEN** 该 run 启动失败且 agent 未被启动

### Requirement: run 结束后清理挂载目录
acp-proxy SHALL 清理 run 专用目录以控制磁盘占用，满足：

- run 结束后，acp-proxy MUST 删除该 run 的 `CODEX_HOME` 视图目录，或在可配置 TTL 内完成清理

#### Scenario: run 结束后目录被清理
- **WHEN** 某 run 已结束
- **THEN** 在 TTL 内该 run 的 `CODEX_HOME` 视图目录被删除

