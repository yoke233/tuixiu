package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type SessionUpdateHandler func(sessionID string, update json.RawMessage)

type Client struct {
	command []string

	dir string

	onSessionUpdate SessionUpdateHandler

	procMu  sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	stderr  io.ReadCloser
	stopped chan struct{}

	writeMu sync.Mutex

	nextID atomic.Int64
	initialized atomic.Bool

	pendingMu sync.Mutex
	pending   map[string]chan rpcResponse
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcResponse struct {
	result json.RawMessage
	err    *rpcError
}

type initializeParams struct {
	ProtocolVersion     int `json:"protocolVersion"`
	ClientCapabilities  any `json:"clientCapabilities,omitempty"`
	ClientInfo          any `json:"clientInfo,omitempty"`
	Meta                any `json:"_meta,omitempty"`
	AdditionalFieldHack any `json:"additionalFieldHack,omitempty"`
}

type sessionNewParams struct {
	Cwd        string `json:"cwd"`
	McpServers []any  `json:"mcpServers"`
}

type sessionNewResult struct {
	SessionID string `json:"sessionId"`
}

type sessionPromptParams struct {
	SessionID string `json:"sessionId"`
	Prompt    []any  `json:"prompt"`
}

type sessionPromptResult struct {
	SessionID   string `json:"sessionId"`
	StopReason  string `json:"stopReason,omitempty"`
	Output      any    `json:"output,omitempty"`
	ToolCalls   any    `json:"toolCalls,omitempty"`
	Annotations any    `json:"annotations,omitempty"`
}

type sessionUpdateParams struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

type permissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

type requestPermissionParams struct {
	SessionID string          `json:"sessionId"`
	ToolCall  json.RawMessage `json:"toolCall"`
	Options   []permissionOption `json:"options"`
}

func New(command []string, dir string, onSessionUpdate SessionUpdateHandler) *Client {
	return &Client{
		command:         command,
		dir:             dir,
		onSessionUpdate: onSessionUpdate,
		pending:         map[string]chan rpcResponse{},
	}
}

func (c *Client) Initialize(ctx context.Context) error {
	if c.initialized.Load() {
		return nil
	}
	params := map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{
				"readTextFile":  false,
				"writeTextFile": false,
			},
			"terminal": false,
		},
		"clientInfo": map[string]any{
			"name":    "acp-proxy",
			"title":   "ACP Proxy",
			"version": "0.1.0",
		},
	}

	_, err := c.Call(ctx, "initialize", params)
	if err != nil {
		return err
	}
	c.initialized.Store(true)
	return nil
}

func (c *Client) NewSession(ctx context.Context, cwd string) (string, error) {
	params := sessionNewParams{Cwd: cwd, McpServers: []any{}}
	resultRaw, err := c.Call(ctx, "session/new", params)
	if err != nil {
		return "", err
	}

	var result sessionNewResult
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		return "", err
	}
	if result.SessionID == "" {
		return "", fmt.Errorf("session/new returned empty sessionId")
	}
	return result.SessionID, nil
}

func (c *Client) Prompt(ctx context.Context, sessionID string, prompt string) (*sessionPromptResult, error) {
	params := sessionPromptParams{
		SessionID: sessionID,
		Prompt: []any{
			map[string]any{
				"type": "text",
				"text": prompt,
			},
		},
	}

	resultRaw, err := c.Call(ctx, "session/prompt", params)
	if err != nil {
		return nil, err
	}

	var result sessionPromptResult
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := c.ensureRunning(); err != nil {
		return nil, err
	}

	id := c.nextID.Add(1)
	idKey := strconv.FormatInt(id, 10)

	ch := make(chan rpcResponse, 1)
	c.pendingMu.Lock()
	c.pending[idKey] = ch
	c.pendingMu.Unlock()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := c.writeJSONLine(req); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, idKey)
		c.pendingMu.Unlock()
		return nil, err
	}

	select {
	case <-ctx.Done():
		c.pendingMu.Lock()
		delete(c.pending, idKey)
		c.pendingMu.Unlock()
		return nil, ctx.Err()
	case resp := <-ch:
		if resp.err != nil {
			return nil, fmt.Errorf("rpc error %d: %s", resp.err.Code, resp.err.Message)
		}
		return resp.result, nil
	}
}

func (c *Client) ensureRunning() error {
	c.procMu.Lock()
	defer c.procMu.Unlock()

	if c.cmd != nil {
		select {
		case <-c.stopped:
			c.cmd = nil
		default:
			return nil
		}
	}

	if len(c.command) == 0 {
		return fmt.Errorf("agent_command is empty")
	}

	cmd := exec.Command(c.command[0], c.command[1:]...)
	cmd.Dir = c.dir
	cmd.Env = os.Environ()

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

	if err := cmd.Start(); err != nil {
		return err
	}

	c.cmd = cmd
	c.stdin = stdin
	c.stdout = stdout
	c.stderr = stderr
	c.stopped = make(chan struct{})
	c.initialized.Store(false)

	go c.readStdout()
	go c.readStderr()

	return nil
}

func (c *Client) readStdout() {
	cmd := func() *exec.Cmd {
		c.procMu.Lock()
		defer c.procMu.Unlock()
		return c.cmd
	}()

	defer func() {
		c.pendingMu.Lock()
		for key, ch := range c.pending {
			delete(c.pending, key)
			ch <- rpcResponse{err: &rpcError{Code: -1, Message: "agent process exited"}}
		}
		c.pendingMu.Unlock()

		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}

		close(c.stopped)
	}()

	reader := bufio.NewReader(c.stdout)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			c.handleLine(bytesTrimSpace(line))
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}
	}
}

func (c *Client) readStderr() {
	reader := bufio.NewReader(c.stderr)
	for {
		_, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
	}
}

func (c *Client) handleLine(line []byte) {
	if len(line) == 0 {
		return
	}

	var env rpcEnvelope
	if err := json.Unmarshal(line, &env); err != nil {
		return
	}

	// Agent -> Client notification
	if env.Method != "" && len(env.ID) == 0 {
		if env.Method == "session/update" && c.onSessionUpdate != nil {
			var params sessionUpdateParams
			if err := json.Unmarshal(env.Params, &params); err != nil {
				return
			}
			c.onSessionUpdate(params.SessionID, params.Update)
		}
		return
	}

	// Agent -> Client request
	if env.Method != "" && len(env.ID) != 0 {
		if env.Method == "session/request_permission" {
			c.handleRequestPermission(env.ID, env.Params)
			return
		}

		// Unknown request: respond method not found to avoid agent hanging.
		_ = c.writeJSONLine(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(env.ID),
			"error": map[string]any{
				"code":    -32601,
				"message": fmt.Sprintf("method not supported: %s", env.Method),
			},
		})
		return
	}

	// Client -> Agent response
	if len(env.ID) != 0 {
		key, ok := idKeyFromRaw(env.ID)
		if !ok {
			return
		}
		c.pendingMu.Lock()
		ch, ok := c.pending[key]
		if ok {
			delete(c.pending, key)
		}
		c.pendingMu.Unlock()
		if !ok {
			return
		}
		ch <- rpcResponse{result: env.Result, err: env.Error}
	}
}

func (c *Client) handleRequestPermission(id json.RawMessage, paramsRaw json.RawMessage) {
	var params requestPermissionParams
	if err := json.Unmarshal(paramsRaw, &params); err != nil {
		_ = c.writeJSONLine(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(id),
			"result": map[string]any{
				"outcome": map[string]any{
					"outcome": "cancelled",
				},
			},
		})
		return
	}

	selected := ""
	for _, opt := range params.Options {
		if opt.Kind == "allow_once" {
			selected = opt.OptionID
			break
		}
	}
	if selected == "" && len(params.Options) > 0 {
		selected = params.Options[0].OptionID
	}
	if selected == "" {
		_ = c.writeJSONLine(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(id),
			"result": map[string]any{
				"outcome": map[string]any{
					"outcome": "cancelled",
				},
			},
		})
		return
	}

	_ = c.writeJSONLine(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"result": map[string]any{
			"outcome": map[string]any{
				"outcome":  "selected",
				"optionId": selected,
			},
		},
	})
}

func (c *Client) writeJSONLine(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if c.stdin == nil {
		return fmt.Errorf("agent stdin not available")
	}

	_, err = c.stdin.Write(append(b, '\n'))
	return err
}

func idKeyFromRaw(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}

	var i int64
	if err := json.Unmarshal(raw, &i); err == nil {
		return strconv.FormatInt(i, 10), true
	}

	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, true
	}

	return string(raw), true
}

func bytesTrimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && (b[start] == ' ' || b[start] == '\n' || b[start] == '\r' || b[start] == '\t') {
		start++
	}
	end := len(b)
	for end > start && (b[end-1] == ' ' || b[end-1] == '\n' || b[end-1] == '\r' || b[end-1] == '\t') {
		end--
	}
	return b[start:end]
}

func withTimeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if _, has := parent.Deadline(); has {
		return parent, func() {}
	}
	return context.WithTimeout(parent, d)
}
