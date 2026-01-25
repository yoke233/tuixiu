package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"acp-proxy/internal/config"
	"acp-proxy/internal/types"
)

type fakeConn struct {
	mu   sync.Mutex
	sent [][]byte
}

func (c *fakeConn) WriteMessage(_ int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	return nil
}

func (c *fakeConn) messages() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, 0, len(c.sent))
	for _, b := range c.sent {
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		out = append(out, m)
	}
	return out
}

func TestProxy_MockMode_ExecuteTaskSendsUpdates(t *testing.T) {
	cfg := &config.Config{
		OrchestratorURL:  "ws://localhost/ws/agent",
		Cwd:              t.TempDir(),
		HeartbeatSeconds: 1,
		MockMode:         true,
		AgentCommand:     []string{"ignored"},
		Agent: config.Agent{
			ID:            "proxy-1",
			Name:          "proxy-1",
			MaxConcurrent: 1,
		},
	}
	p := New(cfg)
	fc := &fakeConn{}
	p.conn = fc

	p.handleExecuteTask(context.Background(), types.ExecuteTaskMessage{
		Type:   "execute_task",
		RunID:  "run-1",
		Prompt: "hello",
	})

	msgs := fc.messages()
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}

	if msgs[0]["type"] != "agent_update" || msgs[0]["run_id"] != "run-1" {
		t.Fatalf("unexpected message 0: %#v", msgs[0])
	}
	content0, _ := msgs[0]["content"].(map[string]any)
	if content0["type"] != "text" {
		t.Fatalf("expected text update, got %#v", content0["type"])
	}
	if !strings.Contains(content0["text"].(string), "hello") {
		t.Fatalf("expected prompt in text, got %#v", content0["text"])
	}

	content1, _ := msgs[1]["content"].(map[string]any)
	if content1["type"] != "prompt_result" {
		t.Fatalf("expected prompt_result, got %#v", content1["type"])
	}
}

func TestProxy_NonMock_InitializeFailureSendsError(t *testing.T) {
	cfg := &config.Config{
		OrchestratorURL:  "ws://localhost/ws/agent",
		Cwd:              t.TempDir(),
		HeartbeatSeconds: 1,
		MockMode:         false,
		AgentCommand:     []string{}, // triggers "agent_command is empty"
		Agent: config.Agent{
			ID:            "proxy-1",
			Name:          "proxy-1",
			MaxConcurrent: 1,
		},
	}
	p := New(cfg)
	fc := &fakeConn{}
	p.conn = fc

	p.handleExecuteTask(context.Background(), types.ExecuteTaskMessage{
		Type:   "execute_task",
		RunID:  "run-1",
		Prompt: "hello",
	})

	msgs := fc.messages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	content, _ := msgs[0]["content"].(map[string]any)
	if content["type"] != "text" {
		t.Fatalf("expected text error, got %#v", content["type"])
	}
	if !strings.Contains(content["text"].(string), "ACP initialize 失败") {
		t.Fatalf("expected initialize error text, got %#v", content["text"])
	}
}

func TestProxy_NonMock_NewSessionFailureSendsError(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	cfg := &config.Config{
		OrchestratorURL:  "ws://localhost/ws/agent",
		Cwd:              wd,
		HeartbeatSeconds: 1,
		MockMode:         false,
		AgentCommand: []string{
			os.Args[0],
			"-test.run=TestACPHelperProcess",
			"--",
			"acp-helper",
			"acp-helper-mode=newsession-empty",
		},
		Agent: config.Agent{
			ID:            "proxy-1",
			Name:          "proxy-1",
			MaxConcurrent: 1,
		},
	}
	p := New(cfg)
	fc := &fakeConn{}
	p.conn = fc

	p.handleExecuteTask(context.Background(), types.ExecuteTaskMessage{
		Type:   "execute_task",
		RunID:  "run-1",
		Prompt: "do something",
	})

	msgs := fc.messages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d: %#v", len(msgs), msgs)
	}
	content, _ := msgs[0]["content"].(map[string]any)
	if content["type"] != "text" {
		t.Fatalf("expected text error, got %#v", content["type"])
	}
	if !strings.Contains(content["text"].(string), "ACP session/new 失败") {
		t.Fatalf("expected session/new error text, got %#v", content["text"])
	}
}

func TestProxy_NonMock_PromptFailureSendsError(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	cfg := &config.Config{
		OrchestratorURL:  "ws://localhost/ws/agent",
		Cwd:              wd,
		HeartbeatSeconds: 1,
		MockMode:         false,
		AgentCommand: []string{
			os.Args[0],
			"-test.run=TestACPHelperProcess",
			"--",
			"acp-helper",
			"acp-helper-mode=prompt-error",
		},
		Agent: config.Agent{
			ID:            "proxy-1",
			Name:          "proxy-1",
			MaxConcurrent: 1,
		},
	}
	p := New(cfg)
	fc := &fakeConn{}
	p.conn = fc

	p.handleExecuteTask(context.Background(), types.ExecuteTaskMessage{
		Type:   "execute_task",
		RunID:  "run-1",
		Prompt: "do something",
	})

	msgs := fc.messages()
	if len(msgs) < 2 {
		t.Fatalf("expected at least 2 messages, got %d: %#v", len(msgs), msgs)
	}

	seenSessionCreated := false
	seenPromptError := false
	for _, m := range msgs {
		content, _ := m["content"].(map[string]any)
		if content["type"] != "text" {
			continue
		}
		text, _ := content["text"].(string)
		if strings.Contains(text, "ACP session 已创建") && strings.Contains(text, "sess-1") {
			seenSessionCreated = true
		}
		if strings.Contains(text, "ACP session/prompt 失败") {
			seenPromptError = true
		}
	}
	if !seenSessionCreated {
		t.Fatalf("missing session created update: %#v", msgs)
	}
	if !seenPromptError {
		t.Fatalf("missing prompt error update: %#v", msgs)
	}
}

func TestProxy_NonMock_SuccessSendsSessionUpdateAndPromptResult(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	cfg := &config.Config{
		OrchestratorURL:  "ws://localhost/ws/agent",
		Cwd:              wd,
		HeartbeatSeconds: 1,
		MockMode:         false,
		AgentCommand: []string{
			os.Args[0],
			"-test.run=TestACPHelperProcess",
			"--",
			"acp-helper",
		},
		Agent: config.Agent{
			ID:            "proxy-1",
			Name:          "proxy-1",
			MaxConcurrent: 1,
		},
	}
	p := New(cfg)
	fc := &fakeConn{}
	p.conn = fc

	p.handleExecuteTask(context.Background(), types.ExecuteTaskMessage{
		Type:   "execute_task",
		RunID:  "run-1",
		Prompt: "do something",
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		if len(fc.messages()) >= 3 {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	msgs := fc.messages()
	if len(msgs) < 3 {
		t.Fatalf("expected at least 3 messages, got %d: %#v", len(msgs), msgs)
	}

	seenSessionCreated := false
	seenSessionUpdate := false
	seenPromptResult := false

	for _, m := range msgs {
		content, _ := m["content"].(map[string]any)
		switch content["type"] {
		case "text":
			text, _ := content["text"].(string)
			if strings.Contains(text, "ACP session 已创建") && strings.Contains(text, "sess-1") {
				seenSessionCreated = true
			}
		case "session_update":
			seenSessionUpdate = true
		case "prompt_result":
			seenPromptResult = true
			if content["stopReason"] != "end_turn" {
				t.Fatalf("expected stopReason=end_turn, got %#v", content["stopReason"])
			}
		}
	}

	if !seenSessionCreated {
		t.Fatalf("missing session created update: %#v", msgs)
	}
	if !seenSessionUpdate {
		t.Fatalf("missing session_update: %#v", msgs)
	}
	if !seenPromptResult {
		t.Fatalf("missing prompt_result: %#v", msgs)
	}
}

// TestACPHelperProcess is spawned by tests as a fake ACP agent.
// It reads JSON-RPC requests (one JSON per line) from stdin and writes responses to stdout.
func TestACPHelperProcess(t *testing.T) {
	isHelper := false
	for _, arg := range os.Args {
		if arg == "acp-helper" {
			isHelper = true
			break
		}
	}
	if !isHelper {
		return
	}

	type reqEnvelope struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}

	mode := ""
	for _, arg := range os.Args {
		if strings.HasPrefix(arg, "acp-helper-mode=") {
			mode = strings.TrimPrefix(arg, "acp-helper-mode=")
			break
		}
	}

	enc := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req reqEnvelope
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}

		switch req.Method {
		case "initialize":
			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  map[string]any{},
			})
		case "session/new":
			if mode == "newsession-empty" {
				_ = enc.Encode(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(req.ID),
					"result": map[string]any{
						"sessionId": "",
					},
				})
				return
			}
			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"sessionId": "sess-1",
				},
			})
		case "session/prompt":
			if mode == "prompt-error" {
				_ = enc.Encode(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(req.ID),
					"error": map[string]any{
						"code":    -32000,
						"message": "boom",
					},
				})
				return
			}
			// Send a streaming update first.
			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "sess-1",
					"update": map[string]any{
						"type": "text",
						"text": "working",
					},
				},
			})

			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"sessionId":  "sess-1",
					"stopReason": "end_turn",
					"output": []any{
						map[string]any{
							"type": "text",
							"text": "done",
						},
					},
				},
			})
			return
		default:
			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"error": map[string]any{
					"code":    -32601,
					"message": "not supported",
				},
			})
		}
	}
}
