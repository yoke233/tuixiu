# GitLab 集成文档

本文档说明如何集成 GitLab API 和 Webhook，实现 MR 创建、CI 状态监听等功能。

> 补充：系统也已支持 GitHub PR（同一套 `/api/runs/:id/create-pr` / `/api/runs/:id/merge-pr` 端点），见文末“GitHub PR（已实现）”。

---

## 1. GitLab API 概述

### 1.1 认证方式

使用 **Personal Access Token**（已在环境搭建时创建）

**Header 格式**:

```
PRIVATE-TOKEN: glpat-xxxxxxxxxxxxxxxxxxxx
```

### 1.2 API 基础 URL

```
https://gitlab.example.com/api/v4
```

### 1.3 关键 API 端点

| 端点                                   | 方法 | 说明             |
| -------------------------------------- | ---- | ---------------- |
| `/projects/:id`                        | GET  | 获取项目信息     |
| `/projects/:id/merge_requests`         | POST | 创建 MR          |
| `/projects/:id/merge_requests/:mr_iid` | GET  | 查询 MR 详情     |
| `/projects/:id/pipelines/:pipeline_id` | GET  | 查询 CI Pipeline |
| `/projects/:id/repository/branches`    | GET  | 列出分支         |
| `/projects/:id/repository/branches`    | POST | 创建分支         |

---

## 2. 创建 Merge Request

### 2.1 API 调用

**端点**: `POST /api/v4/projects/:project_id/merge_requests`

**请求示例**:

```http
POST /api/v4/projects/123/merge_requests HTTP/1.1
Host: gitlab.example.com
PRIVATE-TOKEN: glpat-xxxxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "source_branch": "acp/issue-456/run-789",
  "target_branch": "main",
  "title": "[ACP] #456 Fix user login bug",
  "description": "## Issue\n#456\n\n## Changes\n- Fixed password validation\n- Added error handling\n\n## Acceptance Criteria\n✅ Users can login with email\n✅ Error messages are clear",
  "remove_source_branch": true,
  "squash": false
}
```

**响应示例**:

```json
{
  "id": 12345,
  "iid": 456,
  "project_id": 123,
  "title": "[ACP] #456 Fix user login bug",
  "state": "opened",
  "web_url": "https://gitlab.example.com/org/project/-/merge_requests/456",
  "source_branch": "acp/issue-456/run-789",
  "target_branch": "main",
  "author": {...},
  "created_at": "2026-01-25T10:30:00Z"
}
```

### 2.2 代码实现（Node.js / TypeScript）

```typescript
interface CreateMRParams {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

async function createMergeRequest(params: CreateMRParams) {
  const url = `${process.env.GITLAB_URL}/api/v4/projects/${params.projectId}/merge_requests`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      title: params.title,
      description: params.description,
      remove_source_branch: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create MR: ${error}`);
  }

  const mr = await response.json();

  return {
    id: mr.id,
    iid: mr.iid,
    web_url: mr.web_url,
  };
}
```

---

## 附：GitHub PR（已实现）

### 配置

创建 Project 时：

- `scmType: "github"`
- `repoUrl`: `https://github.com/<owner>/<repo>.git`（或 GitHub Enterprise 的仓库地址）
- `githubAccessToken`: `ghp_...` / `github_pat_...`

> 说明：GitHub Enterprise 会根据 `repoUrl` 的 host 自动推导 API base（`https://<host>/api/v3`）。

### API 端点（与 GitLab 共用）

- `POST /api/runs/:id/create-pr`：创建 PR（后端会先 `git push -u origin <branch>`）
- `POST /api/runs/:id/merge-pr`：合并 PR（merge method：`merge`；若请求带 `squash=true` 则用 `squash`）

### 产物落库

创建 PR 后会写入 `Artifact(type=pr)`，`content.provider = "github"`，并包含：

- `number`（PR 编号）、`webUrl`、`state`、`sourceBranch`、`targetBranch`
```

### 2.3 何时创建 MR

**触发时机**: Agent 报告"已创建分支"

**流程**:

```
[Codex] → stdout: "Branch created: acp/issue-123/run-456"
   ↓
[ACP Proxy] → WebSocket: {type: "branch_created", branch: "..."}
   ↓
[Orchestrator] → GitLab API: Create MR
   ↓
[Orchestrator] → DB: Save Artifact (type: 'pr', content: {mr_url, ...})
   ↓
[Orchestrator] → WebSocket: Push to Web UI
   ↓
[Web UI] → Display: "PR 已创建: !456 [查看]"
```

**实现要点**:

```typescript
// 在 Orchestrator 的 WebSocket 处理器中
async function handleBranchCreated(message: any) {
  const { run_id, branch } = message;

  // 1. 查询 Run 和 Issue 信息
  const run = await Run.findById(run_id);
  const issue = await Issue.findById(run.issue_id);

  // 2. 构造 MR 标题和描述
  const title = `[ACP] #${issue.id} ${issue.title}`;
  const description = `
## Issue
#${issue.id}

## Description
${issue.description}

## Acceptance Criteria
${issue.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
  `;

  // 3. 调用 GitLab API
  const mr = await createMergeRequest({
    projectId: issue.project.gitlab_project_id,
    sourceBranch: branch,
    targetBranch: issue.project.default_branch,
    title,
    description,
  });

  // 4. 保存 Artifact
  await Artifact.create({
    run_id: run.id,
    type: "pr",
    content: {
      mr_id: mr.id,
      mr_iid: mr.iid,
      mr_url: mr.web_url,
      branch: branch,
    },
  });

  // 5. 更新 Run 状态
  await run.update({ status: "waiting_ci" });

  // 6. 创建 Event
  await Event.create({
    run_id: run.id,
    source: "gitlab",
    type: "git.pr.created",
    payload: { mr_url: mr.web_url },
  });
}
```

---

## 3. Webhook 配置

### 3.1 在 GitLab 中配置

1. 进入项目 **Settings → Webhooks**
2. 填写表单:
   - **URL**: `https://your-domain.com/webhooks/gitlab`
   - **Secret Token**: `your-generated-secret`（环境变量中的值）
   - **Trigger**:
     - ✅ Merge request events
     - ✅ Pipeline events
3. **SSL verification**: 如果使用 HTTPS，启用
4. 点击 **Add webhook**

### 3.2 测试 Webhook

点击 **Test** → **Merge request events**，应该看到成功响应。

查看 Orchestrator 日志:

```
[INFO] Received webhook: merge_request (opened)
```

---

## 4. Webhook 处理

### 4.1 路由定义

```typescript
// routes/webhooks.ts
app.post("/webhooks/gitlab", async (req, res) => {
  try {
    // 1. 验证 Secret Token
    const token = req.headers["x-gitlab-token"];
    if (token !== process.env.GITLAB_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // 2. 解析事件类型
    const eventType = req.headers["x-gitlab-event"];

    // 3. 分发处理
    if (eventType === "Merge Request Hook") {
      await handleMergeRequestEvent(req.body);
    } else if (eventType === "Pipeline Hook") {
      await handlePipelineEvent(req.body);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Internal error" });
  }
});
```

### 4.2 MR 事件处理

**Webhook Payload 示例** (Merge Request opened):

```json
{
  "object_kind": "merge_request",
  "event_type": "merge_request",
  "user": {...},
  "project": {...},
  "object_attributes": {
    "id": 12345,
    "iid": 456,
    "title": "[ACP] #123 Fix login bug",
    "state": "opened",
    "source_branch": "acp/issue-123/run-789",
    "target_branch": "main",
    "action": "open"
  }
}
```

**处理逻辑**:

```typescript
async function handleMergeRequestEvent(payload: any) {
  const { object_attributes } = payload;
  const action = object_attributes.action; // open, update, merge, close

  // 从分支名提取 run_id
  // 格式: acp/issue-{issue_id}/run-{run_id}
  const branchName = object_attributes.source_branch;
  const match = branchName.match(/acp\/issue-\d+\/run-(\w+)/);

  if (!match) {
    return; // 不是 ACP 创建的 MR
  }

  const runId = match[1];

  // 根据 action 处理
  switch (action) {
    case "merge":
      // MR 已合并
      await handleMRMerged(runId, object_attributes);
      break;
    case "close":
      // MR 被关闭（未合并）
      await handleMRClosed(runId);
      break;
    case "update":
      // MR 更新（可能是新提交）
      await handleMRUpdated(runId, object_attributes);
      break;
  }
}

async function handleMRMerged(runId: string, mrData: any) {
  // 1. 更新 Run 状态
  await Run.update({ id: runId }, { status: "completed" });

  // 2. 更新 Issue 状态
  const run = await Run.findById(runId);
  await Issue.update({ id: run.issue_id }, { status: "done" });

  // 3. 创建 Event
  await Event.create({
    run_id: runId,
    source: "gitlab",
    type: "git.pr.merged",
    payload: { mr_url: mrData.url },
  });

  console.log(`✅ Run ${runId} completed (MR merged)`);
}
```

### 4.3 Pipeline 事件处理

**Webhook Payload 示例**:

```json
{
  "object_kind": "pipeline",
  "object_attributes": {
    "id": 67890,
    "status": "success", // pending, running, success, failed, canceled
    "ref": "acp/issue-123/run-789",
    "stages": ["test", "build"],
    "created_at": "2026-01-25T10:35:00Z",
    "finished_at": "2026-01-25T10:40:00Z",
    "duration": 300
  },
  "merge_request": {
    "iid": 456,
    "title": "[ACP] #123 Fix login bug"
  }
}
```

**处理逻辑**:

```typescript
async function handlePipelineEvent(payload: any) {
  const { object_attributes } = payload;
  const status = object_attributes.status;
  const ref = object_attributes.ref;

  // 提取 run_id
  const match = ref.match(/acp\/issue-\d+\/run-(\w+)/);
  if (!match) return;

  const runId = match[1];

  // 创建 Event
  const eventType =
    status === "success"
      ? "ci.check.passed"
      : status === "failed"
        ? "ci.check.failed"
        : "ci.check.running";

  await Event.create({
    run_id: runId,
    source: "gitlab",
    type: eventType,
    payload: {
      pipeline_id: object_attributes.id,
      status,
      duration: object_attributes.duration,
      web_url: `${process.env.GITLAB_URL}/org/project/-/pipelines/${object_attributes.id}`,
    },
  });

  console.log(`CI ${status} for run ${runId}`);
}
```

---

## 5. 查询 MR 状态

### 5.1 API 调用

**端点**: `GET /api/v4/projects/:project_id/merge_requests/:mr_iid`

**代码**:

```typescript
async function getMergeRequest(projectId: number, mrIid: number) {
  const url = `${process.env.GITLAB_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}`;

  const response = await fetch(url, {
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_ACCESS_TOKEN,
    },
  });

  const mr = await response.json();

  return {
    state: mr.state, // opened, closed, merged
    merge_status: mr.merge_status, // can_be_merged, cannot_be_merged
    pipeline: mr.pipeline
      ? {
          id: mr.pipeline.id,
          status: mr.pipeline.status,
        }
      : null,
  };
}
```

### 5.2 轮询 CI 状态（备选方案）

如果 Webhook 不可用，可以轮询 Pipeline 状态:

```typescript
async function pollCIStatus(runId: string) {
  const run = await Run.findById(runId);
  const artifact = await Artifact.findOne({
    run_id: runId,
    type: "pr",
  });

  if (!artifact) return;

  const mrIid = artifact.content.mr_iid;
  const projectId = run.issue.project.gitlab_project_id;

  // 每 30 秒轮询
  const interval = setInterval(async () => {
    const mr = await getMergeRequest(projectId, mrIid);

    if (mr.pipeline) {
      const status = mr.pipeline.status;

      if (status === "success") {
        await Event.create({
          run_id: runId,
          source: "gitlab",
          type: "ci.check.passed",
          payload: { pipeline_id: mr.pipeline.id },
        });
        clearInterval(interval);
      } else if (status === "failed") {
        await Event.create({
          run_id: runId,
          source: "gitlab",
          type: "ci.check.failed",
          payload: { pipeline_id: mr.pipeline.id },
        });
        clearInterval(interval);
      }
    }
  }, 30000);

  // 最多轮询 1 小时
  setTimeout(() => clearInterval(interval), 3600000);
}
```

---

## 6. 错误处理

### 6.1 常见错误

| 错误码 | 原因       | 解决方案                                     |
| ------ | ---------- | -------------------------------------------- |
| 401    | Token 无效 | 检查 `GITLAB_ACCESS_TOKEN`                   |
| 403    | 权限不足   | 确认 Token 有 `api`, `write_repository` 权限 |
| 404    | 项目不存在 | 检查 `GITLAB_PROJECT_ID`                     |
| 409    | MR 已存在  | 分支已有未合并的 MR                          |

### 6.2 重试机制

```typescript
async function createMRWithRetry(params: CreateMRParams, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await createMergeRequest(params);
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      console.log(`Retry ${i + 1}/${maxRetries} after error:`, error);
      await sleep(5000 * (i + 1)); // 指数退避
    }
  }
}
```

---

## 7. 测试

### 7.1 手动测试 API

```bash
# 获取项目信息
curl -H "PRIVATE-TOKEN: glpat-xxx" \
  https://gitlab.example.com/api/v4/projects/123

# 创建 MR
curl -X POST \
  -H "PRIVATE-TOKEN: glpat-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "source_branch": "test-branch",
    "target_branch": "main",
    "title": "Test MR"
  }' \
  https://gitlab.example.com/api/v4/projects/123/merge_requests
```

### 7.2 模拟 Webhook

```bash
# 发送 MR Webhook
curl -X POST \
  -H "X-Gitlab-Event: Merge Request Hook" \
  -H "X-Gitlab-Token: your-secret" \
  -H "Content-Type: application/json" \
  -d @webhook-mr-opened.json \
  http://localhost:3000/webhooks/gitlab
```

**webhook-mr-opened.json**:

```json
{
  "object_kind": "merge_request",
  "object_attributes": {
    "id": 12345,
    "iid": 456,
    "state": "opened",
    "source_branch": "acp/issue-123/run-789",
    "action": "open"
  }
}
```

---

## 8. 部署清单

### 8.1 环境变量检查

```bash
# 必需的环境变量
GITLAB_URL=https://gitlab.example.com
GITLAB_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
GITLAB_PROJECT_ID=123
GITLAB_WEBHOOK_SECRET=your-secret-here
```

### 8.2 Webhook 配置确认

- [ ] Webhook URL 可公网访问（或使用 ngrok 等工具）
- [ ] Secret Token 与环境变量一致
- [ ] 触发器选择了 MR 和 Pipeline 事件
- [ ] 测试 Webhook 成功

### 8.3 权限确认

- [ ] Personal Access Token 有 `api` 权限
- [ ] Personal Access Token 有 `write_repository` 权限
- [ ] Token 未过期

---

## 9. 高级功能（未来扩展）

### 9.1 自动合并

```typescript
async function autoMergeMR(projectId: number, mrIid: number) {
  const url = `${process.env.GITLAB_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}/merge`;

  await fetch(url, {
    method: "PUT",
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      merge_when_pipeline_succeeds: true,
      should_remove_source_branch: true,
    }),
  });
}
```

### 9.2 添加评论

```typescript
async function addMRComment(projectId: number, mrIid: number, note: string) {
  const url = `${process.env.GITLAB_URL}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`;

  await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: note }),
  });
}

// 使用示例
await addMRComment(
  123,
  456,
  `
✅ CI passed!

All tests successful. Ready to merge.
`,
);
```

---

## 下一步

完成 GitLab 集成后，继续阅读 **06_QUICK_START_GUIDE.md** 开始实际开发。
