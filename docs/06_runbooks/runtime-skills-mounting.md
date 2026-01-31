---
title: "运行时 Skills 挂载（MVP）Runbook"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-31"
---

# 运行时 Skills 挂载（MVP）Runbook

本文档描述 Phase 2 的运行时技能挂载闭环：backend 下发 `skillsManifest`，acp-proxy 负责下载/缓存/解压/校验并为每个 run 生成专用 `CODEX_HOME/skills` 视图目录，再通过 env allowlist 注入 `CODEX_HOME` 使 agent 生效。

---

## 1. 前置条件

- 已导入所需 skill（Admin → Skills）。
- 角色模板已配置启用 skills（Admin → 角色模板 → 启用 Skills）。
  - `latest` 策略要求 Skill 已发布 `latestVersionId`
  - `pinned` 策略要求选择 `pinnedVersionId`
- acp-proxy 配置了可访问 backend 的 `orchestrator_url`，并设置 `auth_token`（用于下载 skill 包）。

---

## 2. 开关（必须同时开启）

运行时挂载只有在两个开关都为真时才会生效：

1) 项目级：`enableRuntimeSkillsMounting=true`  
2) acp-proxy：`skills_mounting_enabled=true`

### 2.1 开启 acp-proxy 开关

编辑 `acp-proxy/config.toml`：

```toml
skills_mounting_enabled = true
```

### 2.2 开启项目级开关（当前仅后端字段）

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

- backend：run 初始化时解析角色启用配置（`latest/pinned` → `skillVersionId`），下发 `skillsManifest`：
  - `runId`
  - `skillVersions[] { skillId, skillName, skillVersionId, contentHash, storageUri }`
- acp-proxy：
  - 按 `contentHash` 下载并缓存 zip：`~/.tuixiu/acp-proxy/skills-cache/zips/<hash>.zip`
    - 下载体积受 `skills_download_max_bytes` 限制（默认 200MB；可用 `ACP_PROXY_SKILLS_DOWNLOAD_MAX_BYTES` 覆盖）
  - 安全解压（拒绝 ZipSlip / symlink），并校验目录 hash 与 `contentHash` 一致
  - 为 run 创建工作区内视图目录：`<workspace>/.tuixiu/codex-home/skills/<kebab(skillName)>/`
  - 通过 env allowlist 注入 `CODEX_HOME`：
    - container/boxlite：`CODEX_HOME=/workspace/.tuixiu/codex-home`
    - host_process：`CODEX_HOME=<workspaceHostPath>\\.tuixiu\\codex-home`
- run 结束：清理 run 视图目录（缓存保留，便于复用与加速）。

---

## 4. 端到端验证（Checklist）

1. 在 Skills 页导入一个 skill（建议先发布为 latest，或使用 pinned）。
2. 在角色模板启用该 skill，并选择 `latest` 或指定 `pinned` 版本。
3. 开启两个开关后启动一个 run。
4. 在 sandbox/workspace 内检查：
   - `CODEX_HOME` 环境变量已设置
   - `CODEX_HOME/skills/<skill>/SKILL.md` 存在

---

## 5. 排障

### 5.1 下载失败 / 401

- 现象：proxy 日志出现 `skills download failed`，状态码 401/403。
- 排查：
  - `acp-proxy/config.toml` 是否配置 `auth_token`
  - backend 是否允许该 token 访问 `/api/acp-proxy/skills/packages/*.zip`

### 5.2 Hash mismatch

- 现象：`skills package contentHash mismatch`
- 处理：
  - 删除缓存目录 `~/.tuixiu/acp-proxy/skills-cache` 后重试
  - 确认 SkillVersion 的 `contentHash` 与实际包内容一致

### 5.3 未注入 CODEX_HOME

- 现象：agent 内看不到 `CODEX_HOME/skills`
- 排查：
  - 是否同时开启项目与 proxy 开关
  - `agent_env_allowlist` 是否包含 `CODEX_HOME`（默认包含）
  - 是否为该 role 启用了 skills（且 enabled=true）
