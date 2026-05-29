// Package hub owns the single live WebSocket connection to the browser
// extension and correlates request/response pairs so that the HTTP layer can
// expose a simple synchronous Call() to the AI.
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/protocol"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/wsserver"
)

// ErrNoExtension is returned by Call when no browser extension is attached.
var ErrNoExtension = errors.New("no browser extension connected — open your browser and make sure the Open WebBridge extension is enabled")

// staleAfter is how long without any inbound message (pongs arrive every ~20s)
// before an existing extension connection is considered dead and a newcomer is
// allowed to take over instead of being rejected.
const staleAfter = 50 * time.Second

// Hub multiplexes tool calls over one extension connection.
type Hub struct {
	daemonVersion string

	mu           sync.Mutex
	conn         *wsserver.Conn
	extVer       string
	extProtocol  int
	connected    bool
	compatible   bool
	lastActivity time.Time
	seq          uint64
	pending      map[string]chan protocol.Envelope
}

func New(daemonVersion string) *Hub {
	return &Hub{
		daemonVersion: daemonVersion,
		pending:       make(map[string]chan protocol.Envelope),
	}
}

// Connected reports whether an extension is currently attached.
func (h *Hub) Connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connected
}

// ExtensionVersion returns the version reported in the extension's hello.
func (h *Hub) ExtensionVersion() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.extVer
}

// Compatible reports whether the attached extension meets the minimum version.
func (h *Hub) Compatible() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connected && h.compatible
}

// Serve takes ownership of a freshly upgraded connection and blocks until it
// closes.
//
// Connection arbitration (#4): a single extension connection is held at a time.
// If one is already attached AND still alive (a pong/message within staleAfter),
// the newcomer is REJECTED with a clear reason — this prevents two browsers from
// endlessly kicking each other. If the existing connection looks dead, the
// newcomer takes over.
func (h *Hub) Serve(conn *wsserver.Conn) {
	h.mu.Lock()
	if h.conn != nil && time.Since(h.lastActivity) < staleAfter {
		h.mu.Unlock()
		log.Printf("[hub] rejecting new extension connection; another is already active")
		_ = writeJSON(conn, protocol.Envelope{Type: "connection_rejected", Payload: mustJSON(map[string]string{
			"reason": "another browser is already connected to this daemon — disconnect it there first (Open WebBridge popup → Disconnect)",
		})})
		conn.Close()
		return
	}
	if h.conn != nil {
		old := h.conn
		go old.Close()
		log.Printf("[hub] previous connection looked stale; taking over")
	}
	h.conn = conn
	h.connected = true
	h.compatible = true // optimistic until hello is evaluated
	h.lastActivity = time.Now()
	h.mu.Unlock()
	log.Printf("[hub] extension connected")

	stopPing := make(chan struct{})
	go h.keepalive(conn, stopPing)

	defer func() {
		close(stopPing)
		h.mu.Lock()
		if h.conn == conn {
			h.conn = nil
			h.connected = false
			h.extVer = ""
			for id, ch := range h.pending {
				ch <- protocol.Envelope{Type: "tool_result", ID: id, OK: protocol.BoolPtr(false), Error: "extension disconnected"}
				delete(h.pending, id)
			}
		}
		h.mu.Unlock()
		conn.Close()
		log.Printf("[hub] extension disconnected")
	}()

	for {
		msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		h.touch()
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(msg), &env); err != nil {
			log.Printf("[hub] bad message: %v", err)
			continue
		}
		h.handleInbound(conn, env)
	}
}

func (h *Hub) touch() {
	h.mu.Lock()
	h.lastActivity = time.Now()
	h.mu.Unlock()
}

func (h *Hub) handleInbound(conn *wsserver.Conn, env protocol.Envelope) {
	switch env.Type {
	case "hello":
		var p struct {
			ExtensionVersion string `json:"extensionVersion"`
			ProtocolVersion  int    `json:"protocolVersion"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		// Compatibility is decided by the protocol version, not the release
		// version — daemon and extension version independently.
		compatible := p.ProtocolVersion == config.ProtocolVersion
		h.mu.Lock()
		h.extVer = p.ExtensionVersion
		h.extProtocol = p.ProtocolVersion
		h.compatible = compatible
		h.mu.Unlock()
		_ = writeJSON(conn, protocol.Envelope{Type: "hello_ack", Payload: mustJSON(map[string]any{
			"daemonVersion":   h.daemonVersion,
			"protocolVersion": config.ProtocolVersion,
			"compatible":      compatible,
		})})
		if compatible {
			log.Printf("[hub] hello from extension v%s (protocol %d, compatible)", p.ExtensionVersion, p.ProtocolVersion)
		} else {
			log.Printf("[hub] protocol mismatch: extension protocol %d, daemon protocol %d", p.ProtocolVersion, config.ProtocolVersion)
		}
	case "pong":
		// keepalive reply; activity already touched
	case "tool_result":
		h.mu.Lock()
		ch := h.pending[env.ID]
		delete(h.pending, env.ID)
		h.mu.Unlock()
		if ch != nil {
			ch <- env
		}
	default:
		log.Printf("[hub] unhandled message type %q", env.Type)
	}
}

func (h *Hub) keepalive(conn *wsserver.Conn, stop chan struct{}) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if err := writeJSON(conn, protocol.Envelope{Type: "ping"}); err != nil {
				return
			}
		}
	}
}

// Call sends a tool_call to the extension and waits for its tool_result.
func (h *Hub) Call(ctx context.Context, action string, args json.RawMessage, session string) (json.RawMessage, error) {
	h.mu.Lock()
	if !h.connected || h.conn == nil {
		h.mu.Unlock()
		return nil, ErrNoExtension
	}
	if !h.compatible {
		ep := h.extProtocol
		h.mu.Unlock()
		if ep < config.ProtocolVersion {
			return nil, fmt.Errorf("protocol mismatch: extension protocol %d, daemon protocol %d — update the browser extension", ep, config.ProtocolVersion)
		}
		return nil, fmt.Errorf("protocol mismatch: extension protocol %d, daemon protocol %d — update the daemon (open-webbridge update)", ep, config.ProtocolVersion)
	}
	h.seq++
	id := fmt.Sprintf("r%d", h.seq)
	ch := make(chan protocol.Envelope, 1)
	h.pending[id] = ch
	conn := h.conn
	h.mu.Unlock()

	env := protocol.Envelope{Type: "tool_call", ID: id, Action: action, Args: args, Session: session}
	if err := writeJSON(conn, env); err != nil {
		h.dropPending(id)
		return nil, err
	}

	select {
	case <-ctx.Done():
		h.dropPending(id)
		return nil, ctx.Err()
	case resp := <-ch:
		if resp.OK != nil && !*resp.OK {
			return nil, errors.New(resp.Error)
		}
		if resp.Error != "" {
			return nil, errors.New(resp.Error)
		}
		return resp.Data, nil
	}
}

func (h *Hub) dropPending(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}

func writeJSON(conn *wsserver.Conn, env protocol.Envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return conn.WriteMessage(string(b))
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
