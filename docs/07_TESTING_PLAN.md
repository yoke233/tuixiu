# 测试计划

本文档定义 MVP 阶段的测试策略、用例和验收标准。

---

## 1. 测试策略

### 1.1 测试金字塔

```
        /\
       /  \  E2E Tests (10%)
      /────\
     /      \
    / Integ  \ Integration Tests (30%)
   /  ration  \
  /────────────\
 /              \
/  Unit Tests    \ Unit Tests (60%)
/     (60%)       \
──────────────────────
```

### 1.2 测试范围

| 层级           | 测试内容                        | 工具                             |
| -------------- | ------------------------------- | -------------------------------- |
| **单元测试**   | 纯函数、工具类、协议转换        | Vitest (后端/前端/Proxy) |
| **集成测试**   | API 接口、数据库操作、WebSocket | Supertest / Go testing           |
| **端到端测试** | 完整流程（Issue → MR → Done）   | 手动测试 + Playwright（未来）    |

---

## 2. 单元测试用例

### 2.1 协议转换（ACP Proxy - Golang）

```go
// internal/proxy/conversion_test.go

package proxy

import (
	"testing"
	"encoding/json"
)

func TestWebSocketToJSONRPC(t *testing.T) {
	// 测试 WebSocket 消息转换为 JSON-RPC
	wsMessage := map[string]interface{}{
		"type":       "execute_task",
		"run_id":     "run-123",
		"session_id": "sess-abc",
		"prompt":     "Fix login bug",
	}

	expected := JSONRPCMessage{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "session/prompt",
		Params: map[string]interface{}{
			"sessionId": "sess-abc",
			"prompt": []map[string]interface{}{
				{"type": "text", "text": "Fix login bug"},
			},
		},
	}

	result := convertWSToJSONRPC(wsMessage, 1)

	if result.Method != expected.Method {
		t.Errorf("Expected method %s, got %s", expected.Method, result.Method)
	}
}

func TestJSONRPCToWebSocket(t *testing.T) {
	// 测试 JSON-RPC 转换为 WebSocket 消息
    jsonrpc_message = {
        'jsonrpc': '2.0',
        'method': 'session/update',
        'params': {
            'sessionId': 'sess-abc',
            'update': {
                'type': 'agentMessage',
                'content': [
                    {'type': 'text', 'text': 'Processing...'}
                ]
            }
        }
    }

    expected = {
        'type': 'agent_update',
        'run_id': 'run-123',
        'content': 'Processing...',
        'timestamp': '...'  # 忽略时间戳
    }

    result = convert_jsonrpc_to_ws(jsonrpc_message, session_map={'sess-abc': {'run_id': 'run-123'}})
    assert result['type'] == expected['type']
    assert result['run_id'] == expected['run_id']
    assert result['content'] == expected['content']
```

### 2.2 任务调度（Orchestrator）

```typescript
// scheduler.test.ts

describe("Scheduler", () => {
  it("should select first available agent", async () => {
    // Mock database
    const mockAgents = [
      {
        id: "agent-1",
        status: "online",
        current_load: 0,
        max_concurrent_runs: 2,
      },
      {
        id: "agent-2",
        status: "online",
        current_load: 2,
        max_concurrent_runs: 2,
      },
      {
        id: "agent-3",
        status: "offline",
        current_load: 0,
        max_concurrent_runs: 2,
      },
    ];

    const selected = selectAgent(mockAgents);

    expect(selected.id).toBe("agent-1");
  });

  it("should throw error if no agent available", async () => {
    const mockAgents = [
      {
        id: "agent-1",
        status: "offline",
        current_load: 0,
        max_concurrent_runs: 2,
      },
    ];

    expect(() => selectAgent(mockAgents)).toThrow("No available agent");
  });
});
```

---

## 3. 集成测试用例

### 3.1 API 测试（Orchestrator）

```typescript
// api.test.ts
import request from "supertest";
import app from "../src/index";

describe("Issues API", () => {
  it("POST /api/issues - should create issue", async () => {
    const response = await request(app)
      .post("/api/issues")
      .send({
        title: "Test Issue",
        description: "Test description",
        acceptance_criteria: ["Criterion 1", "Criterion 2"],
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.issue.title).toBe("Test Issue");
  });

  it("GET /api/issues - should list issues", async () => {
    const response = await request(app).get("/api/issues");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.issues)).toBe(true);
  });

  it("GET /api/issues/:id - should get issue detail", async () => {
    const createResponse = await request(app)
      .post("/api/issues")
      .send({ title: "Test", description: "Test" });

    const issueId = createResponse.body.issue.id;

    const response = await request(app).get(`/api/issues/${issueId}`);

    expect(response.status).toBe(200);
    expect(response.body.issue.id).toBe(issueId);
  });
});
```

### 3.2 WebSocket 测试

```typescript
// websocket.test.ts
import WebSocket from "ws";

describe("WebSocket Gateway", () => {
  it("should accept agent registration", async () => {
    const ws = new WebSocket("ws://localhost:3000/ws/agent");

    await new Promise((resolve) => ws.once("open", resolve));

    // 发送注册消息
    ws.send(
      JSON.stringify({
        type: "register_agent",
        agent: {
          id: "test-agent",
          name: "Test Agent",
          capabilities: {},
          max_concurrent: 1,
        },
      }),
    );

    // 等待确认
    const response = await new Promise((resolve) => {
      ws.once("message", (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(response).toEqual({
      type: "register_ack",
      success: true,
    });

    ws.close();
  });
});
```

### 3.3 GitLab API 测试

```typescript
// gitlab.test.ts
import { createMergeRequest } from "../src/services/gitlab";

describe("GitLab Integration", () => {
  it("should create merge request", async () => {
    const mr = await createMergeRequest({
      projectId: Number(process.env.GITLAB_PROJECT_ID),
      sourceBranch: "test-branch",
      targetBranch: "main",
      title: "Test MR",
      description: "Test description",
    });

    expect(mr).toHaveProperty("id");
    expect(mr).toHaveProperty("web_url");

    // 清理：关闭 MR
    // await closeMergeRequest(mr.id);
  });
});
```

---

## 4. 端到端测试用例

### 4.1 测试场景 1: 简单任务（成功路径）

**前置条件**:

- Orchestrator 运行中
- ACP Proxy 运行中
- Codex Agent 可用
- GitLab 配置正确

**步骤**:

1. 创建 Issue: "修复 README 拼写错误"
2. 系统自动分配 Agent
3. Agent 执行任务
4. 创建 MR
5. CI 运行并通过
6. 手动合并 MR
7. 任务标记为 Done

**验证点**:

- [ ] Issue 创建成功（status: pending）
- [ ] Run 创建成功（status: running）
- [ ] Agent 收到任务（Proxy 日志）
- [ ] MR 创建成功（GitLab 上可见）
- [ ] CI 触发（GitLab Pipeline 运行）
- [ ] 事件时间线完整（至少 5 个事件）
- [ ] 最终状态正确（status: done）

**预期耗时**: 3-10 分钟

---

### 4.2 测试场景 2: CI 失败（错误处理）

**前置条件**: 同上

**步骤**:

1. 创建 Issue: "添加一个会导致测试失败的功能"
2. Agent 执行并创建 MR
3. CI 运行失败
4. 检查系统是否正确记录失败

**验证点**:

- [ ] CI 失败事件记录（type: ci.check.failed）
- [ ] Run 状态更新（status: failed）
- [ ] Web UI 显示失败信息

---

### 4.3 测试场景 3: Agent 离线（容错性）

**前置条件**:

- Orchestrator 运行中
- ACP Proxy 停止

**步骤**:

1. 创建 Issue
2. 观察系统行为

**预期结果**:

- 返回错误: "No available agent"
- 或任务进入队列等待

---

## 5. 性能测试

### 5.1 负载测试

**目标**: 验证系统能否处理多个并发任务

**测试脚本**:

```bash
# 并发创建 10 个 Issue
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/issues \
    -H "Content-Type: application/json" \
    -d "{\"title\": \"Task $i\", \"description\": \"Test\"}" &
done

wait
echo "All issues created"
```

**验收标准**:

- [ ] 所有 10 个 Issue 创建成功
- [ ] Agent 按负载能力分配任务（不超载）
- [ ] 系统无崩溃

### 5.2 稳定性测试

**目标**: 验证系统可以长时间稳定运行

**步骤**:

1. 启动所有服务
2. 运行 4 小时
3. 期间创建 20 个任务

**验收标准**:

- [ ] 无内存泄漏（内存使用稳定）
- [ ] 无连接泄漏（WebSocket 连接数稳定）
- [ ] 所有任务正常完成

---

## 6. 安全测试（基础）

### 6.1 WebSocket 认证

**测试**: 不带 Token 连接 WebSocket

**预期**: 连接被拒绝

### 6.2 Webhook 验证

**测试**: 发送错误的 Secret Token

```bash
curl -X POST http://localhost:3000/webhooks/gitlab \
  -H "X-Gitlab-Token: wrong-token" \
  -d '{}'
```

**预期**: 401 Unauthorized

---

## 7. 验收标准（MVP）

### 7.1 功能性标准

#### Must Have (P0)

- [x] 可以创建 Issue
- [x] Agent 可以连接并注册
- [x] Agent 可以接收任务
- [x] 可以创建 MR
- [x] Webhook 可以接收 GitLab 事件
- [x] 事件时间线记录完整
- [x] MR 合并后任务标记为 Done

#### Should Have (P1)

- [ ] Web UI 实时更新
- [ ] 失败诊断信息
- [ ] 一键重试

#### Nice to Have (P2)

- [ ] Review 闭环
- [ ] 监控 Dashboard

### 7.2 性能标准

- [ ] 任务响应时间 < 10 秒
- [ ] 简单任务完成时间 < 5 分钟
- [ ] API 响应时间 < 500ms (P95)
- [ ] 支持 2 个并发 Agent
- [ ] 支持 10 个并发任务（排队）

### 7.3 稳定性标准

- [ ] 连续运行 4 小时无崩溃
- [ ] 成功率 ≥ 70%（10 个任务中至少 7 个成功）
- [ ] Agent 断线重连成功率 100%

### 7.4 可用性标准

- [ ] 新用户可在 30 分钟内完成首个任务（含学习）
- [ ] 有完整的操作手册
- [ ] 有常见问题 FAQ

---

## 8. 测试报告模板

### 测试执行报告

**日期**: 2026-01-25  
**版本**: MVP v0.1.0  
**测试人员**: [姓名]

#### 测试摘要

| 测试类型   | 总数 | 通过 | 失败 | 跳过 |
| ---------- | ---- | ---- | ---- | ---- |
| 单元测试   | 15   | 15   | 0    | 0    |
| 集成测试   | 8    | 7    | 1    | 0    |
| 端到端测试 | 3    | 2    | 1    | 0    |

#### 失败用例

1. **集成测试 - GitLab API**
   - 现象: 创建 MR 超时
   - 原因: 网络不稳定
   - 解决: 增加重试机制

2. **E2E - 场景 2**
   - 现象: CI 失败未正确记录
   - 原因: Webhook 处理逻辑错误
   - 解决: 已修复

#### 性能数据

- 平均任务完成时间: 3 分 45 秒
- API P95 响应时间: 280ms
- 并发处理能力: 2 个 Agent 同时运行，无异常

#### 建议

1. 增加单元测试覆盖率（目前 60%，目标 80%）
2. 完善错误处理（特别是网络异常）
3. 增加日志记录（便于排查问题）

---

## 9. 持续集成（CI）配置

### 9.1 GitHub Actions 示例

`.github/workflows/test.yml`:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test-backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s

    steps:
      - uses: actions/checkout@v2

      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: "18"

      - name: Install dependencies
        run: cd backend && npm install

      - name: Run tests
        run: cd backend && npm test
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test_db

  test-proxy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v2

      - name: Setup Golang
        uses: actions/setup-go@v3
        with:
          go-version: "1.21"

      - name: Install dependencies
        run: cd acp-proxy && pnpm install

      - name: Run tests
        run: cd acp-proxy && pnpm test
```

---

## 10. 测试清单（手动）

在发布 MVP 前，逐项检查:

### 环境检查

- [ ] PostgreSQL 运行正常
- [ ] Orchestrator 启动成功
- [ ] ACP Proxy 启动成功
- [ ] Codex Agent 可用
- [ ] GitLab Token 有效

### 功能检查

- [ ] 可以创建 Issue
- [ ] Agent 可以注册
- [ ] 任务可以执行
- [ ] MR 可以创建
- [ ] Webhook 可以接收
- [ ] 事件时间线正常

### UI 检查

- [ ] 任务列表可见
- [ ] 任务详情可见
- [ ] 时间线显示正常
- [ ] MR 链接可点击

### 性能检查

- [ ] 创建 Issue 响应 < 1 秒
- [ ] 任务完成时间 < 10 分钟
- [ ] 无明显内存泄漏

### 文档检查

- [ ] README 完整
- [ ] 操作手册可读
- [ ] API 文档准确

---

**测试快乐！🧪**
