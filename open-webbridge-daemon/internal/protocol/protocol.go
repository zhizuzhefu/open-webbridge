// Package protocol defines the JSON envelope exchanged between the daemon and
// the browser extension over the WebSocket link.
//
// Message types:
//
//	daemon -> extension: tool_call, hello_ack, ping
//	extension -> daemon: hello, pong, tool_result
package protocol

import (
	"encoding/json"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

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

	// DomainTabLimits (if any) are sent on every tool_call so the extension can
	// enforce per-domain concurrent tab caps without requiring a restart or
	// extra WS message. Most-specific (longest) domain wins, same as rate limits.
	DomainTabLimits []config.DomainTabLimit `json:"domain_tab_limits,omitempty"`

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
	Running             bool   `json:"running"`
	Host                string `json:"host"`
	Port                int    `json:"port"`
	Remote              bool   `json:"remote"`
	Version             string `json:"version"`
	ExtensionConnected  bool   `json:"extension_connected"`
	ExtensionVersion    string `json:"extension_version"`
	ExtensionCompatible bool   `json:"extension_compatible"`
	UptimeSeconds       int64  `json:"uptime_seconds"`
	// RateLimits is the active per-domain navigation throttle config, surfaced
	// so callers (and the AI) can see what is in effect.
	RateLimits []config.RateLimit `json:"rate_limits,omitempty"`
	// RateLimitStatus provides live runtime info (in-use slots and estimated
	// wait for next slot) for the configured rate limits. Populated when the
	// daemon is running.
	RateLimitStatus []RateLimitStatus `json:"rate_limit_status,omitempty"`
	// DomainTabLimits are the active per-domain caps on concurrent OWB tabs.
	DomainTabLimits []config.DomainTabLimit `json:"domain_tab_limits,omitempty"`
}

// RateLimitStatus is the wire representation of live rate limit usage.
type RateLimitStatus struct {
	Domain      string  `json:"domain"`
	Max         int     `json:"max"`
	Window      int     `json:"window_seconds"`
	InUse       int     `json:"in_use"`
	WaitSeconds float64 `json:"wait_seconds"`
}

// BoolPtr is a helper for the optional OK field.
func BoolPtr(b bool) *bool { return &b }
