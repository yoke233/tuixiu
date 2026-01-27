---
title: "项目文档治理规范"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# 项目文档治理规范

**版本**：v1.0  
**适用范围**：本仓库所有文档（Markdown 为主）  
**目标**：让文档在长期演进中保持**可发现、可追溯、可执行、可维护**，避免“旧设计复活”“计划失控”“说明不一致”。

---

## 1. 总则

### 1.1 核心原则

1. **文档即代码（Docs as Code）**：文档必须走 PR、被 Review、可追溯。
2. **单一真相源（SSOT）优先**：使用/操作说明类文档必须只有一个当前有效版本。
3. **旧设计不删除，必须可追溯失效**：旧设计允许存在，但必须标注状态与替代关系。
4. **文档必须有 Owner**：没有 owner 的文档视为无人维护，必须整改或归档。
5. **让“错误使用旧文档”变得困难**：通过模板、索引、CI 校验与强制入口来约束。

### 1.2 文档分层

- **入口层**：README / 文档索引（告诉读者从哪开始）
- **架构层**：系统边界、模块划分、数据流、部署拓扑
- **模块层**：职责、接口、依赖、关键流程
- **决策层**：ADR（为什么这么做，替代了什么）
- **过程层**：协作流程、研发规范、发布流程
- **运维层**：Runbook/Oncall/故障处理

---

## 2. 仓库结构规范

推荐目录结构（可按需裁剪）：

```text
.
├─ README.md
├─ docs/
│  ├─ 00_overview/        # 项目总览/新手入口
│  ├─ 01_architecture/    # 架构与视角
│  ├─ 02_modules/         # 模块文档（按模块分文件夹）
│  ├─ 03_guides/          # 使用指南/操作指南/FAQ
│  ├─ 04_decisions/       # ADR：设计决策记录
│  ├─ 05_process/         # 流程规范（PR、发布、测试等）
│  ├─ 06_runbooks/        # 运维手册/故障手册
│  └─ _meta/              # 文档规范本身、模板、词汇表
```

### 2.1 README 规范

`README.md` 仅包含：

- 项目一句话定位
- 快速开始（最短路径）
- 文档入口索引（链接到 docs）
- 贡献方式（链接到流程文档）

禁止：把 README 写成全量说明书。

---

## 3. 文档类型与强制规则

### 3.1 文档类型（DocType）

| 类型 | 目录建议 | 允许保留历史版本 | 强制 SSOT |
| --- | --- | ---: | ---: |
| 架构设计 Architecture | `01_architecture/` | ✅（以 deprecated/archived 管理） | ❌ |
| 模块文档 Module | `02_modules/` | ✅（但需标注状态） | ⚠️（接口文档尽量 SSOT） |
| 使用/操作指南 Guide | `03_guides/` | ❌（历史靠 Git） | ✅ |
| ADR 决策记录 | `04_decisions/` | ✅（不可修改结论，只能追加新 ADR 替代） | ✅（索引指向最新） |
| 计划/Roadmap/方案草稿 | `00_overview/` 或 `05_process/` | ✅（必须有结局） | ❌ |
| Runbook 运维手册 | `06_runbooks/` | ❌（必须保持最新） | ✅ |

---

## 4. 文档元数据（强制）

所有 **设计/计划/模块** 文档必须在开头包含 YAML Front Matter：

```md
---
title: "RAG 架构设计 v2"
owner: "@arch-team"
status: "active"            # draft | active | deprecated | archived
last_reviewed: "2026-01-27" # YYYY-MM-DD
superseded_by: ""           # 若 deprecated，必须填写替代文档相对路径
related_issues: ["#123", "#456"]
---
```

### 4.1 状态定义

- `draft`：草案，不可作为实施依据
- `active`：当前有效，可作为实施依据
- `deprecated`：已失效，但保留供追溯；必须指向替代文档
- `archived`：历史归档，仅存档；不得在入口索引中出现

### 4.2 强制规则

- `owner` 必填（团队/人均可）
- `status=deprecated` 时 `superseded_by` 必填
- `last_reviewed` 必填（由 owner 定期更新）

---

## 5. 失效与替代治理（关键）

### 5.1 失效声明必须置顶

任何 `deprecated` 文档必须在正文最顶部放置醒目提示：

```md
> ⚠️ **已失效（Deprecated）**
> 本文档已于 2026-01-20 失效。
> 当前有效方案请参考： [xxx](../01_architecture/xxx.md)
```

### 5.2 “替代关系”优于“版本号”

禁止用 `design-v1.md / design-v2.md / final.md` 来表达当前有效性。  
允许存在多个历史文档，但必须通过 `status + superseded_by` 构成链路。

### 5.3 旧设计不删除

设计/决策类文档原则上不删除，以保证：

- 事故追溯
- 决策复盘
- 新人理解演进脉络

---

## 6. ADR（Architecture Decision Record）规范

### 6.1 命名

`docs/04_decisions/NNNN-short-title.md`  
例：`0007-vector-db-milvus.md`

### 6.2 ADR 不可“改结论”

ADR 一旦合入：

- 允许修正错别字/链接
- 不允许改“决策结论”
- 若要推翻旧决策：**新增 ADR**，并在新 ADR 中声明替代关系

### 6.3 ADR 模板

```md
---
title: "ADR-0007 选择 Milvus 作为向量库"
owner: "@arch-team"
status: "active"
last_reviewed: "2026-01-27"
supersedes: ["0003-es-vector-search.md"]
---

## 背景
## 选项
## 决策
## 影响/后果（利弊）
## 迁移/落地计划（如需要）
```

---

## 7. 计划/方案文档必须“有结局”

计划类文档（roadmap、POC 方案、阶段计划）必须包含：

- 目标
- 时间窗/里程碑
- 验收标准（Definition of Done）
- 风险与依赖
- 结局字段（完成/取消/延期原因）

### 7.1 结局规则

计划类文档在关闭时必须转为：

- 完成 → `status=archived` + `result=done`
- 放弃 → `status=archived` + `result=cancelled` + `reason=...`

---

## 8. 索引与入口规范（避免“到处都是真相”）

### 8.1 必须有文档索引页

维护一个权威入口：`docs/00_overview/index.md`，包含：

- 新人阅读路径
- 当前有效架构链接
- 模块列表
- 运行/部署/故障处理入口
- ADR 索引（只列 active）

### 8.2 入口不得链接 deprecated/archived

README、Index、Guides 禁止直接引用 `deprecated/archived` 文档（除非是“历史回顾”专栏）。

---

## 9. PR 与评审规则（让文档“不得不更新”）

### 9.1 PR 模板（强制）

每个 PR 必须回答：

- 本次变更是否影响文档？
  - 是：提供文档链接或说明已更新位置
  - 否：说明原因

### 9.2 触发条件建议（可在流程中明确）

- 新增/变更 API：必须更新模块文档/接口文档
- 修改关键流程/架构：必须新增或更新 ADR/架构文档
- 变更部署/配置：必须更新 Guides/Runbook（SSOT）

### 9.3 文档 Review 责任

- 文档修改必须被 owner 或其授权 reviewer review
- 架构/ADR 必须至少 1 位架构 owner approve（规则可在 CODEOWNERS 里落实）

---

## 10. 文档质量规范

### 10.1 必写内容（按类型）

- 架构：边界、组件关系、数据流、部署视角、关键约束
- 模块：职责/不负责、接口、依赖、关键流程、FAQ
- Guide/Runbook：步骤、前置条件、验证方法、回滚/应急

### 10.2 禁止事项

- 禁止过期使用指南长期存在（必须 SSOT）
- 禁止在文档里埋“未来计划”却不维护（请放计划文档并要求结局）
- 禁止“只贴截图不解释”（截图必须配文字说明与版本/日期）

---

## 11. 审核节奏与维护 SLA

### 11.1 Review 周期建议

- `active` 架构/模块文档：每 1~3 个月 review 一次
- `runbooks/guides`：变更即更新（随代码/配置）
- `deprecated`：保持可跳转到替代方案即可，不要求频繁更新

### 11.2 过期处理

发现 `last_reviewed` 超过约定周期的 active 文档：

- owner 必须更新或降级为 deprecated/archived
- 若无人维护：必须指派 owner 或归档并从索引移除

---

## 12. 自动化与 CI 校验（推荐项，但强烈建议上）

建议在 CI 做以下校验（可逐步启用）：

1. **Front matter 必填校验**（owner/status/last_reviewed）
2. **dead link 检查**
3. **入口索引禁止引用 deprecated/archived**
4. **ADR 编号唯一且有索引**
5. **标题层级/格式规范检查**

自动化目标：把“文档治理”从人肉变成系统约束。

本仓库已落地（最小可用）：

- 本地/CI 校验脚本：`scripts/docs_lint.py`（Front Matter 必填 + `docs/context-manifest.json` 路径有效性）
- GitHub Action：`.github/workflows/docs-lint.yml`

---

## 13. 安全与合规（如适用）

- 文档不得包含：密钥、token、内部 IP/账号口令、客户敏感信息
- 如需示例：使用脱敏示例或占位符
- 对外发布文档与内部文档必须明确边界（可在目录区分或用标签）

---

## 14. 模板清单（建议在 docs/_meta/templates 维护）

- `docs/_meta/templates/module-template.md`
- `docs/_meta/templates/architecture-template.md`
- `docs/_meta/templates/adr-template.md`
- `docs/_meta/templates/plan-template.md`
- `docs/_meta/templates/runbook-template.md`

并在 `docs/_meta/` 维护本规范及“文档写作风格指南”。

---

## 15. 执行与例外

- 本规范默认对所有新文档生效
- 旧文档可逐步治理：先补齐 `owner/status/superseded_by`
- 例外必须在 PR 描述中说明，并由 owner 审批

---

## 附录 A：模块文档模板（简版）

```md
---
title: "模块：Auth"
owner: "@backend-team"
status: "active"
last_reviewed: "2026-01-27"
---

## 职责
## 不负责
## 对外接口
## 关键流程
## 数据与存储
## 依赖
## 常见问题
```

---

## 附录 B：Runbook 模板（简版，SSOT）

```md
---
title: "Runbook：服务无法启动"
owner: "@sre-team"
status: "active"
last_reviewed: "2026-01-27"
---

## 现象
## 影响范围
## 快速定位
## 处理步骤
## 验证方法
## 回滚/应急
## 事后复盘要点
```
