# Test Plan

## Change Fingerprint
- BASE_REF: origin/main
- HEAD_SHA: 0296f1252a31ea6dd9c26e0ca1ebe6eb2e7f4c93
- DIFF_CMD: `git diff --name-status origin/main...HEAD`

## Scope
- Included:
  - `agent-inputs` 输入清单解析/校验/落地流程（acp-proxy 侧）
  - `bwrap` provider：用户态视图（uid/gid + passwd/group + HOME/USER/LOGNAME + chdir + workspace bind）
  - `USER_HOME` 解析与 `~` 一致性（在 bwrap 下）
  - skills 目录约定在 bwrap 下保持稳定（`~/.codex/skills`）
- Excluded:
  - 产物输出/归档/外发策略（本变更不覆盖）
  - 强完整性校验/签名体系（本变更明确不做）

## Coverage Map
- Target packages:
  - `acp-proxy`: `src/sandbox/*`（新增 bwrap provider）、`src/runs/*`（run 启动时 provider 选择与挂载）、`src/skills/*`（技能目录约定与 USER_HOME 的联动）
  - `backend`（若实现涉及 init payload 扩展）：`src/executors/*` / `src/modules/runs/*`
- Baseline collection:
  - 运行 `pnpm test:coverage` 在 `BASE_REF` 与 `HEAD_SHA` 分别采集覆盖率（若 workspace 未配置 coverage 脚本，则在证据中注明并改用“关键路径日志 + 单测断言”作为替代证据）

## Test Cards
<!-- per impacted module: 1 normal + 2 boundary + 2 error -->
- `acp-proxy/src/sandbox/bwrap*`：bwrap 命令构建与 bind 规划（normal/boundary/error）
- `acp-proxy`：USER_HOME 解析与 env 组合（normal/boundary/error）
- `acp-proxy`：skills 在 `~/.codex/skills` 的落地与可发现性（normal/boundary/error）

## Evidence
- TEST_CMD: `pnpm test`
- Coverage before: 运行 `git checkout origin/main` 后执行 `pnpm test:coverage`（或项目等价覆盖率命令）记录结果
- Coverage after: 在变更分支/提交上执行 `pnpm test:coverage`（或项目等价覆盖率命令）记录结果

### Evidence Run Log (2026-02-02)

- Tests (workspace): `pnpm test` ✅
- Coverage (per-package):
  - `pnpm -C acp-proxy test:coverage` ✅（All files: Stmts 42.05%, Branch 47.64%, Funcs 51.85%, Lines 42.05%）
  - `pnpm -C backend test:coverage` ✅（All files: Stmts 80.38%, Branch 55.85%, Funcs 94.09%, Lines 80.38%）
  - `pnpm -C frontend test:coverage` ❌（未达既有全局阈值；与本变更无关，已按 test plan “替代证据”执行按包采集）

## Flake Guard
- seed: `VITEST_SEED=1`（或在 Vitest 配置中固定 seed）
- clock: 对时间相关逻辑使用固定时间（例如 `vi.setSystemTime(...)`），禁止依赖真实系统时间
- timezone: `TZ=UTC`
- concurrency/isolation: bwrap/provider 单测使用纯函数/命令拼装断言，避免并发写临时目录；涉及临时文件时使用 per-test temp dir

## Exceptions
- Online-only: none
- External-only dependency: bwrap 二进制本身不作为测试依赖；通过“命令构建/参数计划”的纯单测覆盖，并对 spawn/exec 适配层做 stub
- Notes: 若 CI 环境缺少 bwrap（常见），不得让测试依赖真实 bwrap 存在

## Trace Matrix
| CHG | Change | RISK | Tests | Evidence |
|---|---|---|---|---|
| A1 | bwrap 用户态视图（uid/gid + passwd/group + HOME + chdir） | whoami/getpwuid 失败导致运行时异常；HOME 不一致导致配置/skills 不可见 | 单测断言生成的 `/etc/passwd` 内容、env 设置、`--chdir /workspace`、bind 列表 | `pnpm test` 通过；覆盖率提升 |
| A2 | WORKSPACE bind 到 `/workspace` | agent 启动目录错误导致相对路径行为异常 | 单测断言 workspace bind 与 cwd | `pnpm test` 通过；覆盖率提升 |
| A3 | USER_HOME 作为 `~` 语义 | `~` 解析不一致导致 skills/mcp/agent 包不可发现 | 单测断言 HOME 与 USER_HOME 输出契约（或 provider 返回值） | `pnpm test` 通过；覆盖率提升 |
| A4 | skills 目录约定 `~/.codex/skills` | 审查/列举技能失败 | 单测断言技能目录目标路径与落地行为 | `pnpm test` 通过；覆盖率提升 |
