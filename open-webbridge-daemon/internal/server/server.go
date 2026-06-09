// Package server wires the HTTP surface (/command, /status, /ws, /healthz) to
// the hub. It binds loopback only and gates the sensitive routes behind the
// shared token from config.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/files"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/hub"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/protocol"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/ratelimit"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/wsserver"
)

// commandTimeout bounds how long a single tool call may take. The CLI client
// (process.Call) uses a strictly larger HTTP timeout so this server-side bound
// fires first and returns a clean JSON error instead of a client-side abort.
// It also caps how long a rate-limited navigation may block before being rejected.
const commandTimeout = 5 * time.Minute

type Server struct {
	cfg     *config.Config
	hub     *hub.Hub
	limiter *ratelimit.Limiter
	started time.Time

	// lastRateMtime is used to detect config.json changes for hot-reloading
	// rate limit rules (and future per-domain tab caps) without a full restart.
	liveMu        sync.RWMutex
	lastRateMtime time.Time
}

func New(cfg *config.Config, h *hub.Hub) *Server {
	s := &Server{cfg: cfg, hub: h, limiter: ratelimit.New(cfg.RateLimits), started: time.Now()}
	s.lastRateMtime = s.configMtime()
	return s
}

// configMtime returns the current mtime of config.json (best effort).
func (s *Server) configMtime() time.Time {
	fi, err := os.Stat(config.ConfigPath())
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

// refreshRateLimitsIfChanged reloads rate limit rules from disk if config.json
// has been modified since we last saw it. This makes `ratelimit set/clear` take
// effect immediately on the next navigate (no daemon restart). Grant history
// inside the Limiter is preserved.
func (s *Server) refreshRateLimitsIfChanged() {
	mt := s.configMtime()
	s.liveMu.RLock()
	last := s.lastRateMtime
	s.liveMu.RUnlock()
	if mt.IsZero() || !mt.After(last) {
		return
	}
	// Re-load just the relevant live sections (best effort; keep old on error).
	b, err := os.ReadFile(config.ConfigPath())
	if err != nil {
		return
	}
	var fresh struct {
		RateLimits      []config.RateLimit      `json:"rate_limits"`
		DomainTabLimits []config.DomainTabLimit `json:"domain_tab_limits"`
	}
	if json.Unmarshal(b, &fresh) != nil {
		return
	}
	rateLimits := cloneRateLimits(fresh.RateLimits)
	tabLimits := cloneDomainTabLimits(fresh.DomainTabLimits)

	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if !mt.After(s.lastRateMtime) {
		return
	}
	s.limiter.SetRules(fresh.RateLimits)
	// Update in-memory cfg so status and subsequent tool_calls (which send
	// DomainTabLimits in the envelope) see the new values immediately.
	s.cfg.RateLimits = rateLimits
	s.cfg.DomainTabLimits = tabLimits
	s.lastRateMtime = mt
	log.Printf("[server] rate limits + domain tab limits hot-reloaded from config (new mtime %s)", mt.Format(time.RFC3339))
}

func (s *Server) liveLimitSnapshot() ([]config.RateLimit, []config.DomainTabLimit) {
	s.liveMu.RLock()
	defer s.liveMu.RUnlock()
	return cloneRateLimits(s.cfg.RateLimits), cloneDomainTabLimits(s.cfg.DomainTabLimits)
}

func cloneRateLimits(in []config.RateLimit) []config.RateLimit {
	if len(in) == 0 {
		return nil
	}
	out := make([]config.RateLimit, len(in))
	copy(out, in)
	return out
}

func cloneDomainTabLimits(in []config.DomainTabLimit) []config.DomainTabLimit {
	if len(in) == 0 {
		return nil
	}
	out := make([]config.DomainTabLimit, len(in))
	copy(out, in)
	return out
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
	if !s.authOK(r) {
		writeJSON(w, http.StatusUnauthorized, protocol.CommandResponse{OK: false, Error: "invalid or missing token"})
		return
	}
	s.refreshRateLimitsIfChanged()
	rateLimits, domainTabLimits := s.liveLimitSnapshot()
	st := protocol.Status{
		Running:             true,
		Host:                s.cfg.Host,
		Port:                s.cfg.Port,
		Remote:              s.cfg.IsRemote(),
		Version:             config.Version,
		ExtensionConnected:  s.hub.Connected(),
		ExtensionVersion:    s.hub.ExtensionVersion(),
		ExtensionCompatible: s.hub.Compatible(),
		UptimeSeconds:       int64(time.Since(s.started).Seconds()),
		RateLimits:          rateLimits,
		RateLimitStatus:     rateLimitStatusDTOs(s.limiter.Status()),
		DomainTabLimits:     domainTabLimits,
	}
	writeJSON(w, http.StatusOK, st)
}

func rateLimitStatusDTOs(in []ratelimit.RateLimitStatus) []protocol.RateLimitStatus {
	if len(in) == 0 {
		return nil
	}
	out := make([]protocol.RateLimitStatus, 0, len(in))
	for _, s := range in {
		out = append(out, protocol.RateLimitStatus{
			Domain:      s.Domain,
			Max:         s.Max,
			Window:      s.Window,
			InUse:       s.InUse,
			WaitSeconds: s.WaitSeconds,
		})
	}
	return out
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
	s.refreshRateLimitsIfChanged()

	ctx, cancel := context.WithTimeout(r.Context(), commandTimeout)
	defer cancel()

	// Per-domain throttling applies to navigations only — that is the choke
	// point where a fresh operation (search/open) hits a site. The limiter
	// blocks until a slot frees, or rejects if the wait would outlast the
	// request deadline.
	var rateReservation *ratelimit.Reservation
	if req.Action == "navigate" {
		res, wait, err := s.limiter.Reserve(ctx, navURL(req.Args))
		if err != nil {
			if errors.Is(err, ratelimit.ErrWouldExceed) {
				writeJSON(w, http.StatusOK, protocol.CommandResponse{OK: false,
					Error: fmt.Sprintf("rate limited for this domain; retry in %.1fs", wait.Seconds())})
				return
			}
			writeJSON(w, http.StatusOK, protocol.CommandResponse{OK: false, Error: err.Error()})
			return
		} else if wait > 0 {
			log.Printf("[ratelimit] navigate throttled %.1fs", wait.Seconds())
		}
		rateReservation = res
	}

	_, domainTabLimits := s.liveLimitSnapshot()
	data, err := s.hub.Call(ctx, req.Action, req.Args, req.Session, domainTabLimits)
	if err != nil {
		rateReservation.Rollback()
		writeJSON(w, http.StatusOK, protocol.CommandResponse{OK: false, Error: err.Error()})
		return
	}
	rateReservation.Commit()
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

// navURL pulls the "url" field out of a navigate call's args, or "" if absent.
func navURL(args json.RawMessage) string {
	var a struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(args, &a)
	return a.URL
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
