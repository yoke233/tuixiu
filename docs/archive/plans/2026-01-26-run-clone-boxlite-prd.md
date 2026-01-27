---
title: "Run 全量 Clone 工作区 + Git 缓存 + BoxLite 沙箱（GitHub，HTTPS/SSH）PRD"
owner: "@tuixiu-maintainers"
status: "archived"
result: "done"
last_reviewed: "2026-01-27"
superseded_by: "docs/00_overview/roadmap.md"
---

# Run 全量 Clone 工作区 + Git 缓存 + BoxLite 沙箱（GitHub，HTTPS/SSH）PRD（已归档）

> ⚠️ **已归档 / 已过期**：本文件仅用于历史追溯，可能与当前实现不一致，请勿作为开发依据。  
> 当前请以 `README.md`、`docs/00_overview/roadmap.md`、`docs/03_guides/quick-start.md` 为准。

### 1. Executive Summary

- **Problem Statement**：当前系统运行依赖“本地已有仓库 + git worktree”，真实用户接入 GitHub 时需要先手动 clone 并在仓库目录启动后端；同时当需要隔离执行环境（BoxLite）与提升并发吞吐（一个 Agent 多 session）时，缺少一套可复用、可观测、可清理的工作区与缓存体系。
- **Proposed Solution**：引入“Run 工作区 = 全量 clone”的工作区模式（与现有 worktree 模式并存），并为每个 Project 建立 Git 镜像缓存（mirror/bare）用于加速 clone；在 `acp-proxy` 使用 `boxlite_oci` 运行 ACP Agent（Codex 等），通过挂载 Run 工作区目录实现隔离执行；支持 Git 认证 **HTTPS(PAT)** 与 **SSH** 两种模式；增强单 Agent 的并发能力（多 ACP session 并行），并固化 Run 的工作区/认证/沙箱参数快照用于审计与复盘。
- **Success Criteria**（可量化）：
  - 冷启动：首次 Run（无缓存）clone+checkout P50 ≤ 60s（依 repo 大小可配阈值），失败率 ≤ 1%。
  - 热启动：有 mirror 缓存时 clone+checkout P50 ≤ 10s（同机同 repo）。
  - 并发：单 Agent 支持 `max_concurrent >= 2` 时可同时运行 2 个 Run（独立 session），且事件流不串台。
  - 清理：Run 工作区可按 TTL 自动清理（默认 7 天，可配），不影响历史 Run 的事件/产物可追溯。
  - 安全：token 不出现在日志/事件/前端回显；SSH 私钥默认不落库（仅引用宿主机/挂载路径）。

### 2. User Experience & Functionality

- **User Personas**
  - 平台管理员：配置全局工作区根目录、缓存策略、BoxLite 镜像与资源限制、并发上限。
  - 项目管理员：为项目选择工作区模式（worktree/clone）、配置 Git 认证方式（HTTPS/SSH）、配置 GitHub Token、配置 RoleTemplate/initScript。
  - 研发成员：导入 GitHub Issue、启动 Run、观察执行、创建/合并 PR。

- **User Stories**
  - 作为真实用户，我希望只提供 GitHub 仓库地址与 token/SSH，就能启动 Run，不需要在服务器上手动 clone 并进入目录运行。
  - 作为项目管理员，我希望系统自动复用仓库缓存，加速每次 Run 的 clone，并可控地清理缓存与工作区。
  - 作为平台管理员，我希望把 Agent 放入 BoxLite 沙箱运行，并限制 CPU/内存，同时支持并发 Run。
  - 作为研发成员，我希望一个 Agent 可以并行处理多个 Run（不同 session），并且每个 Run 的 workspace 与日志完全隔离。

- **Acceptance Criteria**
  - Project 支持配置 `workspaceMode`：
    - `worktree`（现有）：在“当前仓库”下创建 `.worktrees/run-<worktreeName>`。
    - `clone`（新增）：在 `WORKSPACES_ROOT/run-<worktreeName>` 目录 clone 仓库并 checkout 分支。
  - Project 支持配置 `gitAuthMode`：
    - `https_pat`：使用 GitHub PAT 完成 clone/fetch/push（token 不写入命令行参数，不出现在日志）。
    - `ssh`：使用宿主机已配置的 SSH key（或指定 keyPath/known_hosts），完成 clone/fetch/push。
  - Run 创建时必须固化快照（不得包含 secrets 明文）：`workspaceMode`、`workspacePath`、`branchName`、`gitAuthMode`、`sandbox.provider`、`agent.max_concurrent`、clone/fetch 关键耗时指标。
  - `acp-proxy` 支持单进程多 session：当 `agent.max_concurrent > 1` 时，可以同时处理多个 `execute_task/prompt_run`（每个 Run 绑定独立 sessionId），并在 UI 中正确展示。
  - BoxLite 模式下，Run 工作区必须可在沙箱内访问（通过 volume mount 或统一挂载工作区根目录）。

- **Non-Goals**
  - 不做 GitHub App 安装流程（先 PAT/SSH）。
  - 不做多仓库/单 Project 多 repo（仍按单仓库 MVP）。
  - 不做跨机器共享镜像缓存（先同机缓存）。
  - 不做复杂 RBAC/审计导出（先提供最小可用安全提示与脱敏）。

### 3. AI System Requirements (If Applicable)

- **Tool Requirements**
  - ACP：支持 `initialize`、`session/new`、`session/load`、`session/prompt`；必须支持多个 session 并存（协议允许并发请求）。
  - BoxLite Node SDK：`@boxlite-ai/boxlite`（或 `boxlite`）用于 `boxlite_oci` 运行 ACP Agent。
  - Git：用于 clone/fetch/checkout/push；需要支持 HTTPS 与 SSH 两种认证。
  - GitHub REST API：Issue 导入、PR 创建/合并。

- **Evaluation Strategy**
  - 性能：记录 clone/fetch/checkout 耗时与失败原因（P50/P95）。
  - 并发：压测 `max_concurrent=2/4`（同机），观察 session 消息正确路由、资源占用与失败率。
  - 稳定性：模拟 proxy 重启后 `session/load` 行为与恢复体验（尽量复用历史 session）。

### 4. Technical Specifications

- **Architecture Overview**
  - `backend` 负责：Run 工作区创建（clone/worktree）、Git mirror 缓存、git push、PR API 调用、Run/事件/产物持久化。
  - `acp-proxy` 负责：运行 ACP Agent（host_process / boxlite_oci），多 session 复用同一 Agent 进程，并按 `agent.max_concurrent` 并发处理 Run。
  - `frontend` 负责：配置 Project（workspaceMode/gitAuthMode/token）、导入 Issue、启动 Run、查看 Console/变更/PR。

- **Workspace（clone 模式）**
  - 新增全局配置：
    - `WORKSPACES_ROOT`：Run 工作区根目录（Linux/macOS 示例：`/var/lib/tuixiu/workspaces`；Windows 示例：`D:\\tuixiu\\workspaces`）。
    - `REPO_CACHE_ROOT`：Git mirror 缓存根目录（同机）。
  - Project 镜像缓存：
    - 初始化：`git clone --mirror <repoUrl> <REPO_CACHE_ROOT>/<projectId>.git`
    - 更新：`git -C <mirror> fetch --prune`
  - Run 工作区：
    - `git clone --reference-if-able <mirror> <workspacePath>`（无 mirror 时直接 `git clone <repoUrl> ...`）
    - `git checkout -b run/<worktreeName> origin/<baseBranch>`

- **Git Auth（C：HTTPS + SSH）**
  - HTTPS(PAT)：
    - 推荐通过 `GIT_ASKPASS`/`credential.helper` 临时注入，避免 token 出现在命令参数与进程列表中。
    - token 默认复用 `Project.githubAccessToken`（后续可拆分 “API token” 与 “git token”）。
  - SSH：
    - 默认不存储私钥：使用宿主机 `~/.ssh`（或运行环境挂载的 keyPath）。
    - 支持项目级指定 `sshKeyPath/knownHostsPath`（仅路径引用 + 校验，不回显内容）。

- **BoxLite（boxlite_oci）**
  - `acp-proxy` 在 WSL2/Linux/macOS(arm64) 运行，BoxLite 创建 OCI/micro-VM 沙箱并启动 ACP Agent。
  - 挂载策略：
    - 至少挂载 `WORKSPACES_ROOT` 到容器内 `/workspace`（run 工作区为 `/workspace/run-<worktreeName>` 或 `/workspace/<project>/run-<worktreeName>`）。
  - 资源限制：通过 `sandbox.boxlite.cpus/memoryMib` 配置；并发上限受资源与 `agent.max_concurrent` 双重约束。

- **Dev Environment Bootstrap（沙箱内初始化：以 Node/npm 为例）**
  - 背景：在 `boxlite_oci` 下，ACP Agent 运行在 Linux guest 中；如果在宿主机执行 `pnpm install`（例如宿主是 macOS/Windows），会产生平台不兼容的二进制依赖，导致运行失败。因此「依赖安装/构建」应尽量在沙箱内完成。
  - 最佳实践（推荐分三层）：
    1. **Runner Image（OCI 镜像）**：预置稳定工具链（`git`、`bash`、Node 20+、`corepack`、`pnpm`/`npm`），避免 run 时现装。
    2. **Project Cache（持久化目录，按项目隔离）**：挂载宿主机目录到沙箱 `$HOME/.tuixiu/projects/<projectId>`（或等价路径），用于保存 `pnpm store`/`npm cache`/编译缓存，避免不同项目互相污染。
    3. **Workspace Bootstrap Script（每个 Run 启动前执行）**：在 Run 工作区内执行依赖安装与最小环境准备（例如 `pnpm install --frozen-lockfile` / `npm ci`），并强制超时、日志采集与脱敏。
  - 推荐行为（MVP）：
    - 平台提供一个“默认 bootstrap”（可关闭/可覆盖），根据 lockfile 自动选择包管理器：
      - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
      - `package-lock.json` → `npm ci`
      - `yarn.lock` → `yarn install --immutable`
    - cache 目录默认指向项目隔离目录（示例）：`PNPM_STORE_DIR=$HOME/.tuixiu/projects/<projectId>/pnpm-store`、`NPM_CONFIG_CACHE=$HOME/.tuixiu/projects/<projectId>/npm-cache`
  - 配置建议（后端/项目级，优先于 role）：
    - `project.workspaceBootstrapScript`（bash，可选）：默认启用；失败则 Run 直接失败（错误码 `BOOTSTRAP_FAILED`）。
    - `project.workspaceBootstrapTimeoutSeconds`：默认 900s（安装依赖可能较慢）。
  - 脚本示例（仅示意）：
    ```bash
    set -euo pipefail
    cd "${TUIXIU_WORKSPACE:-.}"
    corepack enable >/dev/null 2>&1 || true

    PROJECT_HOME="${HOME}/${TUIXIU_PROJECT_HOME_DIR:-.tuixiu/projects/unknown}"
    export PNPM_STORE_DIR="${PROJECT_HOME}/pnpm-store"
    export NPM_CONFIG_CACHE="${PROJECT_HOME}/npm-cache"

    if [ -f pnpm-lock.yaml ]; then
      pnpm install --frozen-lockfile
    elif [ -f package-lock.json ]; then
      npm ci
    elif [ -f yarn.lock ]; then
      yarn install --immutable
    else
      echo "[bootstrap] no lockfile found, skipping install"
    fi
    ```

- **Concurrency（单 Agent 多 session）**
  - `acp-proxy` 必须支持一个 Agent 进程内多个 ACP session 并行（`newSession/loadSession/prompt` 带 `sessionId`）。
  - 并发控制：
    - `agent.max_concurrent` 控制 proxy 内并行处理的 Run 数量。
    - 后端按 `Agent.maxConcurrentRuns` 与 `currentLoad` 做调度（与 proxy 注册信息一致）。

- **Security & Privacy**
  - token/SSH key：
    - UI 只支持输入与更新，不回显明文；日志与事件必须脱敏。
    - HTTPS token 禁止拼进 clone URL/命令行参数（避免出现在 git remote/url 与系统进程列表）。
  - 沙箱：
    - BoxLite 默认隔离进程与资源；如需进一步隔离网络，作为后续版本能力（v1.1+）。

### 5. Risks & Roadmap

- **Phased Rollout**
  - MVP
    - 新增 `workspaceMode=clone` + `WORKSPACES_ROOT/REPO_CACHE_ROOT`
    - Git mirror 缓存（同机）+ TTL 清理
    - BoxLite 运行 ACP Agent（挂载工作区根目录）+ 文档化环境差异（Linux/WSL2/macOS）
    - 单 Agent 多 session 并发（可配 `max_concurrent`）
  - v1.1
    - SSH keyPath/knownHostsPath 的项目级配置（路径引用）
    - token scopes 校验与更清晰错误码
    - 缓存配额与清理策略（按大小/最近使用）
  - v2.0
    - 多仓库/多 repo Project
    - 分布式 repo cache（多机器共享）与更完整审计/RBAC

- **Technical Risks**
  - 不同平台文件系统/路径映射复杂（Windows ↔ WSL2 ↔ Box guest）：需要明确的 `pathMapping` 与统一挂载根目录策略。
  - clone/push 认证：HTTPS token 泄漏风险、SSH key 管理与 known_hosts 校验复杂。
  - 依赖安装的“平台一致性”：在 macOS/Windows 宿主 + Linux guest 的组合下，必须避免在宿主机生成 `node_modules`（或任何平台相关产物）；应在沙箱内 bootstrap，并使用项目隔离缓存目录加速。
  - 并发带来的资源竞争：单 Agent 多 session 可能导致 CPU/内存争用与输出交织，需要严格的 runId/sessionId 路由与限流。
