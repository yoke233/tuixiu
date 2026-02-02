## Why

当前 ACP run 启动过程把“输入投递”（workspace 初始化、skills 挂载、env 注入、目录约定）拆散在多处 if/else 与路径硬编码中，难以在需要新增输入类型（例如 MCP、自定义 agent.md、配置包）或更换运行时目录语义（例如 `~`/home 目录）时保持一致的安全边界与可扩展性。

## What Changes

- 引入统一的 Run 输入抽象（例如 `runInputs`/`runtimeInputs`）：用同一套字段描述来源、目标逻辑根、落地方式与权限，替代“按 workspacePolicy/skillsManifest 分散判断”的结构。
- 定义并在运行时解析少量**逻辑根目录**，以减少绝对路径耦合：
  - `WORKSPACE`：代码/产出区（现状通常为 `/workspace`）
  - `USER_HOME`：沙盒内对应 `~` 的 home 目录（不再假设 `/root`，也不把 home 绑定到 workspace）
  - `SCRATCH`：临时目录（可选）
- 将运行时可复用的输入包（skills、MCP、agent 指令包等）统一落在 `USER_HOME` 下的约定位置（例如 `USER_HOME/.tuixiu/...`）。
- 统一输入落地的安全校验与约束（目标路径规范化/白名单、压缩包安全解压），使新增输入类型只需要新增一种 source/apply 处理器而不需要改动全局分支逻辑。
- 支持 `bwrap`（bubblewrap）作为 sandbox provider：在 bwrap 下组合控制 UID/GID、`$HOME`、伪造 `/etc/passwd`（及可选 `/etc/group`）、工作目录与 `/workspace` 绑定，从而提供完整“用户态视图”。

## Capabilities

### New Capabilities
- `agent-inputs`: 为 ACP run 定义统一的输入投递契约（来源/目标/方式/权限/解析逻辑根），并支持在不同 sandbox provider 下稳定落地。

### Modified Capabilities
- `runtime-skill-mounting`: 将 skills 挂载目标从“与 workspace 强耦合的固定路径”调整为基于 `USER_HOME`/逻辑根解析的路径约定。

## Impact

- Backend：
  - run 启动时构造并下发统一输入清单，并减少 workspacePolicy 分支对其它输入的耦合。
  - init/env 注入新增或调整：暴露 `USER_HOME` 等稳定契约（对应沙盒内 `~`）。
- acp-proxy：
  - 新增/调整输入清单解析与落地流程。
  - 统一目标路径校验、解压约束、权限处理，并按 provider 能力解析 `USER_HOME` 对应的 guest 路径。
  - sandbox provider 增加 `bwrap` 支持，并落实“用户名/UID/工作目录分离”的用户态视图构建（fake passwd + HOME/USER/LOGNAME + chdir + bind workspace）。
- Docs/Runbook：
  - 更新运行时 skills/mcp/agent 指令包的目录约定与排障指引，强调逻辑根目录契约而非绝对路径。
