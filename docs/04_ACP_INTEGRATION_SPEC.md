# ACP 协议集成规范

本文档详细说明如何实现 ACP (Agent Client Protocol) 的协议转换和集成。这是系统的核心技术难点。

---

## 1. ACP 协议概述

### 1.1 ACP 是什么

Agent Client Protocol (ACP) 是 Zed Industries 开发的开放标准，用于编辑器与 AI coding agent 的通信。

**核心特性**:

- 协议: JSON-RPC 2.0
- 传输: stdio (标准输入输出)
- 模式: 双向通信（client 和 agent 都可发起请求）
- 会话: 支持多个并发 session

**官方文档**: https://agentclientprotocol.com

### 1.2 我们的挑战

**ACP 原生场景**:

```
[编辑器进程] --fork--> [Agent 子进程]
     stdin/stdout 双向通信
```

**我们的场景**:

```
[Web 看板] --网络--> [ACP Proxy] --stdio--> [Codex 子进程]
  (云端)              (用户本地)            (本地)
```

**核心问题**: 如何桥接网络通信（WebSocket）和本地通信（stdio）？

---

## 2. ACP 消息格式

### 2.1 基础结构（JSON-RPC 2.0）

#### 请求（Request）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess-abc123",
    "prompt": [
      {
        "type": "text",
        "text": "Implement user login feature"
      }
    ]
  }
}
```

#### 响应（Response）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess-abc123",
    "stopReason": "end_turn",
    "output": [
      {
        "type": "text",
        "text": "I've implemented the login feature..."
      }
    ]
  }
}
```

#### 通知（Notification - 无需响应）

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess-abc123",
    "update": {
      "type": "agentMessage",
      "content": [
        {
          "type": "text",
          "text": "Analyzing the codebase..."
        }
      ]
    }
  }
}
```

### 2.2 核心方法列表

| Method           | 方向           | 说明             |
| ---------------- | -------------- | ---------------- |
| `initialize`     | Client → Agent | 连接初始化       |
| `session/new`    | Client → Agent | 创建新会话       |
| `session/prompt` | Client → Agent | 发送任务/提示    |
| `session/update` | Agent → Client | 流式更新（通知） |
| `session/cancel` | Client → Agent | 取消会话         |

---

## 3. ACP Proxy 实现要点

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────┐
│              ACP Proxy (Python)                     │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │        WebSocket Client Module                │ │
│  │  - 连接 Orchestrator                          │ │
│  │  - 发送心跳                                   │ │
│  │  - 接收任务                                   │ │
│  └────────┬──────────────────────────────────────┘ │
│           │                                         │
│           ↓                                         │
│  ┌───────────────────────────────────────────────┐ │
│  │        Message Router                         │ │
│  │  - 路由 WebSocket 消息到 Agent                │ │
│  │  - 路由 Agent 输出到 WebSocket                │ │
│  └────────┬──────────────────────────────────────┘ │
│           │                                         │
│           ↓                                         │
│  ┌───────────────────────────────────────────────┐ │
│  │        Process Manager                        │ │
│  │  - 启动 Codex 子进程                          │ │
│  │  - 监控进程状态                               │ │
│  │  - 超时/重启处理                              │ │
│  └────────┬──────────────────────────────────────┘ │
│           │                                         │
│           ↓                                         │
│  ┌───────────────────────────────────────────────┐ │
│  │        stdio Interface                        │ │
│  │  - 写入 Agent stdin (JSON-RPC)                │ │
│  │  - 读取 Agent stdout (JSON-RPC)               │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.2 核心结构设计（Golang 实现）

#### Struct: ACPProxy

```go
package proxy

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type ACPProxy struct {
	config         *Config
	wsConn         *websocket.Conn
	agentCmd       *exec.Cmd
	agentStdin     io.WriteCloser
	agentStdout    io.ReadCloser
	activeSessions map[string]*SessionMeta
	sessionsMu     sync.RWMutex
	messageIDCounter int
}

type SessionMeta struct {
	RunID     string
	StartedAt time.Time
}

func New(cfg *Config) *ACPProxy {
	return &ACPProxy{
		config:         cfg,
		activeSessions: make(map[string]*SessionMeta),
	}
}

func (p *ACPProxy) Start() error {
	// 1. 连接到 Orchestrator
	if err := p.connectWebSocket(); err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	// 2. 注册 Agent
	if err := p.registerAgent(); err != nil {
		return fmt.Errorf("failed to register: %w", err)
	}

	// 3. 启动消息循环（goroutines）
	go p.websocketListener()
	go p.heartbeatLoop()

	// 阻塞主线程
	select {}
}

func (p *ACPProxy) connectWebSocket() error {
	url := p.config.OrchestratorURL
	headers := http.Header{}
	headers.Add("Authorization", "Bearer "+p.config.AuthToken)

	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		return err
	}

	p.wsConn = conn
	log.Println("✅ Connected to Orchestrator")
	return nil
}

func (p *ACPProxy) registerAgent() error {
	message := map[string]interface{}{
		"type": "register_agent",
		"agent": map[string]interface{}{
			"id":             p.config.Agent.ID,
			"name":           p.config.Agent.Name,
			"capabilities":   p.config.Agent.Capabilities,
			"max_concurrent": p.config.Agent.MaxConcurrent,
		},
	}

	if err := p.wsConn.WriteJSON(message); err != nil {
		return err
	}

	// 等待确认
	var response map[string]interface{}
	if err := p.wsConn.ReadJSON(&response); err != nil {
		return err
	}

	if response["type"] == "register_ack" && response["success"] == true {
		log.Printf("✅ Agent registered: %s", p.config.Agent.ID)
		return nil
	}

	return fmt.Errorf("registration failed")
}

func (p *ACPProxy) websocketListener() {
	for {
		var msg map[string]interface{}
		if err := p.wsConn.ReadJSON(&msg); err != nil {
			log.Printf("WS read error: %v", err)
			// 尝试重连
			p.reconnect()
			continue
		}

		// 根据类型分发
		msgType, ok := msg["type"].(string)
		if !ok {
			continue
		}

		switch msgType {
		case "execute_task":
			go p.handleExecuteTask(msg)
		case "cancel_task":
			go p.handleCancelTask(msg)
		}
	}
}

func (p *ACPProxy) handleExecuteTask(data map[string]interface{}) {
	runID := data["run_id"].(string)
	sessionID := data["session_id"].(string)
	prompt := data["prompt"].(string)

	log.Printf("Executing task: %s", runID)

	// 启动 Agent（如果未启动）
	if p.agentCmd == nil {
		if err := p.startAgentProcess(); err != nil {
			log.Printf("Failed to start agent: %v", err)
			return
		}
	}

	// 转换为 ACP JSON-RPC
	jsonrpcReq := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      p.nextMessageID(),
		"method":  "session/prompt",
		"params": map[string]interface{}{
			"sessionId": sessionID,
			"prompt": []map[string]interface{}{
				{"type": "text", "text": prompt},
			},
		},
	}

	// 写入 Agent stdin
	if err := p.writeToAgent(jsonrpcReq); err != nil {
		log.Printf("Failed to write to agent: %v", err)
		return
	}

	// 记录 session
	p.sessionsMu.Lock()
	p.activeSessions[sessionID] = &SessionMeta{
		RunID:     runID,
		StartedAt: time.Now(),
	}
	p.sessionsMu.Unlock()

	// 启动输出监听（如果未启动）
	if p.agentStdout != nil {
		go p.agentOutputListener()
	}
}

func (p *ACPProxy) startAgentProcess() error {
	cmd := exec.Command(p.config.Agent.Command, p.config.Agent.Args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	p.agentCmd = cmd
	p.agentStdin = stdin
	p.agentStdout = stdout

	// 启动进程
	if err := cmd.Start(); err != nil {
		return err
	}

	log.Println("✅ Agent process started")

	// 监听 stderr
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("Agent stderr: %s", scanner.Text())
		}
	}()

	// 发送 initialize
	return p.initializeAgent()
}

func (p *ACPProxy) initializeAgent() error {
	jsonrpcReq := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      0,
		"method":  "initialize",
		"params": map[string]interface{}{
			"protocolVersion": 1,
			"clientInfo": map[string]string{
				"name":    "ACP-Proxy",
				"version": "0.1.0",
			},
			"capabilities": map[string]interface{}{},
		},
	}

	return p.writeToAgent(jsonrpcReq)
}

func (p *ACPProxy) writeToAgent(msg map[string]interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// 必须添加换行符
	data = append(data, '\n')

	_, err = p.agentStdin.Write(data)
	return err
}

func (p *ACPProxy) agentOutputListener() {
	scanner := bufio.NewScanner(p.agentStdout)

	for scanner.Scan() {
		line := scanner.Text()

		// 跳过非 JSON 行
		if !strings.HasPrefix(line, "{") {
			log.Printf("Skipping non-JSON: %s", line)
			continue
		}

		// 解析 JSON-RPC
		var jsonrpcMsg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &jsonrpcMsg); err != nil {
			log.Printf("Invalid JSON: %s", line)
			continue
		}

		log.Printf("← Agent: %s", line)
		p.handleAgentOutput(jsonrpcMsg)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Scanner error: %v", err)
	}

	log.Println("Agent process ended")
}

func (p *ACPProxy) handleAgentOutput(jsonrpcMsg map[string]interface{}) {
	// Notification: session/update
	if method, ok := jsonrpcMsg["method"].(string); ok && method == "session/update" {
		params := jsonrpcMsg["params"].(map[string]interface{})
		sessionID := params["sessionId"].(string)
		update := params["update"].(map[string]interface{})

		// 查找对应的 run_id
		p.sessionsMu.RLock()
		sessionMeta, exists := p.activeSessions[sessionID]
		p.sessionsMu.RUnlock()

		if !exists {
			return
		}

		// 提取文本内容
		content := ""
		if contentArr, ok := update["content"].([]interface{}); ok && len(contentArr) > 0 {
			if contentItem, ok := contentArr[0].(map[string]interface{}); ok {
				content = contentItem["text"].(string)
			}
		}

		// 发送到 Orchestrator
		wsMsg := map[string]interface{}{
			"type":      "agent_update",
			"run_id":    sessionMeta.RunID,
			"content":   content,
			"timestamp": time.Now().Format(time.RFC3339),
		}

		p.wsConn.WriteJSON(wsMsg)

		// 检测分支创建
		if strings.Contains(strings.ToLower(content), "branch created") {
			p.handleBranchCreated(sessionMeta.RunID, content)
		}
	}

	// Response
	if _, ok := jsonrpcMsg["result"]; ok {
		log.Println("Task completed")
	}
}

func (p *ACPProxy) handleBranchCreated(runID, content string) {
	// 解析分支名
	re := regexp.MustCompile(`branch[:\s]+([^\s]+)`)
	matches := re.FindStringSubmatch(content)

	if len(matches) > 1 {
		branch := matches[1]
		log.Printf("Branch created: %s", branch)

		wsMsg := map[string]interface{}{
			"type":   "branch_created",
			"run_id": runID,
			"branch": branch,
		}

		p.wsConn.WriteJSON(wsMsg)
	}
}

func (p *ACPProxy) heartbeatLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		p.sessionsMu.RLock()
		currentLoad := len(p.activeSessions)
		p.sessionsMu.RUnlock()

		heartbeat := map[string]interface{}{
			"type":         "heartbeat",
			"agent_id":     p.config.Agent.ID,
			"current_load": currentLoad,
		}

		if err := p.wsConn.WriteJSON(heartbeat); err != nil {
			log.Printf("Heartbeat error: %v", err)
		}
	}
}

func (p *ACPProxy) nextMessageID() int {
	p.messageIDCounter++
	return p.messageIDCounter
}

func (p *ACPProxy) reconnect() {
	// 实现重连逻辑（见下方）
}
```

### 3.3 关键实现细节

#### 3.3.1 stdio 读写

**问题**: JSON-RPC over stdio 以换行符分隔，但 JSON 可能包含换行符

**解决**: 每条消息必须是单行 JSON（不能有美化的换行）

```go
// ✅ 正确
data, _ := json.Marshal(message)
data = append(data, '\n')  // 紧凑 JSON + 换行符
stdin.Write(data)

// ❌ 错误
data, _ := json.MarshalIndent(message, "", "  ")  // 多行 JSON 会导致解析失败
```

#### 3.3.2 进程管理

**问题**: Codex 可能崩溃、卡死

**解决**: 超时检测 + 自动重启

```go
func (p *ACPProxy) monitorAgentHealth() {
	lastOutputTime := time.Now()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// 检查进程是否存活
		if p.agentCmd != nil && p.agentCmd.ProcessState != nil {
			log.Println("Agent process died")
			p.restartAgent()
			continue
		}

		// 检查是否超时（15 分钟无输出）
		if time.Since(lastOutputTime) > 15*time.Minute {
			log.Println("Agent timeout, killing process")
			if p.agentCmd != nil && p.agentCmd.Process != nil {
				p.agentCmd.Process.Kill()
			}
			p.restartAgent()
		}
	}
}
```

#### 3.3.3 重连机制

**问题**: WebSocket 连接可能断开

**解决**: 指数退避重连

```go
func (p *ACPProxy) reconnect() {
	retryDelay := 5 * time.Second
	maxDelay := 60 * time.Second

	for {
		log.Printf("Reconnecting in %v...", retryDelay)
		time.Sleep(retryDelay)

		if err := p.connectWebSocket(); err != nil {
			log.Printf("Reconnect failed: %v", err)
			retryDelay = time.Duration(float64(retryDelay) * 2)
			if retryDelay > maxDelay {
				retryDelay = maxDelay
			}
			continue
		}

		log.Println("Reconnected successfully")

		// 重新注册
		if err := p.registerAgent(); err != nil {
			log.Printf("Re-registration failed: %v", err)
			continue
		}

		// 重启监听
		go p.websocketListener()
		break
	}
}
```

---

## 4. Orchestrator WebSocket 接口

### 4.1 接口定义

#### 端点: `/ws/agent`

**连接建立**:

```javascript
// Agent (Proxy) 连接
ws = new WebSocket('ws://localhost:3000/ws/agent');
ws.onopen = () => {
  // 发送注册消息
  ws.send(JSON.stringify({
    type: 'register_agent',
    agent: { ... }
  }));
};
```

**消息协议**:

| 方向           | 类型             | 说明     | Payload                            |
| -------------- | ---------------- | -------- | ---------------------------------- |
| Agent → Server | `register_agent` | 注册     | `{agent: {...}}`                   |
| Server → Agent | `register_ack`   | 注册确认 | `{success: true}`                  |
| Agent → Server | `heartbeat`      | 心跳     | `{agent_id, current_load, uptime}` |
| Server → Agent | `execute_task`   | 执行任务 | `{run_id, session_id, prompt}`     |
| Agent → Server | `agent_update`   | 进度更新 | `{run_id, content, timestamp}`     |
| Agent → Server | `task_completed` | 任务完成 | `{run_id, result}`                 |
| Agent → Server | `task_failed`    | 任务失败 | `{run_id, error}`                  |

### 4.2 服务器端实现要点

```typescript
// 伪代码
class WebSocketGateway {
  private agentConnections = new Map<string, WebSocket>();

  handleConnection(ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(data);

      switch (message.type) {
        case "register_agent":
          this.handleRegister(ws, message.agent);
          break;
        case "heartbeat":
          this.handleHeartbeat(message.agent_id);
          break;
        case "agent_update":
          this.handleUpdate(message);
          break;
        // ...
      }
    });

    ws.on("close", () => {
      this.handleDisconnect(ws);
    });
  }

  handleRegister(ws: WebSocket, agentInfo: any) {
    // 1. 存储连接
    this.agentConnections.set(agentInfo.id, ws);

    // 2. 更新数据库中的 Agent 状态
    Agent.update({ id: agentInfo.id }, { status: "online" });

    // 3. 发送确认
    ws.send(JSON.stringify({ type: "register_ack", success: true }));
  }

  async dispatchTask(agentId: string, task: Task) {
    const ws = this.agentConnections.get(agentId);
    if (!ws) {
      throw new Error("Agent not connected");
    }

    ws.send(
      JSON.stringify({
        type: "execute_task",
        run_id: task.run_id,
        session_id: task.session_id,
        prompt: task.prompt,
      }),
    );
  }
}
```

---

## 5. 完整消息流示例

### 5.1 场景: 用户创建任务 → Agent 执行 → 产出 PR

```
[Web UI]
   │ 1. POST /api/issues
   │    {title: "Fix login bug", ...}
   ↓
[Orchestrator]
   │ 2. Create Issue & Run in DB
   │ 3. Select Agent (codex-local-1)
   ↓
[WebSocket Gateway]
   │ 4. Send to Agent via WebSocket
   │    {type: "execute_task", run_id: "run-123",
   │     session_id: "sess-abc", prompt: "Fix login bug"}
   ↓
[ACP Proxy] (用户本地)
   │ 5. Convert to JSON-RPC
   ↓
[Codex stdin]
   │ {"jsonrpc":"2.0", "id":1, "method":"session/prompt",
   │  "params":{"sessionId":"sess-abc", "prompt":[...]}}
   ↓
[Codex 处理]
   │ ... 分析代码、修改文件 ...
   ↓
[Codex stdout]
   │ 6. {"jsonrpc":"2.0", "method":"session/update",
   │     "params":{"sessionId":"sess-abc",
   │               "update":{"type":"agentMessage",
   │                         "content":[{"type":"text",
   │                                     "text":"Analyzing..."}]}}}
   ↓
[ACP Proxy]
   │ 7. Parse and forward to WebSocket
   │    {type: "agent_update", run_id: "run-123",
   │     content: "Analyzing...", timestamp: "..."}
   ↓
[Orchestrator]
   │ 8. Save Event to DB
   │ 9. Push to Web UI via WebSocket
   ↓
[Web UI]
   │ 10. Display in timeline: "10:30 Analyzing..."

   ... (更多 updates) ...

[Codex stdout]
   │ 11. {"jsonrpc":"2.0", "id":1, "result":{
   │      "sessionId":"sess-abc", "stopReason":"end_turn",
   │      "output":[{"type":"text", "text":"Branch created: acp/123/run-456"}]}}
   ↓
[ACP Proxy]
   │ 12. Parse branch info
   │     Send: {type: "branch_created", run_id: "run-123",
   │            branch: "acp/123/run-456"}
   ↓
[Orchestrator]
   │ 13. Call GitLab API to create MR
   │ 14. Save Artifact (type: 'mr')
   │ 15. Update Run status → 'waiting_ci'
   ↓
[Web UI]
   │ 16. Display MR link
```

---

## 6. 测试与调试

### 6.1 单元测试

#### 测试协议转换

```python
def test_websocket_to_jsonrpc():
    """测试 WebSocket 消息转换为 JSON-RPC"""
    ws_message = {
        'type': 'execute_task',
        'run_id': 'run-123',
        'session_id': 'sess-abc',
        'prompt': 'Fix bug'
    }

    expected = {
        'jsonrpc': '2.0',
        'id': 1,
        'method': 'session/prompt',
        'params': {
            'sessionId': 'sess-abc',
            'prompt': [{'type': 'text', 'text': 'Fix bug'}]
        }
    }

    result = convert_to_jsonrpc(ws_message)
    assert result == expected
```

### 6.2 集成测试

#### 测试端到端流程

```bash
# 1. 启动 Mock Agent（模拟 Codex）
python tests/mock_agent.py

# 2. 启动 Proxy
python src/proxy.py --config config.test.json

# 3. 发送测试任务
curl -X POST http://localhost:3000/api/issues \
  -H "Content-Type: application/json" \
  -d '{"title": "Test task", "description": "..."}'

# 4. 验证 Mock Agent 收到消息
# 查看 mock_agent.log
```

### 6.3 调试技巧

#### 启用详细日志

```python
# 在 Proxy 中添加
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('proxy_debug.log'),
        logging.StreamHandler()
    ]
)

# 记录所有 JSON-RPC 消息
logger.debug(f"→ Agent: {json.dumps(message)}")
logger.debug(f"← Agent: {json.dumps(response)}")
```

#### 使用 netcat 测试 Codex

```bash
# 直接与 Codex 交互（验证 Codex 是否正常工作）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | codex --acp
```

---

## 7. 常见问题

### Q1: Codex 输出乱码或格式错误

**原因**: stderr 和 stdout 混在一起

**解决**: 分别处理 stdout 和 stderr

```python
# 正确做法
self.agent_process = await asyncio.create_subprocess_exec(
    cmd, *args,
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE  # 分离 stderr
)

# 分别监听
async def stderr_listener():
    while True:
        line = await self.agent_process.stderr.readline()
        if line:
            logging.warning(f"Agent stderr: {line.decode()}")
```

### Q2: JSON 解析失败 "Expecting value"

**原因**: Codex 输出了非 JSON 内容（如调试信息）

**解决**: 严格过滤，只解析 JSON 行

```python
async def agent_output_listener(self):
    while True:
        line = await self.agent_process.stdout.readline()
        if not line:
            break

        text = line.decode().strip()

        # 跳过非 JSON 行
        if not text.startswith('{'):
            logging.debug(f"Skipping non-JSON: {text}")
            continue

        try:
            jsonrpc_message = json.loads(text)
            await self.handle_agent_output(jsonrpc_message)
        except json.JSONDecodeError:
            logging.error(f"Invalid JSON: {text}")
```

### Q3: WebSocket 连接频繁断开

**原因**: 网络不稳定或防火墙

**解决**:

1. 使用 WSS (WebSocket Secure)
2. 增加心跳频率（从 30s 改为 15s）
3. 实现 Session 恢复机制

---

## 8. 性能优化

### 8.1 避免阻塞

**问题**: 大量 stdout 输出可能阻塞进程

**解决**: 使用异步 I/O

```python
# ✅ 使用 asyncio
stdout_line = await process.stdout.readline()

# ❌ 避免同步读取
stdout_line = process.stdout.readline()  # 会阻塞整个事件循环
```

### 8.2 限制消息大小

**问题**: Codex 可能输出超大消息

**解决**: 限制单条消息大小

```python
MAX_MESSAGE_SIZE = 1024 * 1024  # 1MB

line = await process.stdout.readline()
if len(line) > MAX_MESSAGE_SIZE:
    logging.error("Message too large, truncating")
    line = line[:MAX_MESSAGE_SIZE]
```

---

## 9. 部署清单

### 9.1 配置文件检查

- [ ] `config.json` 中的 `orchestrator_url` 正确
- [ ] `auth_token` 已设置
- [ ] `agent.command` 指向正确的 Codex 路径
- [ ] `agent.workspace` 目录存在且可写

### 9.2 权限检查

```bash
# Codex 可执行
chmod +x /path/to/codex

# Workspace 可写
mkdir -p /path/to/workspace
chmod 755 /path/to/workspace
```

### 9.3 网络检查

```bash
# 测试 WebSocket 连接
wscat -c ws://localhost:3000/ws/agent

# 或使用 Python
python -c "import websockets; asyncio.run(websockets.connect('ws://localhost:3000/ws/agent'))"
```

---

## 下一步

阅读 **05_GITLAB_INTEGRATION.md** 了解 GitLab API 集成细节。
