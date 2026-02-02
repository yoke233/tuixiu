## 1. Contract & Data Model

- [x] 1.1 定义 `agentInputs` 的最小字段集与 JSON 结构（source/target/apply/access + 可选 envPatch），并与 `init` payload 对齐
- [x] 1.2 定义逻辑根目录解析输出：`WORKSPACE`、`USER_HOME`（以及在 bwrap 下的 `HOME/~` 对齐规则）

## 2. Backend 下发（init payload）

- [x] 2.1 在 backend run 启动流程中生成并下发 `agentInputs`（至少覆盖：repo workspace + zip 包输入）
- [x] 2.2 在 backend init/env 中提供 `USER_HOME`（以及必要的 bwrap 用户态视图参数：username/uid/gid/homePath）
- [x] 2.3 保持 workspacePolicy 语义不变，仅调整其实现以接入统一输入清单（避免分散分支）
- [x] 2.4 明确 env 的分层：控制面 env 仍由 `init.env` 承载；仅允许 `agentInputs.envPatch` 覆盖 `HOME/USER/LOGNAME`

## 3. acp-proxy 输入执行管线

- [x] 3.1 在 acp-proxy 增加 `agentInputs` 解析/校验：允许的 `target.root`、相对路径校验、apply/source 枚举校验
- [x] 3.2 实现 zip 输入的安全解压（ZipSlip/symlink 拒绝 + 解压防 DoS 约束），并落地到 `USER_HOME` 下约定路径
- [x] 3.3 将 skills 落地路径对齐 codex/codex-acp 默认约定：`~/.codex/skills`（`USER_HOME/.codex/skills`），并更新列举/可见性逻辑
- [x] 3.4 移除 `CODEX_HOME` 相关注入与路径依赖（env allowlist、目录创建、run cleanup 均以 `USER_HOME` 约定为准）
- [x] 3.5 移除 `skillsManifest` 的解析与旧流程分支（仅保留 `agentInputs` 作为输入来源）

## 4. bwrap provider（bubblewrap）

- [x] 4.1 新增 bwrap sandbox provider 入口与配置项（provider 选择、二进制路径、基础只读绑定策略）
- [x] 4.2 实现“用户态视图”构建：fake `/etc/passwd`（可选 `/etc/group`）+ 设置 UID/GID + `HOME/USER/LOGNAME` + 绑定 home 目录
- [x] 4.3 实现 workspace bind 与工作目录：绑定 workspace 到 `/workspace` 并 `chdir /workspace`
- [x] 4.4 确认 `USER_HOME` 与 `~` 一致：在 bwrap 下 `USER_HOME` 的解析结果与 `HOME` 环境变量一致

## 5. Docs & Runbook

- [x] 5.1 更新 runbook：明确 `USER_HOME`（`~`）为唯一 home 语义，skills 路径为 `~/.codex/skills`
- [x] 5.2 增补 bwrap 排障：whoami/getpwuid 失败、HOME 不一致、workspace 未绑定等典型问题与检查方法

## 6. Repo Hygiene

- [x] 6.1 清理实现前遗留的无关未跟踪文件（确保 PR 仅包含本变更相关改动）

## 7. Testing

- [x] 7.1 按 `openspec/changes/unify-run-inputs/evidence/test_plan.md` 实现单测（离线、确定性）
- [x] 7.2 为 bwrap provider 增加“命令/参数计划”纯单测（不依赖系统存在 bwrap）
- [x] 7.3 运行 `pnpm test` 并记录覆盖率 before/after（或按 test plan 中的替代证据要求提供说明）
