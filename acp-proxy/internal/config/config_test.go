package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTempJSON(t *testing.T, dir string, name string, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp json: %v", err)
	}
	return path
}

func TestLoad_ValidatesRequiredFields(t *testing.T) {
	dir := t.TempDir()

	t.Run("missing orchestrator_url", func(t *testing.T) {
		path := writeTempJSON(t, dir, "cfg1.json", `{"agent":{"id":"a1"}}`)
		_, err := Load(path)
		if err == nil {
			t.Fatalf("expected error")
		}
	})

	t.Run("missing agent.id", func(t *testing.T) {
		path := writeTempJSON(t, dir, "cfg2.json", `{"orchestrator_url":"ws://localhost:3000/ws/agent"}`)
		_, err := Load(path)
		if err == nil {
			t.Fatalf("expected error")
		}
	})
}

func TestLoad_Defaults(t *testing.T) {
	dir := t.TempDir()
	path := writeTempJSON(
		t,
		dir,
		"cfg.json",
		`{
  "orchestrator_url": "ws://localhost:3000/ws/agent",
  "agent": { "id": "proxy-1" }
}`,
	)

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Cwd != wd {
		t.Fatalf("expected cwd=%q, got %q", wd, cfg.Cwd)
	}
	if cfg.Agent.Name != "proxy-1" {
		t.Fatalf("expected agent.name to default to id, got %q", cfg.Agent.Name)
	}
	if cfg.Agent.MaxConcurrent != 1 {
		t.Fatalf("expected agent.max_concurrent default 1, got %d", cfg.Agent.MaxConcurrent)
	}
	if cfg.HeartbeatSeconds != 30 {
		t.Fatalf("expected heartbeat_seconds default 30, got %d", cfg.HeartbeatSeconds)
	}
	if len(cfg.AgentCommand) != 3 || cfg.AgentCommand[0] != "npx" || cfg.AgentCommand[1] != "--yes" || cfg.AgentCommand[2] != "@zed-industries/codex-acp" {
		t.Fatalf("expected default agent_command to be npx --yes @zed-industries/codex-acp, got %#v", cfg.AgentCommand)
	}
}

func TestLoad_RespectsProvidedValues(t *testing.T) {
	dir := t.TempDir()
	path := writeTempJSON(
		t,
		dir,
		"cfg.json",
		`{
  "orchestrator_url": "ws://localhost:3000/ws/agent",
  "cwd": "D:/work",
  "heartbeat_seconds": 5,
  "mock_mode": true,
  "agent_command": ["my-agent", "--acp"],
  "agent": { "id": "proxy-1", "name": "Proxy One", "max_concurrent": 3 }
}`,
	)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Cwd != "D:/work" {
		t.Fatalf("expected cwd to be preserved")
	}
	if cfg.HeartbeatSeconds != 5 {
		t.Fatalf("expected heartbeat_seconds=5")
	}
	if cfg.MockMode != true {
		t.Fatalf("expected mock_mode=true")
	}
	if cfg.Agent.Name != "Proxy One" {
		t.Fatalf("expected agent.name preserved")
	}
	if cfg.Agent.MaxConcurrent != 3 {
		t.Fatalf("expected agent.max_concurrent=3")
	}
	if len(cfg.AgentCommand) != 2 || cfg.AgentCommand[0] != "my-agent" || cfg.AgentCommand[1] != "--acp" {
		t.Fatalf("expected agent_command preserved")
	}
}

