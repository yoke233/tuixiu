package acp

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

type bufferWriteCloser struct {
	bytes.Buffer
}

func (b *bufferWriteCloser) Close() error { return nil }

func lastNonEmptyLine(s string) string {
	lines := bytes.Split([]byte(s), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		if len(bytes.TrimSpace(lines[i])) == 0 {
			continue
		}
		return string(lines[i])
	}
	return ""
}

func TestBytesTrimSpace(t *testing.T) {
	got := bytesTrimSpace([]byte(" \n\t hello \r\n"))
	if string(got) != "hello" {
		t.Fatalf("expected hello, got %q", string(got))
	}
}

func TestIDKeyFromRaw(t *testing.T) {
	t.Run("int", func(t *testing.T) {
		key, ok := idKeyFromRaw(json.RawMessage("123"))
		if !ok || key != "123" {
			t.Fatalf("expected 123, got %q ok=%v", key, ok)
		}
	})

	t.Run("string", func(t *testing.T) {
		key, ok := idKeyFromRaw(json.RawMessage(`"abc"`))
		if !ok || key != "abc" {
			t.Fatalf("expected abc, got %q ok=%v", key, ok)
		}
	})

	t.Run("raw fallback", func(t *testing.T) {
		key, ok := idKeyFromRaw(json.RawMessage(`{"x":1}`))
		if !ok || key == "" {
			t.Fatalf("expected non-empty fallback, got %q ok=%v", key, ok)
		}
	})
}

func TestHandleLine_SessionUpdateNotification(t *testing.T) {
	var gotSession string
	var gotUpdate json.RawMessage
	c := New([]string{"dummy"}, "", func(sessionID string, update json.RawMessage) {
		gotSession = sessionID
		gotUpdate = update
	})

	c.handleLine([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"type":"text","text":"hi"}}}`))

	if gotSession != "sess-1" {
		t.Fatalf("expected sess-1, got %q", gotSession)
	}
	var upd map[string]any
	if err := json.Unmarshal(gotUpdate, &upd); err != nil {
		t.Fatalf("unmarshal update: %v", err)
	}
	if upd["type"] != "text" {
		t.Fatalf("expected update.type=text, got %#v", upd["type"])
	}
}

func TestHandleLine_RequestPermission_SelectsAllowOnce(t *testing.T) {
	c := New([]string{"dummy"}, "", nil)
	out := &bufferWriteCloser{}
	c.stdin = out

	c.handleLine([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{},"options":[{"optionId":"deny","name":"Deny","kind":"deny"},{"optionId":"allow","name":"Allow once","kind":"allow_once"}]}}`))

	line := lastNonEmptyLine(out.String())
	if line == "" {
		t.Fatalf("expected response line")
	}

	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	result, _ := resp["result"].(map[string]any)
	outcome, _ := result["outcome"].(map[string]any)
	if outcome["outcome"] != "selected" {
		t.Fatalf("expected outcome.selected, got %#v", outcome["outcome"])
	}
	if outcome["optionId"] != "allow" {
		t.Fatalf("expected optionId=allow, got %#v", outcome["optionId"])
	}
}

func TestHandleLine_RequestPermission_CancelsWhenNoOptions(t *testing.T) {
	c := New([]string{"dummy"}, "", nil)
	out := &bufferWriteCloser{}
	c.stdin = out

	c.handleLine([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{},"options":[]}}`))

	line := lastNonEmptyLine(out.String())
	if line == "" {
		t.Fatalf("expected response line")
	}

	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	result, _ := resp["result"].(map[string]any)
	outcome, _ := result["outcome"].(map[string]any)
	if outcome["outcome"] != "cancelled" {
		t.Fatalf("expected outcome.cancelled, got %#v", outcome["outcome"])
	}
}

func TestHandleLine_UnknownRequest_MethodNotFound(t *testing.T) {
	c := New([]string{"dummy"}, "", nil)
	out := &bufferWriteCloser{}
	c.stdin = out

	c.handleLine([]byte(`{"jsonrpc":"2.0","id":7,"method":"unknown/method","params":{}}`))

	line := lastNonEmptyLine(out.String())
	if line == "" {
		t.Fatalf("expected response line")
	}

	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	errObj, _ := resp["error"].(map[string]any)
	if errObj["code"] != float64(-32601) {
		t.Fatalf("expected code -32601, got %#v", errObj["code"])
	}
}

func TestHandleLine_ResponseUnblocksPendingCall(t *testing.T) {
	c := New([]string{"dummy"}, "", nil)
	ch := make(chan rpcResponse, 1)
	c.pending = map[string]chan rpcResponse{"3": ch}

	c.handleLine([]byte(`{"jsonrpc":"2.0","id":3,"result":{"ok":true}}`))

	select {
	case resp := <-ch:
		if resp.err != nil {
			t.Fatalf("unexpected err: %#v", resp.err)
		}
		var got map[string]any
		if err := json.Unmarshal(resp.result, &got); err != nil {
			t.Fatalf("unmarshal result: %v", err)
		}
		if got["ok"] != true {
			t.Fatalf("expected ok=true, got %#v", got["ok"])
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("timeout waiting for response")
	}
}

