## 1. Backend: RoleTemplate 存储与校验

- [x] 1.1 为 RoleTemplate 增加 `agentInputs` 字段（Prisma schema + migration）
- [x] 1.2 定义并实现 `agentInputs` manifest v1 的 Zod 校验（apply/source/target/root/path 组合）
- [x] 1.3 在 RoleTemplate 创建/更新 API 中接入校验与持久化，并确保 round-trip
- [x] 1.4 更新对外返回的 RoleTemplate public shape（包含 agentInputs 或为 null）

## 2. Backend: run init 注入

- [x] 2.1 在 run 启动链路（startIssueRun 等）把 RoleTemplate.agentInputs 下发到 `acp_open.init.agentInputs`
- [x] 2.2 在 run 恢复链路（recovery）中补齐 agentInputs 注入（与启动链路保持一致）
- [x] 2.3 确认 `envPatch` 仅允许 HOME/USER/LOGNAME，并与 init.env 合并逻辑不冲突

## 3. Frontend: RoleTemplate AgentInputs 编辑器

- [x] 3.1 在 RolesSection 增加 AgentInputs 区块入口（不做权限控制）
- [x] 3.2 实现 items 表格（id/apply/root/target.path/source.type）+ 选择态
- [x] 3.3 实现详情编辑器（按 apply/source 类型显示不同字段；writeFile/inlineText 支持大文本编辑）
- [x] 3.4 实现新增/复制/删除 item 与顺序调整（顺序即执行顺序）
- [x] 3.5 保存时提交到后端并展示校验错误（不丢失本地编辑内容）

## 4. acp-proxy: writeFile/USER_HOME 回归与边界

- [x] 4.1 补充/更新 acp-proxy 测试：`writeFile + USER_HOME` 写入、深层目录创建、错误场景
- [x] 4.2 补充安全校验：禁止 target.path 逃逸（确保 parse + resolveHostTargetPath 双重约束）

## 5. Testing

- [x] 5.1 Implement tests based on evidence/test_plan.md (offline + deterministic)
- [x] 5.2 Add/Update fixtures & mocks (no external network)
- [x] 5.3 Run TEST_CMD and capture coverage before/after evidence
