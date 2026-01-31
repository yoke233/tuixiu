## Why

Phase 1 只完成了技能 Registry 的“平台内骨架”（入库/搜索/角色启用配置），但缺少把外部生态技能导入、版本化管理并在运行时真正挂载生效的闭环。现在需要 Phase 2 打通“搜得到 → 导得进 → 管得住（版本/更新/审计）→ 用得上（运行时挂载）”，以支撑可控、可审计、可灰度的 skills 生产化使用。

## What Changes

- 搜索：在现有 provider 机制上扩展外部 provider（优先 `skills.sh`，复用 `npx skills find`），UI 支持 provider 切换与统一结果展示；保持一期接口契约稳定（默认 `registry`，返回结构不破坏）。
- 导入/安装：新增导入管线，把外部来源的技能（`SKILL.md` 及相关文件）导入为 Registry 中的 `Skill/SkillVersion`，并记录来源引用、导入时间、内容 hash、存储 URI 等可追溯元数据。
- 版本策略：角色启用支持 `latest` / `pinned` 策略（pinned 选择具体 `SkillVersion`），并补齐对应校验与后台交互。
- 更新/同步：提供平台侧“检查更新 / 批量更新”能力：检测外部新版本 → 生成新 `SkillVersion` → 可选择发布为 `latest`（默认不自动发布，避免不受控漂移），并记录审计日志。
- 运行时挂载（MVP，可灰度）：run 启动时由 backend 下发 skills manifest；acp-proxy 按 `contentHash` 拉取/缓存 skill 包并为每个 run 生成只读 `CODEX_HOME/skills` 视图；通过 env 白名单透传 `CODEX_HOME` 使 agent 生效；提供项目级/代理级开关便于回滚。
- 安全约束：导入与运行时均不执行外部脚本；前端渲染严格 sanitize；运行时仅透传白名单 env。

## Capabilities

### New Capabilities
- `runtime-skill-mounting`: run 启动时下发 skills manifest，proxy 拉取/缓存并为 run 创建只读 `CODEX_HOME/skills` 挂载视图，env 白名单透传与灰度开关。

### Modified Capabilities
- `skill-search`: 搜索支持多 provider（含外部 provider）、统一 DTO、导入状态展示与 provider 切换（保持一期默认行为与返回结构兼容）。
- `skill-registry`: 支持导入管线与 `SkillVersion` 版本化、`latest` 发布/回滚策略、更新检查与更新导入、来源/指纹/存储/审计元数据。
- `role-skill-bindings`: 角色启用绑定支持 `latest`/`pinned` 策略与 pinned 版本选择/校验（含 pinned 版本不可用时的约束）。

## Impact

- Backend（Fastify + Prisma）：新增/扩展 Admin API（search provider、import、check-updates、update、审计），调整数据模型字段（source、latestVersionId、versionPolicy 等），以及 run 启动时下发 skills manifest 的数据通路。
- acp-proxy：新增 skill 包拉取、按 `contentHash` 缓存、run 级只读挂载视图生成；修复/补齐 env 白名单透传以支持 run 级 `CODEX_HOME`；增加灰度开关与可观测指标。
- Frontend：Skills 管理页增加 provider 切换与导入入口；角色页补齐版本策略选择与 pinned 版本选择器；导入/更新任务与审计展示（最小可用）。
- 外部依赖与资源：skills.sh 生态与 `npx skills` CLI 的可用性/限流/版本 pin；skill 包的存储（本地或对象存储 URI 方案）与下载重试。
