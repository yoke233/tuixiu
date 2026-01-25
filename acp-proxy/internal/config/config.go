package config

import (
	"encoding/json"
	"fmt"
	"os"
)

type Config struct {
	OrchestratorURL   string   `json:"orchestrator_url"`
	AuthToken         string   `json:"auth_token"`
	Cwd               string   `json:"cwd"`
	HeartbeatSeconds  int      `json:"heartbeat_seconds"`
	MockMode          bool     `json:"mock_mode"`
	AgentCommand      []string `json:"agent_command"`
	Agent             Agent    `json:"agent"`
}

type Agent struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	MaxConcurrent int         `json:"max_concurrent"`
	Capabilities  interface{} `json:"capabilities"`
}

func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, err
	}

	if cfg.OrchestratorURL == "" {
		return nil, fmt.Errorf("orchestrator_url is required")
	}
	if cfg.Agent.ID == "" {
		return nil, fmt.Errorf("agent.id is required")
	}
	if cfg.Cwd == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("cwd is required (and Getwd failed): %w", err)
		}
		cfg.Cwd = cwd
	}
	if cfg.Agent.Name == "" {
		cfg.Agent.Name = cfg.Agent.ID
	}
	if cfg.Agent.MaxConcurrent <= 0 {
		cfg.Agent.MaxConcurrent = 1
	}
	if cfg.HeartbeatSeconds <= 0 {
		cfg.HeartbeatSeconds = 30
	}
	if len(cfg.AgentCommand) == 0 {
		cfg.AgentCommand = []string{"npx", "--yes", "@zed-industries/codex-acp"}
	}

	return &cfg, nil
}
