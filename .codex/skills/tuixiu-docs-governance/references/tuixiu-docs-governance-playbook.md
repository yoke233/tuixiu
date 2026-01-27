# Tuixiu 文档治理落地清单（Playbook）

目标：让“误用旧文档”变得困难；让当前文档可发现、可追溯、可执行。

## 0) 权威规范

先阅读并以此为准：`docs/_meta/docs-governance.md`

## 1) 处理“旧文档经常被看”的最小闭环

按优先级执行（先挡住误用）：

1. **入口去引用**：从 `README.md`、`docs/README.md`、各类 Guide 中移除对旧文档的直接链接。
2. **归档到固定目录**：把不再建议阅读的旧文档移动到 `docs/archive/`（按主题分子目录，例如 `docs/archive/plans/`）。
3. **置顶醒目标识**：对 `docs/archive/**` 的文档在顶部加入“已归档/已过期”提示，并链接到当前有效文档（如有）。

> 备注：比起改文件名，**移动到 `docs/archive/` + 置顶提示 + 入口去引用** 更稳，不易破坏引用。

### 文件名要不要加“已过期/archived”？

- **默认不需要**：目录归档 + 置顶提示已经能显著降低误用。
- **需要时再做**（成本更高）：若团队仍频繁从搜索结果点开旧文件，可考虑在归档文件名加后缀（如 `-archived.md`），但务必同时更新仓库内所有引用（`rg -n "旧路径"` 全量替换）。

## 2) SSOT：哪些文档只能有一个“当前版本”

按规范，以下类型必须强制 SSOT（不要保留“旧版指南”作为并列文件）：

- 使用/操作指南（Guides）
- Runbook/故障处理

做法：

- 旧版内容通过 Git 历史追溯（不要在 `docs/` 里并列留多份“指南-v1/v2”）。
- 如果必须保留历史（例如事故复盘引用），移动到 `docs/archive/`，并在入口索引中仅保留当前版本。

## 3) 设计/计划/模块文档的“状态治理”

对设计/计划/模块文档，至少做到：

- 有明确 `owner`
- 有明确 `status`（draft/active/deprecated/archived）
- `deprecated` 必须指向替代文档（`superseded_by` 或正文链接）

在尚未完成目录迁移前，可以先用“置顶提示”兜底（后续再补 Front Matter）。

## 4) 快速巡检命令（PowerShell）

定位入口是否引用了归档文档：

```powershell
rg -n "docs/archive/" README.md docs
```

定位可能“过时/草案/待补”的文档：

```powershell
rg -n "(已过期|已废弃|deprecated|archived|draft|TODO|WIP|旧版)" docs
```

## 5) 下一步（可选落地项）

当你准备把治理变成“系统约束”时，再逐步引入：

- `docs/00_overview/index.md` 作为权威索引入口（README 只链接它）
- PR 模板强制回答“是否影响文档”
- CI 校验：Front Matter 必填、dead link、入口禁止引用 deprecated/archived（除“历史回顾”）

