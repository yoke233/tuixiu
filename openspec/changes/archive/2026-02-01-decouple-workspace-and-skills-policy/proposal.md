## Why

当前 Agent 启动逻辑把「工作区初始化（clone）」与「技能注入」耦合在一起，导致无法安全地创建“无仓库初始化角色”（例如技能审查、策略评估等）。需要引入可配置的运行策略，确保工作区始终存在，但允许在不下载仓库的情况下依然注入技能，并为未来更多外部/轻量角色提供扩展基础。

## What Changes

- 引入可配置的 workspacePolicy（如 git/mount/empty/bundle），支持“有工作区但不初始化仓库”的运行方式。
- 把技能注入与工作区初始化解耦：skillsManifest 在无仓库初始化模式下依旧可用。
- 启动初始化流程简化为“策略解析 → 计划下发 → 运行时执行”，并允许跳过 repo 校验与 clone。
- 角色/项目/平台层面提供默认策略与覆盖规则，运行时根据 agent capabilities 做能力约束。
- 抽象为 Context Workspace（上下文工作区）与 Init Pipeline（初始化流水线），并引入 Execution Profile 作为角色的运行基线配置。

## Capabilities

### New Capabilities
- `workspace-policy`: 统一定义工作区策略（git/mount/empty/bundle）、策略继承与能力约束，以及与启动计划的映射关系。
- `context-workspace`: 定义工作区作为可组合资源空间（多源挂载、读写权限、生命周期、上下文资源）。
- `init-pipeline`: 定义初始化动作序列与执行语义（计划下发、动作执行、可跳过的仓库初始化）。
- `execution-profile`: 定义角色运行基线（workspace/skills/tool/data 策略的组合与继承）。

### Modified Capabilities
- `runtime-skill-mounting`: 允许在无仓库初始化模式下继续下发并挂载技能包，明确 skillsManifest 与 workspace 初始化解耦。

## Impact

- 后端：运行器（ACP 执行器、Issue Run 启动）、策略解析与环境变量注入逻辑
- 数据模型：RoleTemplate/Project/平台配置新增 workspacePolicy（含默认/继承）
- 启动脚本：允许 skip workspace init 早于 repo 校验
- UI/配置：角色配置与项目默认策略设置
- 文档与协议：运行模式说明、能力约束与安全说明
- 审计与治理：执行配置与上下文来源可追溯（用于审查与合规）
