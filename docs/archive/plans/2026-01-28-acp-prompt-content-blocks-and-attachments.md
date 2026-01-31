---
title: "ACP Prompt ContentBlock + 附件/大字段落库治理实施计划"
owner: "@yoke233"
status: "archived"
last_reviewed: "2026-01-28"
---

# ACP Prompt ContentBlock + 附件/大字段落库治理 Implementation Plan

**Goal（按本次需求大改）**

- 前后端统一用 ACP `ContentBlock[]` 发送 Run prompt
- **补齐图片附件上传（Phase 1：只支持图片，落盘到服务端本地文件夹）**
- 前端 **聊天框 + Console** 均支持图片拖拽上传
- 修复事件落库膨胀：`image/audio/resource(blob)` 的大字段不再原样写入 events
- 为后续“本地文件 → S3”留出清晰替换点（接口/抽象先统一）

**Architecture**

- `POST /api/runs/:id/attachments`：上传图片到服务端本地目录（后续替换 S3）。
- `GET /api/runs/:id/attachments/:attachmentId`：按 `attachmentId` 下载/预览图片。
- `POST /api/runs/:id/prompt`：
  - API 层允许 `image` block 仅带 `uri`（不含 base64）
  - 转发给 ACP 前，后端将 `uri` 指向的附件 **物化为** `image.data`（base64）
  - 落库 `user.message` 事件时对 prompt **compact**：替换/裁剪 `data/blob/text` 等大字段，保留 `uri`/元信息
- 前端控制台渲染用户消息：优先读取 `payload.prompt` 做摘要（兼容旧 `payload.text`）

---

## 范围与非目标

**本期范围（Phase 1）**

- 后端：图片上传/下载接口（本地落盘）；prompt 物化（`uri` → base64）与落库 compact
- 前端：prompt 改为 `ContentBlock[]`；聊天框 + Console 支持图片拖拽上传并随消息发送
- 测试：前后端单测覆盖关键行为；`pnpm -C backend test`、`pnpm -C frontend test`、`pnpm lint`、`pnpm -C backend typecheck`、`pnpm -C frontend typecheck` 通过

**非目标（Phase 2/后续）**

- 音频/任意文件类型上传（本期只做图片）
- 完整附件体验（进度条、失败重试、粘贴上传、上传队列、历史附件管理等）
- S3/MinIO 真正落地（本期只做本地落盘；保持接口稳定，后续替换存储实现）

---

## 关键设计决策

### 1) 本地文件保存位置（按本次修改）

- 默认：`$HOME/.tuixiu/attachments/`（可用 `ATTACHMENTS_ROOT` 覆盖）
- 分桶：`<ATTACHMENTS_ROOT>/<runId>/<attachmentId>/`（保存 `file` + `meta.json`）
- `attachmentId` 建议使用内容哈希（如 sha256）以去重并便于校验

### 2) prompt 合约（Phase 1）

- 前端发送 `prompt: ContentBlock[]`
- 图片 block 发送形态：
  - `type=image`，带 `mimeType` 与 `uri`（指向 `/api/runs/:id/attachments/:attachmentId`）
  - **不要求**在 API 请求里携带 base64（由后端在转发前物化）
- 后端转发给 ACP 时：保证 `image.data` 存在（base64）

### 3) 落库 compact（修复 P2）

- `image.data`、`audio.data`、`resource.resource.blob`：落库时替换为 `"<omitted>"`
- 保留 `uri` 与必要元信息，便于 UI 回看/排查

---

## Tasks

### Task 1: 同步分支到 `origin/main`（若尚未同步）

Run:

```powershell
git fetch origin
git switch feat/backend/acp-prompt-content-blocks
git merge origin/main
git push
```

---

### Task 2: 前端定义 `ContentBlock` 类型与摘要工具（支持 image.uri）

**Files:**

- Create: `frontend/src/acp/contentBlocks.ts`
- Test: `frontend/src/acp/contentBlocks.test.ts`

要点：

- `image.data?: string`（允许缺省）
- `summarizeContentBlocks()`：图片输出 `[image mimeType uri]` 形式，避免长文本

---

### Task 3: 后端实现图片上传/下载（本地落盘）

**Files:**

- Create: `backend/src/services/attachments/attachmentStore.ts`
- Create: `backend/src/services/attachments/localAttachmentStore.ts`
- Modify: `backend/src/config.ts`（新增 `ATTACHMENTS_ROOT`、可选 `ATTACHMENTS_MAX_BYTES`）
- Modify: `backend/src/routes/runs.ts`（新增 upload/download endpoints）
- Test: `backend/test/routes/runs.attachments.test.ts`

接口约定：

- `POST /api/runs/:id/attachments`：上传图片，返回 `{ attachment: { id, runId, mimeType, size, sha256, uri } }`
- `GET /api/runs/:id/attachments/:attachmentId`：下载/预览（`Content-Type` = `mimeType`）

校验约束：

- Phase 1 仅允许 `image/*`
- 限制最大文件大小（如 10MB，可配置）
- 防 path traversal：只允许读取 runId 桶下的 attachmentId

---

### Task 4: 后端 prompt 物化 + 落库 compact

**Files:**

- Modify: `backend/src/services/acpContent.ts`（新增 compact/物化辅助函数）
- Modify: `backend/src/routes/runs.ts`（prompt 路由接入）
- Test: `backend/test/routes/runs.test.ts`（补用例：ACP 收到物化后的 base64；落库为 compact）

行为：

- API 接收的 `prompt`：允许 `image` 仅带 `uri`
- 调用 ACP 前：读取 `uri` 对应附件并写入 `image.data`（base64）
- `prisma.event.create`：写入 compact 后的 prompt（不含 base64）

---

### Task 5: 前端上传 + 拖拽（聊天框 + Console）

**Files:**

- Modify: `frontend/src/api/runs.ts`（新增 upload API；promptRun 改签名）
- Modify: `frontend/src/pages/session/useSessionController.ts`
- Modify: `frontend/src/pages/session/sections/SessionConsoleCard.tsx`
- Modify: `frontend/src/pages/issueDetail/useIssueDetailController.ts`
- Modify: `frontend/src/pages/issueDetail/sections/ConsoleCard.tsx`
- Modify: `frontend/src/components/RunConsole.tsx`（支持 drop zone）

行为：

- 拖拽到聊天框或 Console：自动上传图片并进入“待发送图片列表”
- 允许仅发送图片（无文本）
- 发送成功后清空待发送列表

---

### Task 6: 前端控制台渲染 `payload.prompt`（摘要）

**Files:**

- Modify: `frontend/src/components/runConsole/eventToConsoleItem.ts`
- Test: `frontend/src/components/runConsole/eventToConsoleItem.test.ts`

行为：

- 优先摘要 `payload.prompt`
- 兼容旧的 `payload.text`

---

### Task 7: 全量校验

Run:

```powershell
$env:DATABASE_URL = "postgresql://example"
pnpm -C backend typecheck
pnpm -C backend test
pnpm -C backend lint

pnpm -C frontend typecheck
pnpm -C frontend test
pnpm -C frontend lint

pnpm lint
pnpm test
```
