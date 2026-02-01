## Context

当前 ACP 启动流程在后端与 init 脚本中混合处理 workspace 初始化、git 认证、clone/checkout 和技能挂载，导致“无仓库初始化角色”难以成立（即便想跳过 clone，也会被 repo/branch 校验阻断）。同时技能注入（skillsManifest）与 workspace 初始化耦合，增加了安全审查类角色的实现成本。现有 agent capabilities 已提供 sandbox workspaceMode（git_clone/mount）信号，但缺少业务层策略与继承机制。

## Goals / Non-Goals

**Goals:**
- 提供统一的 workspacePolicy（git/mount/empty/bundle）与继承/覆盖规则，确保工作区始终存在，但初始化来源可配置。
- 解耦 skillsManifest 与 workspace 初始化：无仓库初始化模式下仍可下发并挂载技能。
- 将“策略解析 → 计划下发 → 运行时执行”职责分离，降低 init 脚本复杂度。
- 与 agent capabilities 对齐，确保策略可被运行时能力约束。
- 抽象 Context Workspace、Init Pipeline 与 Execution Profile，形成可扩展的运行框架。

**Non-Goals:**
- 不重新设计技能包格式、存储或分发协议。
- 不引入新的远程执行平台或替换 ACP 通信协议。
- 不在本次变更中实现复杂的多种 workspace source（snapshot/artifact）模式。

## Decisions

- 采用 **Workspace Policy** 作为业务层策略对象（git/mount/empty/bundle），并支持平台默认 → 项目默认 → 角色覆盖 → 任务显式覆盖的优先级。
- 引入 **Context Workspace** 抽象：workspace 视作可组合资源空间，支持多源挂载（repo/skills/datasets/outputs）、读写权限与生命周期设置。
- 引入 **Init Pipeline** 抽象：后端生成动作序列（如 ensure_workspace / mount_skills / init_repo / unpack_bundle），运行时按序执行。
- 引入 **Execution Profile** 抽象：角色引用 profile 作为运行基线（workspace/skills/tool/data 策略集合），平台集中治理与升级。
- 将策略解析与运行时执行分离：后端解析 policy 生成启动计划（init env 与动作），init 脚本仅执行最小动作。
- 对 `empty` 策略：确保工作区存在（空目录），不注入 git env，不生成 repo 相关提示，允许 skillsManifest 正常下发。
- 对 `mount` 策略：保留 workspacePath，但下发 `TUIXIU_SKIP_WORKSPACE_INIT=1`，并在脚本中提前退出，避免 repo 校验。
- 对 `git` 策略：保持当前行为，确保兼容。
- 预留 `bundle` 策略语义（由压缩包/镜像初始化），但首版可先作为占位，不强制实现复杂来源。

## Risks / Trade-offs

- [策略/能力不匹配] → 在解析阶段做 capability 校验，若 agent 不支持 mount/empty/bundle 则回退或拒绝。
- [兼容性回归] → 对 git 策略保持默认路径不变，新增分支只在显式策略时生效。
- [安全边界模糊] → 对 `empty` 模式禁止注入 git 凭据与 repoUrl，明确权限边界。
- [脚本改动风险] → 将 skip 判断前置并添加最小回归测试覆盖。
- [抽象过度] → 先落地最小可行子集（empty/mount/git + 基础 pipeline），其余作为可选扩展。
