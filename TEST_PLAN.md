# 测试补齐计划（本次提交）

> 目标：仅覆盖本次提交引入/修改的代码路径及其直接回归面；优先核心链路与高风险点；不访问外网；单命令可跑；避免 flaky（固定时间/随机种子）。

## 一键命令

```powershell
pnpm -C backend test:coverage
```

## 覆盖地图（按风险排序）

| 风险级别 | 模块/接口 | 变更要点 | 主要风险 | 计划测试文件 |
| --- | --- | --- | --- | --- |
| 高 | backend/src/executors/acpAgentExecutor.ts | workspacePolicy/executionProfile/pipeline/skills/bundle/inventory 注入与 init env | 运行时环境错误、workspace 初始化错误、技能挂载/审查数据缺失 | backend/test/executors/acpAgentExecutor.test.ts |
| 高 | backend/src/modules/runs/startIssueRun.ts | 创建 run/workspace，policy/profile 解析，init env、inventory 与 skills | 任务启动失败、workspace/技能/清单丢失、错误处理不一致 | backend/test/modules/runs/startIssueRun.test.ts |
| 高 | backend/src/routes/executionProfiles.ts | ExecutionProfile CRUD + 审计 | 权限/参数/404/审计缺失 | backend/test/routes/executionProfiles.test.ts |
| 中 | backend/src/utils/workspacePolicy.ts | policy 解析与能力校验 | policy 解析错、capability 不匹配放行 | backend/test/utils/workspacePolicy.test.ts |
| 中 | backend/src/utils/executionProfile.ts | profile 解析优先级与 fallback | profile 解析错、空值处理 | backend/test/utils/executionProfile.test.ts |
| 中 | backend/src/utils/initPipeline.ts | init action 生成 | pipeline 缺动作或顺序错 | backend/test/utils/initPipeline.test.ts |
| 中 | backend/src/utils/contextInventory.ts | inventory 生成/序列化 | 清单路径/格式错 | backend/test/utils/contextInventory.test.ts |
| 中 | backend/src/utils/agentInit.ts | init 脚本动作分发与 skip | init 动作错误/跳过逻辑错误 | backend/test/utils/agentInit.test.ts |
| 中 | backend/src/routes/projects.ts | 新增 workspacePolicy/executionProfile 等字段 | API 兼容性/默认值错误 | backend/test/routes/projects.test.ts |
| 中 | backend/src/routes/roleTemplates.ts | workspacePolicy/executionProfile/envText 处理 | envText 归一化/权限/404 | backend/test/routes/roleTemplates.test.ts |

## 测试卡片（每模块：1 正常 + 2 边界 + 2 异常）

> 说明：异常场景包括抛错/返回错误/校验失败等；边界场景包括空值/缺省/极限输入/分支覆盖。

### 1) workspacePolicy
- 正常：task > role > project > profile > platform 优先级解析
- 边界：全为空 → default=git；非法字符串被忽略
- 异常：policy=mount + caps=git_clone 抛错；policy=git + caps=mount 抛错

### 2) executionProfile
- 正常：task > role > project > platform 解析命中
- 边界：仅 platform key 命中；各层返回 null 时整体 null
- 异常：prisma.findUnique 抛错时冒泡；后续 lookup 抛错时冒泡

### 3) initPipeline
- 正常：git + skills → ensure/init_repo/mount_skills/write_inventory
- 边界：empty + no skills → ensure/write_inventory；git + hasBundle → init_bundle 插入
- 异常：policy 传入非法值（as any）仍能生成 ensure/write_inventory；hasSkills/hasBundle 为 falsy 极端值不崩

### 4) contextInventory
- 正常：skills+repo 生成 JSON 与路径
- 边界：空 items 仍含 generatedAt；hash/ref/version 为空可序列化
- 异常：items 含非字符串 key；unknown source 仍可 stringify

### 5) agentInit（buildWorkspaceInitScript/mergeInitScripts）
- 正常：mergeInitScripts 拼接顺序正确；脚本含 init_step/ensure_workspace/mount_skills
- 边界：空/null 脚本忽略；TUIXIU_INIT_ACTIONS 为空时走默认 git 初始化分支
- 异常：workspace=/ 或空时报错分支可达；bundle 缺失/格式不支持分支可达

### 6) acpAgentExecutor
- 正常：git policy 注入 repo env + git auth；skills inventory 写入
- 边界：bundle policy + hasBundle 注入 init_bundle；mount 模式 skip init
- 异常：bundle policy 缺来源抛错；roleKey 指定但角色不存在抛错

### 7) startIssueRun
- 正常：empty policy 生成 skills inventory 与 init actions
- 边界：keepalive TTL 归一化；workspace 创建写回 run/task
- 异常：bundle policy 缺来源返回 BUNDLE_MISSING；createWorkspace 缺失 → WORKSPACE_FAILED

### 8) executionProfiles routes
- 正常：POST/GET/PATCH/DELETE 正常返回与审计写入
- 边界：PATCH 允许 nullable 字段；GET list 空数组
- 异常：GET/PATCH/DELETE 404；POST body 校验失败（400）

### 9) projects routes
- 正常：POST 带 workspacePolicy/executionProfileId
- 边界：PATCH 仅更新部分字段；workspacePolicy 置 null
- 异常：PATCH project 不存在返回 NOT_FOUND；body 校验失败（400）

### 10) roleTemplates routes
- 正常：POST/GET include envKeys；admin 才能回传 envText
- 边界：envText 为空字符串 → null；workspacePolicy nullable
- 异常：POST project 不存在；PATCH/DELETE role 不存在

## 覆盖率基线与结果

- Before（本次补测前记录）：Statements/Lines 79.48%
- After（本次执行结果）：Statements/Lines 80.28%

## 约束与防 flaky

- 不访问外网；所有外部交互全部 mock
- 时间：对 new Date/ISO 时间测试采用固定格式断言或假定时间
- 随机：uuid/随机数只做格式断言，不做固定值断言

## 本次提交关联测试清单

- backend/test/executors/acpAgentExecutor.test.ts
- backend/test/modules/pm/pmAutoAdvance.test.ts
- backend/test/modules/runs/startIssueRun.test.ts
- backend/test/routes/executionProfiles.test.ts
- backend/test/routes/projects.test.ts
- backend/test/utils/agentInit.test.ts
- backend/test/utils/contextInventory.test.ts
- backend/test/utils/executionProfile.test.ts
- backend/test/utils/initPipeline.test.ts
