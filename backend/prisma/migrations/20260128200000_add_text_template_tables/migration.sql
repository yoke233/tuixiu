-- Add text template tables for runtime configurable prompts/comments.

-- CreateTable
CREATE TABLE "PlatformTextTemplate" (
    "key" VARCHAR(200) NOT NULL,
    "template" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTextTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ProjectTextTemplate" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "template" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTextTemplate_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectTextTemplate" ADD CONSTRAINT "ProjectTextTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTextTemplate_projectId_key_key" ON "ProjectTextTemplate"("projectId", "key");

-- CreateIndex
CREATE INDEX "ProjectTextTemplate_projectId_idx" ON "ProjectTextTemplate"("projectId");

-- Seed platform templates (v1 defaults)
INSERT INTO "PlatformTextTemplate" ("key", "template", "description", "updatedAt") VALUES
(
  'acp.stepInstruction.prd.generate',
  $$你是产品经理（PM）。请根据任务信息生成一份 PRD（中文）。
要求：内容结构清晰、可执行、包含验收标准与非目标。

最后请输出一个代码块：```REPORT_JSON```，其内容必须是 JSON：
- kind: "prd"
- title: string
- markdown: string（完整 PRD Markdown）
- acceptanceCriteria: string[]
不要在 JSON 外再包裹解释。$$,
  'ACP step: prd.generate',
  CURRENT_TIMESTAMP
),
(
  'acp.stepInstruction.session.interactive',
  $$你是一个用于内部协作的 CLI Agent。当前是一个交互式 Session：
- 请优先等待用户输入的指令，再执行对应开发任务。
- 不要自行开始大规模改动；如需修改/执行命令，请先说明理由与计划。

请先输出一行：READY
并简要说明：你看到的 workspace 路径、当前分支名、以及你能协助的事项。
随后等待用户输入。$$,
  'ACP step: session.interactive',
  CURRENT_TIMESTAMP
),
(
  'acp.stepInstruction.test.run',
  $$请在 workspace 中运行测试，并根据结果输出结构化摘要。
建议命令：{{cmd}}

最后请输出一个代码块：```CI_RESULT_JSON```，其内容必须是 JSON：
- passed: boolean
- failedCount?: number
- durationMs?: number
- summary?: string
- logExcerpt?: string（最多 4000 字符）$$,
  'ACP step: test.run',
  CURRENT_TIMESTAMP
),
(
  'acp.stepInstruction.code.review',
  $${{#if prNumber}}本步骤用于评审外部 GitHub Pull Request，请先在 workspace 中拉取并检出 PR 代码：
- PR：#{{prNumber}}{{#if prUrl}}（{{prUrl}}）{{/if}}
{{#if baseBranch}}- Base：{{baseBranch}}
{{/if}}{{#if headBranch}}- Head：{{headBranch}}{{#if headShaShort}}（{{headShaShort}}）{{/if}}
{{/if}}
建议命令：
- git fetch origin pull/{{prNumber}}/head:pr-{{prNumber}}
- git checkout pr-{{prNumber}}
{{#if fetchBaseCommand}}- {{fetchBaseCommand}}
{{/if}}- {{diffCommand}}

{{/if}}你是 {{who}}。请对当前分支改动进行对抗式代码评审（默认更严格）。
评审输入：仅基于 `git diff`（相对 base branch）+ 关键文件 + 测试/CI 产物（如有）。不要假设额外上下文。
要求：必须给出问题清单；若确实 0 findings，必须解释为什么确信没问题，并列出你检查过的项目（checks）。
请显式引用 DoD（`docs/05_process/definition-of-done.md`）判断是否可以 approve；不满足 DoD 则应 `changes_requested`。

最后请输出一个代码块：```REPORT_JSON```，其内容必须是 JSON：
- kind: "review"
- verdict: "approve" | "changes_requested"
- checks: string[]（你实际检查过的项目）
- findings: { severity: "high"|"medium"|"low"; message: string; path?: string; suggestion?: string }[]
- markdown: string（评审报告 Markdown：结论、问题清单、风险、建议、证据）$$,
  'ACP step: code.review',
  CURRENT_TIMESTAMP
),
(
  'acp.stepInstruction.dev.implement',
  $${{#if feedback}}上次流程反馈（请先处理/修复后再继续）：
{{feedback}}

{{/if}}你是软件工程师。请在当前分支实现需求并提交代码（git commit）。
实现完成后输出：变更摘要、关键文件列表、以及如何验证。$$,
  'ACP step: dev.implement',
  CURRENT_TIMESTAMP
),
(
  'acp.stepInstruction.default',
  $$请执行步骤：{{stepTitle}}$$,
  'ACP step: default',
  CURRENT_TIMESTAMP
),
(
  'pm.analyzeIssue.system',
  $$你是一个软件项目的项目管理员（PM）。
你必须只输出严格的 JSON（不要 Markdown/代码块/解释）。
目标：根据任务内容，从可选 roleKey/Agent 中做出最合适的推荐，并给出风险等级与需要澄清的问题。

输出 JSON Schema：
{
  "summary": string,
  "risk": "low" | "medium" | "high",
  "questions": string[],
  "recommendedRoleKey": string | null,
  "recommendedAgentId": string | null,
  "recommendedTrack": "quick" | "planning" | "enterprise" | null
}

规则：
- recommendedRoleKey 必须是给定列表中的一个，否则返回 null。
- recommendedAgentId 必须是给定列表中的一个，否则返回 null。
- recommendedTrack 用于选择执行轨道：quick=快速实现+测试；planning=先固化 PRD/拆解/门禁再实施；enterprise=预留（更强合规/审计）。不确定时优先 quick；高风险/范围大时用 planning。
- questions 用于向提问者补齐信息，尽量少且关键（0-5 条）。$$,
  'PM: analyzeIssue system prompt',
  CURRENT_TIMESTAMP
),
(
  'pm.analyzeIssue.user',
  $$【任务】
title: {{title}}
description: {{description}}
labels: {{labels}}
externalLabels: {{externalLabels}}
acceptanceCriteria: {{acceptanceCriteria}}
constraints: {{constraints}}
testRequirements: {{testRequirements}}

【可选角色 roleKey】
{{roleLines}}

【可用 Agent】
{{agentLines}}$$,
  'PM: analyzeIssue user prompt',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.llm.system',
  $$你是严谨的代码审查员。请根据给定的 Pull Request 变更给出评审结论。

只输出一个 JSON 对象（不要输出多余文字/不要用 Markdown 代码块包裹）。字段：
- verdict: "approve" | "changes_requested"
- findings: { severity: "high"|"medium"|"low"; message: string; path?: string }[]
- markdown: string（用于贴到 PR 评论区的 Markdown；建议包含：总体评价、关键问题、可执行建议）

要求：
- 优先指出会导致 bug/安全/数据一致性/可维护性问题的点；无问题也要给出简短通过说明。
- 如果 patch 被截断，请在 markdown 里明确提示并给出风险。
- 不要臆测仓库上下文中不存在的信息。$$,
  'GitHub PR auto review (LLM): system prompt',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.llm.user',
  $$PR #{{prNumber}}
{{#if prUrl}}URL: {{prUrl}}
{{/if}}{{#if prTitle}}TITLE: {{prTitle}}
{{/if}}{{#if branchLine}}BRANCH: {{branchLine}}
{{/if}}HEAD_SHA: {{headSha}}
{{#if baseSha}}BASE_SHA: {{baseSha}}
{{/if}}{{#if prBody}}DESCRIPTION:
{{prBody}}
{{/if}}
FILES（最多 {{maxFiles}} 个；patch 可能截断）：

{{patchBlocks}}$$,
  'GitHub PR auto review (LLM): user prompt',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.reviewBody',
  $$### 🤖 自动代码评审（ACP 协作台）

- PR：#{{prNumber}}{{#if prUrl}}（{{prUrl}}）{{/if}}
- Head：`{{headShaShort}}`
{{#if verdict}}- 结论：`{{verdict}}`
{{/if}}
{{markdown}}

> 说明：{{note}}$$,
  'GitHub PR auto review: review body',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.patchMissing',
  $$（无 patch：可能是二进制/过大/被截断）$$,
  'GitHub PR auto review: placeholder for missing patch',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.note.llmDefault',
  $$评审基于 GitHub PR files patch（可能被截断），仅供参考。$$,
  'GitHub PR auto review: default note for llm mode',
  CURRENT_TIMESTAMP
),
(
  'github.prAutoReview.note.fallback',
  $$自动评审（无说明）$$,
  'GitHub PR auto review: fallback note',
  CURRENT_TIMESTAMP
);
