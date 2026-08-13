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

// staleAfter is how long without any inbound message (pongs arrive every ~4s)
// before an existing extension connection is considered dead and a newcomer is
// allowed to take over instead of being rejected.
const staleAfter = 50 * time.Second

const (
	keepaliveInterval             = 4 * time.Second
	defaultExtensionReconnectWait = 30 * time.Second
)

// Hub multiplexes tool calls over one extension connection.
type Hub struct {
	daemonVersion string

	mu            sync.Mutex
	conn          *wsserver.Conn
	extVer        string
	extProtocol   int
	connected     bool
	compatible    bool
	lastActivity  time.Time
	seq           uint64
	pending       map[string]chan protocol.Envelope
	stateChanged  chan struct{}
	reconnectWait time.Duration

	// sessLocks serializes calls that target the same session. A session maps
	// to a single browser tab, so two concurrent tool_calls would race two CDP
	// commands on the same tab. Each session gets a capacity-1 semaphore;
	// different sessions stay fully concurrent. Guarded by mu.
	sessLocks map[string]chan struct{}
}

func New(daemonVersion string) *Hub {
	return &Hub{
		daemonVersion: daemonVersion,
		pending:       make(map[string]chan protocol.Envelope),
		stateChanged:  make(chan struct{}),
		reconnectWait: defaultExtensionReconnectWait,
		sessLocks:     make(map[string]chan struct{}),
	}
}

// sessionIndependentActions never touch a tab or a CDP target, so they must not
// queue behind another call on the same session.
//
// `annotations` reads the extension's global annotation store and can be asked
// to long-poll until a human leaves the next note; serialising it would park
// every other call on that session for the whole poll. Only add an action here
// if it genuinely cannot race with page work.
var sessionIndependentActions = map[string]bool{
	"annotations": true,
}

// sessionKey normalizes the session name. Empty is treated as "default" to
// match the extension's own grouping (sessions.js: `name || "default"`), so a
// call with no session and one with session="default" serialize together
// because they drive the same tab.
func sessionKey(session string) string {
	if session == "" {
		return "default"
	}
	return session
}

// acquireSession blocks until this session's slot is free, then claims it. The
// wait honors ctx so a queued call that blows its deadline gives up instead of
// waiting on a slow predecessor forever. Call releaseSession when done.
func (h *Hub) acquireSession(ctx context.Context, key string) error {
	h.mu.Lock()
	sem := h.sessLocks[key]
	if sem == nil {
		sem = make(chan struct{}, 1)
		h.sessLocks[key] = sem
	}
	h.mu.Unlock()

	select {
	case sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Hub) releaseSession(key string) {
	h.mu.Lock()
	sem := h.sessLocks[key]
	h.mu.Unlock()
	if sem != nil {
		<-sem
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

func (h *Hub) notifyStateChangedLocked() {
	close(h.stateChanged)
	h.stateChanged = make(chan struct{})
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
	h.notifyStateChangedLocked()
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
			h.notifyStateChangedLocked()
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
	t := time.NewTicker(keepaliveInterval)
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

func (h *Hub) waitForExtension(ctx context.Context) error {
	wait := h.reconnectWait
	if wait <= 0 {
		h.mu.Lock()
		connected := h.connected && h.conn != nil
		h.mu.Unlock()
		if connected {
			return nil
		}
		return ErrNoExtension
	}

	timer := time.NewTimer(wait)
	defer timer.Stop()

	for {
		h.mu.Lock()
		if h.connected && h.conn != nil {
			h.mu.Unlock()
			return nil
		}
		changed := h.stateChanged
		h.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return ErrNoExtension
		case <-changed:
		}
	}
}

// Call sends a tool_call to the extension and waits for its tool_result.
//
// Calls for the same session are serialized: the daemon will not submit a
// second tool_call to the extension until the previous one for that session has
// returned, so two agents driving the same tab queue instead of racing on CDP.
// Distinct sessions run concurrently.
func (h *Hub) Call(ctx context.Context, action string, args json.RawMessage, session string, domainTabLimits []config.DomainTabLimit) (json.RawMessage, error) {
	if !sessionIndependentActions[action] {
		key := sessionKey(session)
		if err := h.acquireSession(ctx, key); err != nil {
			return nil, err
		}
		defer h.releaseSession(key)
	}

	if err := h.waitForExtension(ctx); err != nil {
		return nil, err
	}

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

	env := protocol.Envelope{Type: "tool_call", ID: id, Action: action, Args: args, Session: session, DomainTabLimits: domainTabLimits}
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
