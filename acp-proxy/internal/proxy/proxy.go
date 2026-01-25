package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"acp-proxy/internal/acp"
	"acp-proxy/internal/config"
	"acp-proxy/internal/types"

	"github.com/gorilla/websocket"
)

type Proxy struct {
	cfg *config.Config

	connMu sync.Mutex
	conn   wsWriter

	acpMu     sync.Mutex
	acpClient *acp.Client

	execSem chan struct{}

	sessionMu    sync.RWMutex
	sessionToRun map[string]string
}

type wsWriter interface {
	WriteMessage(messageType int, data []byte) error
}

func New(cfg *config.Config) *Proxy {
	return &Proxy{
		cfg:          cfg,
		execSem:      make(chan struct{}, cfg.Agent.MaxConcurrent),
		sessionToRun: map[string]string{},
	}
}

func (p *Proxy) Run() error {
	for {
		if err := p.connectAndServe(); err != nil {
			log.Printf("proxy error: %v", err)
		}

		time.Sleep(2 * time.Second)
	}
}

func (p *Proxy) connectAndServe() error {
	log.Printf("connecting: %s", p.cfg.OrchestratorURL)
	conn, _, err := websocket.DefaultDialer.Dial(p.cfg.OrchestratorURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	p.connMu.Lock()
	p.conn = conn
	p.connMu.Unlock()

	if err := p.registerAgent(); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go p.heartbeatLoop(ctx)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		var base struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &base); err != nil {
			log.Printf("ignore invalid ws json: %v", err)
			continue
		}

		if base.Type == "execute_task" {
			var msg types.ExecuteTaskMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("bad execute_task: %v", err)
				continue
			}
			go p.handleExecuteTask(ctx, msg)
			continue
		}
	}
}

func (p *Proxy) registerAgent() error {
	msg := types.RegisterAgentMessage{
		Type: "register_agent",
		Agent: types.RegisterAgent{
			ID:            p.cfg.Agent.ID,
			Name:          p.cfg.Agent.Name,
			MaxConcurrent: p.cfg.Agent.MaxConcurrent,
			Capabilities:  p.cfg.Agent.Capabilities,
		},
	}
	return p.send(msg)
}

func (p *Proxy) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(time.Duration(p.cfg.HeartbeatSeconds) * time.Second)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = p.send(types.HeartbeatMessage{
				Type:    "heartbeat",
				AgentID: p.cfg.Agent.ID,
			})
		}
	}
}

func (p *Proxy) handleExecuteTask(ctx context.Context, msg types.ExecuteTaskMessage) {
	select {
	case p.execSem <- struct{}{}:
		defer func() { <-p.execSem }()
	case <-ctx.Done():
		return
	}

	if p.cfg.MockMode {
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]interface{}{
				"type": "text",
				"text": fmt.Sprintf("[mock] received prompt: %s", msg.Prompt),
			},
		})
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type":       "prompt_result",
				"stopReason": "end_turn",
				"output": []any{
					map[string]any{
						"type": "text",
						"text": "[mock] done",
					},
				},
			},
		})
		return
	}

	client, err := p.ensureACPClient()
	if err != nil {
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("启动 codex-acp 失败: %v", err),
			},
		})
		return
	}

	initCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := client.Initialize(initCtx); err != nil {
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("ACP initialize 失败: %v", err),
			},
		})
		return
	}

	sessionID, err := client.NewSession(initCtx, p.cfg.Cwd)
	if err != nil {
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("ACP session/new 失败: %v", err),
			},
		})
		return
	}

	p.sessionMu.Lock()
	p.sessionToRun[sessionID] = msg.RunID
	p.sessionMu.Unlock()
	defer func() {
		p.sessionMu.Lock()
		delete(p.sessionToRun, sessionID)
		p.sessionMu.Unlock()
	}()

	_ = p.send(types.AgentUpdateMessage{
		Type:  "agent_update",
		RunID: msg.RunID,
		Content: map[string]any{
			"type": "text",
			"text": fmt.Sprintf("✅ ACP session 已创建: %s", sessionID),
		},
	})

	promptCtx, cancelPrompt := context.WithTimeout(ctx, 60*time.Minute)
	defer cancelPrompt()

	result, err := client.Prompt(promptCtx, sessionID, msg.Prompt)
	if err != nil {
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("ACP session/prompt 失败: %v", err),
			},
		})
		return
	}

	_ = p.send(types.AgentUpdateMessage{
		Type:  "agent_update",
		RunID: msg.RunID,
		Content: map[string]any{
			"type":       "prompt_result",
			"stopReason": result.StopReason,
			"output":     result.Output,
		},
	})
}

func (p *Proxy) send(v interface{}) error {
	p.connMu.Lock()
	conn := p.conn
	p.connMu.Unlock()
	if conn == nil {
		return fmt.Errorf("ws not connected")
	}

	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, b)
}

func (p *Proxy) ensureACPClient() (*acp.Client, error) {
	p.acpMu.Lock()
	defer p.acpMu.Unlock()

	if p.acpClient != nil {
		return p.acpClient, nil
	}

	client := acp.New(p.cfg.AgentCommand, p.cfg.Cwd, func(sessionID string, update json.RawMessage) {
		p.sessionMu.RLock()
		runID := p.sessionToRun[sessionID]
		p.sessionMu.RUnlock()
		if runID == "" {
			return
		}
		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: runID,
			Content: map[string]any{
				"type":    "session_update",
				"update":  json.RawMessage(update),
				"session": sessionID,
			},
		})
	})

	p.acpClient = client
	return client, nil
}
