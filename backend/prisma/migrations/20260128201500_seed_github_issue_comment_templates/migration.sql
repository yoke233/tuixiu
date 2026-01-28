-- Seed GitHub issue comment templates (runtime configurable, platform defaults).

INSERT INTO "PlatformTextTemplate" ("key", "template", "description", "updatedAt") VALUES
(
  'github.issueComment.assigned',
  $$### ✅ 已分配执行者

- 执行者：**{{agentName}}**
{{#if roleKey}}- 角色：`{{roleKey}}`
{{/if}}
- Run：`{{runId}}`
- 状态：已分配，正在创建工作区并准备开始执行

> 由 ACP 协作台自动分配$$,
  'GitHub Issue comment: assigned',
  CURRENT_TIMESTAMP
),
(
  'github.issueComment.started',
  $$### 🚀 开始执行

- 执行者：**{{agentName}}**
{{#if roleKey}}- 角色：`{{roleKey}}`
{{/if}}
- Run：`{{runId}}`
{{#if branchName}}- 分支：`{{branchName}}`
{{/if}}

> 由 ACP 协作台自动触发执行$$,
  'GitHub Issue comment: started',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.create_pr_requested',
  $$### 🛡️ 已发起创建 PR 审批

- 动作：创建 PR
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
- 状态：待审批

> 由 ACP 协作台发起审批$$,
  'GitHub Issue comment: approval create_pr requested',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.create_pr_approved',
  $$### ✅ 审批通过，开始创建 PR

- 动作：创建 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`

> 由 ACP 协作台创建 PR$$,
  'GitHub Issue comment: approval create_pr approved',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.create_pr_rejected',
  $$### ⛔ 审批被拒绝

- 动作：创建 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
{{#if reason}}- 原因：{{reason}}
{{/if}}

> 如需继续，请重新发起审批$$,
  'GitHub Issue comment: approval create_pr rejected',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.create_pr_executed',
  $$### 🎉 PR 已创建

- 动作：创建 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`
- 状态：已创建

> 由 ACP 协作台完成创建$$,
  'GitHub Issue comment: approval create_pr executed',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.create_pr_failed',
  $$### ❌ 创建 PR 失败

- 动作：创建 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
{{#if error}}- 错误：{{error}}
{{/if}}

> 请在协作台查看错误详情后重试$$,
  'GitHub Issue comment: approval create_pr failed',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.publish_artifact_requested',
  $$### 🛡️ 已发起发布交付物审批

- 动作：发布交付物
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
- 状态：待审批

> 由 ACP 协作台发起审批$$,
  'GitHub Issue comment: approval publish_artifact requested',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.publish_artifact_approved',
  $$### ✅ 审批通过，开始发布

- 动作：发布交付物
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`

> 由 ACP 协作台执行发布$$,
  'GitHub Issue comment: approval publish_artifact approved',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.publish_artifact_rejected',
  $$### ⛔ 审批被拒绝

- 动作：发布交付物
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
{{#if reason}}- 原因：{{reason}}
{{/if}}

> 如需继续，请重新发起审批$$,
  'GitHub Issue comment: approval publish_artifact rejected',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.publish_artifact_executed',
  $$### 🎉 发布已完成

- 动作：发布交付物
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
- 状态：已发布

> 由 ACP 协作台完成发布$$,
  'GitHub Issue comment: approval publish_artifact executed',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.publish_artifact_failed',
  $$### ❌ 发布执行失败

- 动作：发布交付物
- 审批人：**{{actor}}**
- Run：`{{runId}}`
- 审批单：`{{approvalId}}`
{{#if error}}- 错误：{{error}}
{{/if}}

> 请在协作台查看错误详情后重试$$,
  'GitHub Issue comment: approval publish_artifact failed',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.merge_pr_requested',
  $$### 🛡️ 已发起合并审批

- 动作：合并 PR
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`
- 状态：待审批

> 由 ACP 协作台发起审批$$,
  'GitHub Issue comment: approval merge_pr requested',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.merge_pr_approved',
  $$### ✅ 审批通过，开始合并

- 动作：合并 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`

> 由 ACP 协作台执行合并$$,
  'GitHub Issue comment: approval merge_pr approved',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.merge_pr_rejected',
  $$### ⛔ 审批被拒绝

- 动作：合并 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`
{{#if reason}}- 原因：{{reason}}
{{/if}}

> 如需继续，请重新发起审批$$,
  'GitHub Issue comment: approval merge_pr rejected',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.merge_pr_executed',
  $$### 🎉 合并已完成

- 动作：合并 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`
- 状态：已合并

> 由 ACP 协作台完成合并$$,
  'GitHub Issue comment: approval merge_pr executed',
  CURRENT_TIMESTAMP
),
(
  'github.approvalComment.merge_pr_failed',
  $$### ❌ 合并执行失败

- 动作：合并 PR
- 审批人：**{{actor}}**
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 审批单：`{{approvalId}}`
{{#if error}}- 错误：{{error}}
{{/if}}

> 请在协作台查看错误详情后重试$$,
  'GitHub Issue comment: approval merge_pr failed',
  CURRENT_TIMESTAMP
),
(
  'github.prCreatedComment',
  $$### 🔗 已创建 PR

- 动作：创建 PR
- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
- 平台：{{providerLabel}}
{{#if sourceBranch}}{{#if targetBranch}}- 分支：`{{sourceBranch}}` → `{{targetBranch}}`
{{/if}}{{/if}}

> 由 ACP 协作台创建（best-effort 回写）$$,
  'GitHub Issue comment: PR created',
  CURRENT_TIMESTAMP
),
(
  'github.autoReviewComment',
  $$### 🧾 自动验收摘要

- Run：`{{runId}}`
{{#if prUrl}}- PR：{{prUrl}}
{{/if}}
{{#if changedFiles}}- 变更文件：{{changedFiles}}
{{/if}}
- 测试：{{ciText}}
{{#if sensitiveText}}- 敏感变更：{{sensitiveText}}
{{/if}}
{{#if nextAction}}- 建议下一步：`{{nextAction}}`{{#if reason}}（{{reason}}）{{/if}}
{{/if}}

> 由 ACP 协作台自动生成（best-effort 回写）$$,
  'GitHub Issue comment: auto review summary',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

