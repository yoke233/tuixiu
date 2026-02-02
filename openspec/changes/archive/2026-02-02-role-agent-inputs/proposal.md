## Why

当前 run 启动时的 `agentInputs` 主要由后端在不同路径里临时组装/下发，前端也缺少一个统一的可视化入口来维护“需要落到 USER_HOME（~）/WORKSPACE 的文件与输入包”。这导致 RoleTemplate 想携带如 `.codex/AGENTS.md`、`.codex/config.toml`、技能包等运行时输入时只能靠手工操作或分散配置，难以复用且容易不一致。

## What Changes

- 在 RoleTemplate 中新增并维护 `agentInputs`（manifest v1），用于描述 run 启动时需要投递到 `WORKSPACE` 与 `USER_HOME` 的输入项（`bindMount` / `downloadExtract` / `writeFile` / `copy`）。
- backend 在构建 `acp_open.init` 时从 RoleTemplate 读取 `agentInputs` 并下发给 acp-proxy（run 级别生效，落到该 run 的 `USER_HOME`/workspace）。
- 前端 RoleTemplate 管理界面新增一个“AgentInputs”编辑器：以表格列出输入项，支持新增/编辑/删除/复制，并在右侧编辑内容（路径、root、apply、source、inlineText 等）。
- **BREAKING**（仅对 UI/配置习惯）：不再依赖手工编辑宿主机 `.codex` 目录来注入 run；推荐把需要的运行时文件/输入以 RoleTemplate 的 `agentInputs` 方式托管并下发。

## Capabilities

### New Capabilities
- `role-agent-inputs`: 定义并实现 RoleTemplate 维度的 `agentInputs` 托管、校验、下发与前端管理 UI。

### Modified Capabilities
- `agent-inputs`: 明确并规范 `apply=writeFile` + `source=inlineText` 的语义，以及其在 `USER_HOME`（run home）下落地的约束与验证规则。

## Impact

- Backend
  - Prisma：RoleTemplate 增加 `agentInputs` 存储字段（JSON/text），并在相关读写 API 中透出/校验。
  - Run 启动链路：在 `acp_open.init` 组装阶段合并/注入 RoleTemplate 的 `agentInputs`。
- acp-proxy
  - 复用现有 `agentInputs` 解析/落地能力（已支持 `writeFile`/`inlineText`、`USER_HOME`），补充必要的边界校验与测试覆盖。
- Frontend
  - Roles 管理页新增 AgentInputs 编辑区（表格 + 详情编辑器）。
- Testing
  - 后端/前端新增 Vitest 用例，覆盖 schema 校验、UI 编辑回写、以及典型 `writeFile` 落地路径。
