package types

type RegisterAgentMessage struct {
	Type  string        `json:"type"`
	Agent RegisterAgent  `json:"agent"`
}

type RegisterAgent struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	MaxConcurrent int         `json:"max_concurrent"`
	Capabilities  interface{} `json:"capabilities,omitempty"`
}

type HeartbeatMessage struct {
	Type      string `json:"type"`
	AgentID   string `json:"agent_id"`
	Timestamp string `json:"timestamp,omitempty"`
}

type ExecuteTaskMessage struct {
	Type      string `json:"type"`
	RunID     string `json:"run_id"`
	SessionID string `json:"session_id"`
	Prompt    string `json:"prompt"`
}

type PromptRunMessage struct {
	Type   string `json:"type"`
	RunID  string `json:"run_id"`
	SessionID string `json:"session_id,omitempty"`
	Prompt string `json:"prompt"`
}

type AgentUpdateMessage struct {
	Type    string      `json:"type"`
	RunID   string      `json:"run_id"`
	Content interface{} `json:"content"`
}
