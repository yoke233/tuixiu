## 1. 数据模型与配置

- [x] 1.1 在 Prisma 中新增 ExecutionProfile 模型与审计字段（创建/更新/引用关系）
- [x] 1.2 为 RoleTemplate 与 Project 增加 executionProfileId 与 workspacePolicy 默认字段
- [x] 1.3 为 Run/Task 增加解析后的 workspacePolicy 来源记录与 profile 记录字段
- [x] 1.4 生成并验证数据库迁移（含回滚策略说明）

## 2. 策略解析与能力约束

- [x] 2.1 实现 workspacePolicy 解析器（平台→项目→角色→任务优先级）
- [x] 2.2 实现 executionProfile 解析与覆盖逻辑（role/task 覆盖 profile）
- [x] 2.3 增加 agent capabilities 兼容性校验与清晰错误返回
- [x] 2.4 将解析结果写入 Run 记录（policy 值与来源）

## 3. Context Workspace 与 Init Pipeline

- [x] 3.1 定义 WorkspaceSpec 结构（mounts/access/lifecycle/inventory）
- [x] 3.2 基于 policy+capabilities 生成 Init Pipeline 动作序列
- [x] 3.3 实现 ensure_workspace/init_repo/init_bundle/mount_skills 动作映射
- [x] 3.4 调整 init 脚本：前置 skip 判断与按动作执行，避免 repo 校验阻断
- [x] 3.5 实现 pipeline 幂等性保障与重试安全

## 4. 技能挂载与上下文清单

- [x] 4.1 保持 skillsManifest 在 empty 模式可用并下发
- [x] 4.2 统一 skills 挂载到 workspace 可列举路径或生成索引文件
- [x] 4.3 生成 Context Inventory（来源/版本/哈希）并在 init 后写入 workspace
- [x] 4.4 记录 inventory 生成结果（用于审计/调试）

## 5. Bundle 模式落地

- [x] 5.1 定义 bundle 来源参数与存储策略（运行时可解析）
- [x] 5.2 在 pipeline 中实现 init_bundle 动作（解压到 workspace）
- [x] 5.3 bundle 初始化后的 inventory 写入与校验

## 6. API 与配置入口

- [x] 6.1 扩展 Role/Project API 以读写 workspacePolicy 与 executionProfile
- [x] 6.2 新增 ExecutionProfile 管理接口（CRUD + 审计字段）
- [x] 6.3 运行时返回解析后的策略与 profile 信息（便于 UI 展示）

## 7. 测试与文档

- [x] 7.1 覆盖 policy 解析优先级与 capability 拒绝路径单测
- [x] 7.2 覆盖 empty/mount/git/bundle pipeline 行为单测
- [x] 7.3 覆盖 skills 可见性与 inventory 生成验证
- [x] 7.4 更新运行模式文档与安全说明（包含审查型角色示例）
