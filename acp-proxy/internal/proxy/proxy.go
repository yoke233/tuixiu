package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"acp-proxy/internal/acp"
	"acp-proxy/internal/config"
	"acp-proxy/internal/types"

	"github.com/gorilla/websocket"
)

type chunkState struct {
	buf       strings.Builder
	lastFlush time.Time
}

type Proxy struct {
	cfg *config.Config

	connMu sync.Mutex
	conn   wsWriter

	acpMu     sync.Mutex
	acpClient *acp.Client

	execSem chan struct{}

	sessionMu    sync.RWMutex
	sessionToRun map[string]string
	runToSession map[string]string

	chunkMu    sync.Mutex
	chunkBySes map[string]*chunkState
}

type wsWriter interface {
	WriteMessage(messageType int, data []byte) error
}

func New(cfg *config.Config) *Proxy {
	return &Proxy{
		cfg:          cfg,
		execSem:      make(chan struct{}, cfg.Agent.MaxConcurrent),
		sessionToRun: map[string]string{},
		runToSession: map[string]string{},
		chunkBySes:   map[string]*chunkState{},
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

		if base.Type == "prompt_run" {
			var msg types.PromptRunMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("bad prompt_run: %v", err)
				continue
			}
			go p.handlePromptRun(ctx, msg)
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

	sessionID := p.getSessionForRun(msg.RunID)
	if sessionID == "" {
		sid, err := client.NewSession(initCtx, p.cfg.Cwd)
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
		sessionID = sid
		p.setRunSession(msg.RunID, sessionID)

		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type":       "session_created",
				"session_id": sessionID,
			},
		})

		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("✅ ACP session 已创建: %s", sessionID),
			},
		})
	}

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
	p.flushAndSendChunks(msg.RunID, sessionID)

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

func (p *Proxy) handlePromptRun(ctx context.Context, msg types.PromptRunMessage) {
	select {
	case p.execSem <- struct{}{}:
		defer func() { <-p.execSem }()
	case <-ctx.Done():
		return
	}

	sessionID := p.getSessionForRun(msg.RunID)
	if sessionID == "" && msg.SessionID != "" {
		sessionID = msg.SessionID
		p.setRunSession(msg.RunID, sessionID)
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

	if sessionID == "" {
		sidCtx, cancelSid := context.WithTimeout(ctx, 60*time.Second)
		defer cancelSid()

		sid, err := client.NewSession(sidCtx, p.cfg.Cwd)
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

		sessionID = sid
		p.setRunSession(msg.RunID, sessionID)

		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type":       "session_created",
				"session_id": sessionID,
			},
		})

		_ = p.send(types.AgentUpdateMessage{
			Type:  "agent_update",
			RunID: msg.RunID,
			Content: map[string]any{
				"type": "text",
				"text": fmt.Sprintf("⚠️ ACP session 不存在/已丢失，已创建新 session: %s（上下文可能丢失）", sessionID),
			},
		})
	}

	promptCtx, cancelPrompt := context.WithTimeout(ctx, 60*time.Minute)
	defer cancelPrompt()

	result, err := client.Prompt(promptCtx, sessionID, msg.Prompt)
	if err != nil {
		// session 可能已失效：尝试重建一次（避免用户看到“请先启动 Run”）。
		sidCtx, cancelSid := context.WithTimeout(ctx, 60*time.Second)
		defer cancelSid()

		sid, serr := client.NewSession(sidCtx, p.cfg.Cwd)
		if serr == nil && sid != "" {
			sessionID = sid
			p.setRunSession(msg.RunID, sessionID)

			_ = p.send(types.AgentUpdateMessage{
				Type:  "agent_update",
				RunID: msg.RunID,
				Content: map[string]any{
					"type":       "session_created",
					"session_id": sessionID,
				},
			})
			_ = p.send(types.AgentUpdateMessage{
				Type:  "agent_update",
				RunID: msg.RunID,
				Content: map[string]any{
					"type": "text",
					"text": fmt.Sprintf("⚠️ ACP session 已失效，已重建 session: %s（上下文可能丢失）", sessionID),
				},
			})

			result, err = client.Prompt(promptCtx, sessionID, msg.Prompt)
		}
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
	}
	p.flushAndSendChunks(msg.RunID, sessionID)

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
		runID := p.getRunForSession(sessionID)
		if runID == "" {
			return
		}

		var meta struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(update, &meta); err == nil && meta.SessionUpdate != "" {
			if meta.SessionUpdate == "agent_message_chunk" {
				text := extractTextContent(meta.Content)
				if text != "" {
					flushed := p.appendChunk(sessionID, text)
					if flushed != "" {
						p.sendChunkUpdate(runID, sessionID, flushed)
					}
					return
				}
			}

			// 非 chunk 的 update 先 flush，保证顺序。
			p.flushAndSendChunks(runID, sessionID)
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

func (p *Proxy) getRunForSession(sessionID string) string {
	p.sessionMu.RLock()
	defer p.sessionMu.RUnlock()
	return p.sessionToRun[sessionID]
}

func (p *Proxy) getSessionForRun(runID string) string {
	p.sessionMu.RLock()
	defer p.sessionMu.RUnlock()
	return p.runToSession[runID]
}

func (p *Proxy) setRunSession(runID string, sessionID string) {
	p.sessionMu.Lock()
	defer p.sessionMu.Unlock()
	p.runToSession[runID] = sessionID
	p.sessionToRun[sessionID] = runID
}

func (p *Proxy) appendChunk(sessionID string, text string) string {
	p.chunkMu.Lock()
	defer p.chunkMu.Unlock()

	state, ok := p.chunkBySes[sessionID]
	if !ok {
		state = &chunkState{lastFlush: time.Now()}
		p.chunkBySes[sessionID] = state
	}
	state.buf.WriteString(text)

	now := time.Now()
	if strings.Contains(text, "\n") || state.buf.Len() >= 256 || now.Sub(state.lastFlush) >= 200*time.Millisecond {
		out := state.buf.String()
		state.buf.Reset()
		state.lastFlush = now
		return out
	}
	return ""
}

func (p *Proxy) flushChunks(sessionID string) string {
	p.chunkMu.Lock()
	defer p.chunkMu.Unlock()

	state, ok := p.chunkBySes[sessionID]
	if !ok {
		return ""
	}
	if state.buf.Len() == 0 {
		return ""
	}
	out := state.buf.String()
	state.buf.Reset()
	state.lastFlush = time.Now()
	return out
}

func (p *Proxy) sendChunkUpdate(runID string, sessionID string, text string) {
	_ = p.send(types.AgentUpdateMessage{
		Type:  "agent_update",
		RunID: runID,
		Content: map[string]any{
			"type": "session_update",
			"update": map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content": map[string]any{
					"type": "text",
					"text": text,
				},
			},
			"session": sessionID,
		},
	})
}

func (p *Proxy) flushAndSendChunks(runID string, sessionID string) {
	text := p.flushChunks(sessionID)
	if text == "" {
		return
	}
	p.sendChunkUpdate(runID, sessionID, text)
}

func extractTextContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	if v.Type != "text" {
		return ""
	}
	return v.Text
}
