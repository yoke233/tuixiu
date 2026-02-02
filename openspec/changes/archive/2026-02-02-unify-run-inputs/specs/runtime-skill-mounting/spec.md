# runtime-skill-mounting

## REMOVED Requirements

### Requirement: acp-proxy 生成 run 专用只读 CODEX_HOME/skills 视图
**Reason**: 系统改为以 `USER_HOME`（沙盒内 `~`）作为唯一 home 语义，并取消 `CODEX_HOME` 这一额外抽象与兼容层；skills 目录直接以 `USER_HOME` 下的约定路径对 agent 可见。

**Migration**: 将原先依赖 `CODEX_HOME/skills` 的检查与文档，迁移为使用 codex/codex-acp 默认约定 `~/.codex/skills`（或等价的 `USER_HOME/.codex/skills`）。

### Requirement: 仅透传 env allowlist 并设置 CODEX_HOME
**Reason**: 取消 `CODEX_HOME` 注入后，不再需要以 `CODEX_HOME` 作为技能目录定位方式；skills 目录通过 `USER_HOME`（即 `~`）可发现。

**Migration**: 移除对 `CODEX_HOME` 环境变量的依赖；若需要可观测性，可在 init/env 中提供 `USER_HOME`（或依赖标准 `HOME`）并在 runbook 中说明。

## ADDED Requirements

### Requirement: acp-proxy 生成 run 专用 skills 目录于 USER_HOME
acp-proxy SHALL 为每个 run 在 `USER_HOME` 下生成技能目录，满足：

- acp-proxy MUST 为每个 run 准备 `USER_HOME/.codex/skills/`
- `USER_HOME/.codex/skills/` 下 MUST 为每个启用的 skill 创建一个子目录，目录名 SHOULD 使用平台 `skillName`（kebab-case）
- skill 子目录内 MUST 包含该 skill 的 `SKILL.md`（及其随包文件）

#### Scenario: run 目录包含 skills
- **WHEN** acp-proxy 为某 run 完成技能挂载准备
- **THEN** `USER_HOME/.codex/skills/` 下存在每个启用 skill 的目录且包含 `SKILL.md`

### Requirement: Agent can discover skills under USER_HOME without CODEX_HOME
系统 SHALL 不要求注入 `CODEX_HOME` 环境变量；agent MUST 能通过 `USER_HOME`（即 `~`）定位技能目录约定。

#### Scenario: Agent locates skills via home directory
- **WHEN** agent 在沙盒内需要列举已挂载技能
- **THEN** agent 可通过 `~/.codex/skills` 列举技能目录

### Requirement: Skills path is stable under bwrap user view
当 provider 为 `bwrap` 且 `USER_HOME` 由绑定 home 目录与 `HOME` 环境变量共同确定时，系统 MUST 保证 skills 目录约定仍成立。

#### Scenario: Skills visible via ~ in bwrap
- **WHEN** provider 为 `bwrap` 且 agent 的 `HOME` 指向其绑定 home 目录
- **THEN** `~/.codex/skills` 指向实际的 skills 目录并可被列举
