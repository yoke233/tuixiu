# Test Plan

## Change Fingerprint
- BASE_REF: origin/main
- HEAD_SHA: ca1a9db0f3ade0feee149c489d5d95da34c5c2df
- DIFF_CMD: git diff --name-only origin/main..HEAD

## Scope
- Included:
  - Backend：RoleTemplate `agentInputs` 的持久化与校验、run 启动时下发 `init.agentInputs`
  - acp-proxy：`writeFile`/`USER_HOME` 相关落地与路径约束（回归面）
  - Frontend：RoleTemplate（RolesSection）新增 AgentInputs 表格/编辑器与保存回写
- Excluded:
  - 权限/脱敏/只写不可读 secrets（明确不在本次范围）
  - run 级临时 inputs UI（协议能力可保留，但不作为入口）

## Coverage Map
- Backend
  - roleTemplates 路由/服务：新增 agentInputs 字段校验与读写
  - run 启动链路：init 组装处注入 roleTemplate.agentInputs
- acp-proxy
  - `parseAgentInputsFromInit()` schema 防御
  - `applyAgentInputs()` 对 `writeFile` + `USER_HOME` 的落地
- Frontend
  - RolesSection：AgentInputs 列表/编辑器交互、序列化/反序列化、保存错误展示

## Test Cards
- Backend / RoleTemplate agentInputs
  - Normal：保存合法 manifest（包含 `writeFile + inlineText`），读取后 round-trip 相等
  - Boundary：`items=[]` 空清单保存与读取
  - Boundary：`target.path=""` 或 `"."`（合法相对路径）行为一致
  - Error：`target.path` 含 `..`（拒绝）
  - Error：`apply=writeFile` 但 `source.type!=inlineText`（拒绝）
- Backend / Run init assembly
  - Normal：启动 run 时 `init.agentInputs` 由 RoleTemplate 注入
  - Error：RoleTemplate 存在不合法 agentInputs 时不得进入启动链路（保存阶段已拦截）
- acp-proxy / apply writeFile
  - Normal：写入 `USER_HOME/.codex/AGENTS.md` 成功
  - Boundary：写入深层目录（自动创建父目录）
  - Error：`target.path` 逃逸尝试（已在 parse 阶段拒绝）
  - Error：`USER_HOME` root 不存在（mount 未启用时）应失败并阻止启动
- Frontend / AgentInputs editor
  - Normal：新增 item（writeFile/inlineText），编辑内容并保存
  - Boundary：编辑/复制/删除 item 后保存，顺序保持
  - Error：后端返回校验错误时，UI 可见且不丢失编辑内容

## Evidence
- TEST_CMD: pnpm test
- Coverage before: 未记录（实现前未跑 coverage）
- Coverage after (2026-02-02):
  - `pnpm test`: PASS
  - `pnpm -C acp-proxy test:coverage`: Stmts 43.35% / Branch 48.75% / Funcs 53.27% / Lines 43.35%
  - `pnpm -C backend test:coverage`: Stmts 79.96% / Branch 55.79% / Funcs 93.91% / Lines 79.96%（未达全局阈值 80%）
  - `pnpm -C frontend test:coverage`: Stmts 51.75% / Branch 57.59% / Funcs 37.61% / Lines 51.75%（未达全局阈值 85/80/70）

## Flake Guard
- seed: Vitest 默认顺序；如出现顺序依赖，使用 `--sequence.seed 1`
- clock: 不引入真实时间依赖；必要时 stub Date/Timers
- timezone: 建议 CI 设置 `TZ=UTC`
- concurrency/isolation: 避免共享全局状态；测试中重置 localStorage/mocks

## Exceptions
- Online-only: none
- External-only dependency: none
- Notes: coverage 数值在实现完成后补齐（本文件为计划，不包含执行结果）

## Trace Matrix
| CHG | Change | RISK | Tests | Evidence |
|---|---|---|---|---|
| RAI-1 | RoleTemplate 存/校验 agentInputs | 校验缺失导致 run 启动失败或安全问题 | Backend/RoleTemplate agentInputs（normal+boundary+error） | `pnpm test` |
| RAI-2 | init 组装下发 agentInputs | backend 未下发导致功能不生效 | Backend/Run init assembly | `pnpm test` |
| RAI-3 | writeFile 落地到 USER_HOME | 文件未写入/路径越界/启动前后不可见 | acp-proxy writeFile tests | `pnpm -C acp-proxy test`（通过 workspace `pnpm test` 覆盖） |
| RAI-4 | 前端编辑器正确性 | UI 编辑丢失/序列化错误/保存失败不可见 | Frontend RolesSection tests | `pnpm -C frontend test`（通过 workspace `pnpm test` 覆盖） |
