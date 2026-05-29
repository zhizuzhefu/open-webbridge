// Package protocol defines the JSON envelope exchanged between the daemon and
// the browser extension over the WebSocket link.
//
// Message types:
//
//	daemon -> extension: tool_call, hello_ack, ping
//	extension -> daemon: hello, pong, tool_result
package protocol

import "encoding/json"

// Envelope is the single wire struct for every message in both directions.
// Fields not relevant to a given type are omitted.
type Envelope struct {
	Type string `json:"type"`

	// Request correlation id (tool_call / tool_result).
	ID string `json:"id,omitempty"`

	// tool_call fields.
	Action  string          `json:"action,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Session string          `json:"session,omitempty"`

	// tool_result fields.
	OK    *bool           `json:"ok,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`

	// hello / hello_ack payload.
	Payload json.RawMessage `json:"payload,omitempty"`
}

// CommandRequest is the JSON body accepted at POST /command.
type CommandRequest struct {
	Action  string          `json:"action"`
	Args    json.RawMessage `json:"args"`
	Session string          `json:"session"`
}

// CommandResponse is what POST /command returns to the AI caller.
type CommandResponse struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

// Status is returned by GET /status.
type Status struct {
	Running            bool   `json:"running"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Remote             bool   `json:"remote"`
	Version            string `json:"version"`
	ExtensionConnected  bool   `json:"extension_connected"`
	ExtensionVersion    string `json:"extension_version"`
	ExtensionCompatible bool   `json:"extension_compatible"`
	UptimeSeconds       int64  `json:"uptime_seconds"`
}

// BoolPtr is a helper for the optional OK field.
func BoolPtr(b bool) *bool { return &b }
