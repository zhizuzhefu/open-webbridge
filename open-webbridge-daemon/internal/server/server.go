// Package server wires the HTTP surface (/command, /status, /ws, /healthz) to
// the hub. It binds loopback only and gates the sensitive routes behind the
// shared token from config.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/files"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/hub"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/protocol"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/wsserver"
)

// commandTimeout bounds how long a single tool call may take.
const commandTimeout = 90 * time.Second

type Server struct {
	cfg     *config.Config
	hub     *hub.Hub
	started time.Time
}

func New(cfg *config.Config, h *hub.Hub) *Server {
	return &Server{cfg: cfg, hub: h, started: time.Now()}
}

// Run binds to 127.0.0.1:port and serves until the context is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/command", s.handleCommand)
	mux.HandleFunc("/ws", s.handleWS)

	addr := s.cfg.BindAddr()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	srv := &http.Server{Handler: mux}

	if s.cfg.IsRemote() {
		log.Printf("[server] WARNING: /command and /status are reachable from other machines on %s.", addr)
		log.Printf("[server] WARNING: token auth is the only protection and traffic is UNENCRYPTED — use a trusted network or an SSH tunnel.")
		log.Printf("[server] NOTE: /ws (the browser control channel) stays loopback-only regardless of bind.")
		if s.cfg.Token == "" {
			log.Printf("[server] DANGER: token is empty while exposed remotely — anyone who can reach the port can drive the browser.")
		}
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("[server] listening on %s", addr)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	st := protocol.Status{
		Running:            true,
		Host:               s.cfg.Host,
		Port:               s.cfg.Port,
		Remote:             s.cfg.IsRemote(),
		Version:            config.Version,
		ExtensionConnected:  s.hub.Connected(),
		ExtensionVersion:    s.hub.ExtensionVersion(),
		ExtensionCompatible: s.hub.Compatible(),
		UptimeSeconds:       int64(time.Since(s.started).Seconds()),
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, protocol.CommandResponse{OK: false, Error: "use POST"})
		return
	}
	if !s.authOK(r) {
		writeJSON(w, http.StatusUnauthorized, protocol.CommandResponse{OK: false, Error: "invalid or missing token"})
		return
	}
	var req protocol.CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.CommandResponse{OK: false, Error: "bad json body: " + err.Error()})
		return
	}
	if req.Action == "" {
		writeJSON(w, http.StatusBadRequest, protocol.CommandResponse{OK: false, Error: "missing action"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), commandTimeout)
	defer cancel()

	data, err := s.hub.Call(ctx, req.Action, req.Args, req.Session)
	if err != nil {
		writeJSON(w, http.StatusOK, protocol.CommandResponse{OK: false, Error: err.Error()})
		return
	}
	// Persist large blobs (screenshot/pdf) to disk and swap in a path.
	data = files.MaybePersist(req.Action, data)
	writeJSON(w, http.StatusOK, protocol.CommandResponse{OK: true, Data: data})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// The browser extension is always co-located with the daemon. Even when the
	// HTTP surface is exposed on 0.0.0.0 for remote /command callers, the /ws
	// control channel is restricted to loopback so a remote party can never
	// attach as the "extension" and drive the browser.
	if !remoteIsLoopback(r) {
		http.Error(w, "the /ws endpoint only accepts local (127.0.0.1) connections", http.StatusForbidden)
		log.Printf("[server] rejected non-loopback /ws connection from %s", r.RemoteAddr)
		return
	}
	if !s.authOK(r) {
		http.Error(w, "invalid or missing token", http.StatusUnauthorized)
		return
	}
	conn, err := wsserver.Upgrade(w, r)
	if err != nil {
		log.Printf("[server] ws upgrade failed: %v", err)
		return
	}
	s.hub.Serve(conn) // blocks until the connection closes
}

// remoteIsLoopback reports whether the request originates from 127.0.0.1/::1.
func remoteIsLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authOK accepts the token via the X-OWB-Token header or a ?token= query
// param (the extension passes it in the WebSocket URL). Empty configured
// token disables the check.
func (s *Server) authOK(r *http.Request) bool {
	if s.cfg.Token == "" {
		return true
	}
	if r.Header.Get("X-OWB-Token") == s.cfg.Token {
		return true
	}
	if r.URL.Query().Get("token") == s.cfg.Token {
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
