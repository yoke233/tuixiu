---
title: "运行时 Skills 挂载（MVP）Runbook"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-02-02"
---

# 运行时 Skills 挂载（MVP）Runbook

本文档描述 Phase 2 的运行时技能挂载闭环：backend 在 `acp_open.init` 中下发统一输入清单 `agentInputs`，acp-proxy 按清单下载/安全解压并将 skills 落地到 `USER_HOME/.codex/skills`（即 `~/.codex/skills`），agent 无需依赖 `CODEX_HOME`。

---

## 1. 前置条件

- 已导入所需 skill（Admin → Skills）。
- 角色模板已配置启用 skills（Admin → 角色模板 → 启用 Skills）。
  - `latest` 策略要求 Skill 已发布 `latestVersionId`
  - `pinned` 策略要求选择 `pinnedVersionId`
- acp-proxy 配置了可访问 backend 的 `orchestrator_url`，并设置 `auth_token`（用于下载 skill 包）。

---

## 2. 开关（必须同时开启）

运行时挂载当前受一个项目级开关控制：

1) 项目级：`enableRuntimeSkillsMounting=true`

> 说明：旧的 `skills_mounting_enabled`（acp-proxy）已不再作为生效条件；skills 是否下发由 backend 决定（项目开关 + 角色绑定）。

### 2.1 开启项目级开关（当前仅后端字段）

项目创建/更新接口支持 `enableRuntimeSkillsMounting` 字段。示例（PowerShell）：

```powershell
$token = "<admin-jwt>"
$projectId = "<project-uuid>"

Invoke-RestMethod -Method Patch `
  -Uri "http://localhost:3000/api/admin/projects/$projectId" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body (@{ enableRuntimeSkillsMounting = $true } | ConvertTo-Json)
```

---

## 3. 工作原理（实现要点）

- backend：run 初始化时解析角色启用配置（`latest/pinned` → `skillVersionId`），构造 `agentInputs`：
  - `agentInputs.version=1`
  - `agentInputs.items[]`：包含 workspace bindMount 与每个 skill 的 `downloadExtract` 项（`source.httpZip` + `target.USER_HOME/.codex/skills/<kebab>`）
  - 同时在 `init.env` 中提供 `USER_HOME`（沙盒内 `~`）与 bwrap user view 参数（`TUIXIU_BWRAP_*`）
- acp-proxy：
  - 按 `agentInputs.items[]` 顺序执行：下载 zip 并安全解压（拒绝 ZipSlip / symlink；限制文件数/大小）
  - zip 缓存路径：`~/.tuixiu/acp-proxy/inputs-cache/zips/<hash>.zip`
    - 下载体积受 `skills_download_max_bytes` 限制（默认 200MB；可用 `ACP_PROXY_SKILLS_DOWNLOAD_MAX_BYTES` 覆盖）
  - skills 最终路径（沙盒内）：`~/.codex/skills/<skill>/SKILL.md`

### 3.1 无仓库初始化角色（workspacePolicy=empty）

- workspace 仍然存在，但不会执行 repo clone。
- init pipeline 仍会生成 `context-inventory`（用于审计/溯源）。
- 适用于技能审查、策略评估等无需代码仓库的角色。

---

## 4. 端到端验证（Checklist）

1. 在 Skills 页导入一个 skill（建议先发布为 latest，或使用 pinned）。
2. 在角色模板启用该 skill，并选择 `latest` 或指定 `pinned` 版本。
3. 开启项目开关后启动一个 run。
4. 在 sandbox 内检查：
   - `USER_HOME` 与 `HOME` 一致（`echo $USER_HOME; echo $HOME`）
   - `~/.codex/skills/<skill>/SKILL.md` 存在
   - `workspace/.tuixiu/context-inventory.json` 已生成

---

## 5. 排障

### 5.1 下载失败 / 401

- 现象：proxy 日志出现 `agentInputs download failed`，状态码 401/403。
- 排查：
  - `acp-proxy/config.toml` 是否配置 `auth_token`
  - backend 是否允许该 token 访问 `/api/acp-proxy/skills/packages/*.zip`

### 5.2 解压失败 / ZipSlip / symlink

- 现象：`zip entry path is not allowed` / `zip entry symlink is not allowed` / `zip too large` 等错误。
- 处理：
  - 确认 skill 包来源可信且内容符合约束（不包含危险路径/符号链接）
  - 必要时清理缓存目录 `~/.tuixiu/acp-proxy/inputs-cache` 后重试（会触发重新下载）

### 5.3 skills 不可见（~/.codex/skills 为空）

- 现象：agent 内 `ls ~/.codex/skills` 为空或不存在。
- 排查：
  - 项目是否开启 `enableRuntimeSkillsMounting=true`
  - 是否为该 role 启用了 skills（且 enabled=true，且 latest/pinned 配置正确）
  - `agent_env_allowlist` 是否包含 `USER_HOME/HOME`（默认包含）

### 5.4 bwrap 排障（whoami/getpwuid/HOME/workspace）

- whoami/getpwuid 失败：
  - 现象：`whoami` 报错或返回 `unknown`；Node `os.userInfo()` 抛异常
  - 排查：`/etc/passwd` 是否可读、是否包含当前 uid 的条目（bwrap 通过绑定 fake passwd 提供）
- HOME 不一致：
  - 现象：`echo $HOME` 与 `echo $USER_HOME` 不一致，导致 `~/.codex/skills` 不可见
  - 排查：确认 `init.env` 中的 `USER_HOME` 与 `TUIXIU_BWRAP_HOME_PATH` 一致；确认 `agent_env_allowlist` 放行 `HOME/USER_HOME`
- workspace 未绑定：
  - 现象：agent 启动后 cwd 不在 `/workspace`，相对路径异常
  - 排查：确认 bwrap 参数包含 `--bind <workspaceHostPath> /workspace` 与 `--chdir /workspace`
