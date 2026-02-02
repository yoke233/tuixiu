## Context

系统已实现 `agentInputs`（manifest v1）的解析与落地，支持 `target.root` 为 `WORKSPACE`/`USER_HOME`，并在 acp-proxy 侧支持 `bindMount`、`downloadExtract`、`copy`、`writeFile`（`source=inlineText`）等 apply 方法。当前缺口主要在“控制面”：

- 缺少一个可复用、可视化的配置入口来维护 `agentInputs`（特别是 `USER_HOME` 下的运行时文件，如 `.codex/AGENTS.md`、`.codex/config.toml` 等）。
- backend 下发 `acp_open.init.agentInputs` 目前主要由运行链路组装，RoleTemplate 无法自带并管理这些 inputs。
- 前端 RoleTemplate 页面缺少结构化编辑器，手工编辑 JSON 容易出错。

约束：
- 运行环境为 Windows/pwsh，Repo 为 pnpm workspace（backend/acp-proxy/frontend）。
- 本次先按用户要求：仅实现 RoleTemplate 维度的 inputs（run 级生效），前端暂不做权限/脱敏策略。

## Goals / Non-Goals

**Goals:**
- RoleTemplate 新增一个可存/可读/可写的 `agentInputs` 字段（manifest v1），并在 run 启动时下发到 `acp_open.init.agentInputs`。
- 前端 RoleTemplate 管理界面提供结构化编辑器（表格 + 详情编辑），支持维护输入项：`bindMount` / `downloadExtract` / `writeFile` / `copy`。
- 后端对 `agentInputs` 进行严格校验（版本、root、path 相对性、apply/source 组合合法性），避免无效配置进入运行链路。
- `writeFile` 支持写入 run 的 `USER_HOME` 下任意相对路径（例如 `.codex/AGENTS.md`），由 acp-proxy 在启动前落地。

**Non-Goals:**
- 不做 run 级别的临时 inputs UI（仍可保留协议能力，但不作为本次功能入口）。
- 不实现权限/脱敏/只写不可读的 secrets 管理（后续可补）。
- 不改变既有 sandbox provider 的整体策略，仅在需要时补充校验与测试。

## Decisions

1) **存储形态：RoleTemplate 持久化 manifest v1（JSON）**
- 选择：在 RoleTemplate 表增加一个 JSON/text 字段（如 `agentInputs`），直接存 manifest（`{version:1, envPatch?, items[]}`）。
- 理由：与 acp-proxy/协议一致，避免二次抽象；可直接 round-trip 到 UI；便于将来扩展（新增 item 类型/字段）。
- 备选：拆成 `agentsMd`/`codexConfigToml` 等多个字段（放弃），原因是字段爆炸且缺少统一校验与排序语义。

2) **校验策略：backend 作为单一入口做 schema 校验，acp-proxy 继续做运行时防御性校验**
- backend：使用 Zod 定义 manifest v1 校验；拒绝未知 version、未知 apply/source 类型、不合法 root、`target.path` 逃逸等。
- acp-proxy：保持现有 `parseAgentInputsFromInit()` 与路径约束（相对路径、禁止 `..`、禁止绝对路径）以及落地时的 host root 子路径校验。

3) **运行时注入点：在构建 `acp_open.init` 时合并 RoleTemplate.agentInputs**
- 选择：backend 在 `startIssueRun`（及相关恢复链路）构造 init 时，把 RoleTemplate.agentInputs 作为 `init.agentInputs` 下发。
- 理由：agentInputs 属于 run 启动输入清单，最适合在 init 阶段一次性确定；acp-proxy 只负责“执行”。
- 合并策略（本次最小可用）：若 RoleTemplate.agentInputs 存在则直接下发；未来如增加 project/platform defaults，再按 `id` 做覆盖合并。

4) **前端编辑器：表格列出 items，右侧详情编辑内容**
- 选择：在 RolesSection 中新增 AgentInputs 区块：
  - 左侧表格：显示 `id/apply/root/target.path/source.type`，支持新增/复制/删除/排序。
  - 右侧编辑器：编辑当前 item 的字段；`writeFile` 使用 textarea 编辑 `source.inlineText.text`。
  - 顶部提供“导入/导出 JSON”（可选，便于批量编辑与迁移）。
- 理由：避免在表格单元格里编辑大文本；降低 JSON 直接编辑带来的错误率。

5) **安全/体积策略：先做最小限制与显式风险提示**
- 选择：先不引入权限系统，但在 UI 提示“请勿在 RoleTemplate 中存储密钥”；backend 可设置合理大小上限（例如单项 inlineText 最大长度、items 最大数量），防止过大 payload 影响 WS/init。

## Risks / Trade-offs

- [风险] RoleTemplate 存储敏感信息（如 API key） → [缓解] UI 文案提示 + 后续引入“只写不可读”的 secrets 字段与权限控制。
- [风险] 大文件/大量 items 导致 init payload 过大 → [缓解] backend 增加上限（items 数、inlineText 长度），必要时引导使用 `downloadExtract`（httpZip）。
- [风险] 用户配置错误导致 run 启动失败 → [缓解] backend 校验 + 前端表单级校验 + 在 UI 上提供清晰错误展示与示例模板。
