// Package config owns the on-disk layout and runtime configuration for the
// Open WebBridge daemon. Everything lives under ~/.open-webbridge/.
//
// There is NO telemetry configuration here and no analytics endpoint anywhere
// in the binary — the daemon never phones home.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Version is the daemon version. It is a var (not a const) so the release build
// can stamp it from the git tag via -ldflags "-X …/config.Version=<tag>". The
// default below is the fallback for plain `go build` / source installs.
var Version = "1.3.1"

// ProtocolVersion is the wire-protocol contract between the daemon and the
// extension. The two are compatible iff their ProtocolVersion matches — their
// individual release versions are independent and do NOT need to match.
//
// Bump this (on BOTH sides) ONLY when the daemon↔extension message format
// changes incompatibly. Ordinary daemon or extension releases keep it the same,
// so a daemon patch never forces an extension re-release (or vice versa).
const ProtocolVersion = 1

// Repo is the GitHub slug used for self-update and release downloads.
const Repo = "zhizuzhefu/open-webbridge"

// CompareVersions returns -1, 0, or 1 for a<b, a==b, a>b using a simple numeric
// dot comparison (e.g. "0.2.0" > "0.1.9"). A leading "v" is ignored. Non-numeric
// segments compare as 0.
func CompareVersions(a, b string) int {
	pa := splitVer(a)
	pb := splitVer(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}

func splitVer(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n := 0
		for _, r := range p {
			if r < '0' || r > '9' {
				break
			}
			n = n*10 + int(r-'0')
		}
		out[i] = n
	}
	return out
}

// DefaultPort is the loopback port the daemon listens on.
const DefaultPort = 9234

// DefaultHost is the bind address for the HTTP /command surface. Loopback by
// default. Setting it to 0.0.0.0 exposes ONLY /command (and /status) to remote
// callers — the AI/user driving the daemon from another machine. The /ws
// endpoint the browser extension uses is ALWAYS restricted to loopback, because
// the extension and daemon are always co-located on the same machine.
const DefaultHost = "127.0.0.1"

// Config is persisted as ~/.open-webbridge/config.json.
type Config struct {
	// Host is the bind address for the HTTP server. "127.0.0.1" (default) is
	// local-only. "0.0.0.0" / "::" lets a remote user reach /command, e.g. to
	// drive a Chrome that runs on this (remote) machine. The browser↔daemon
	// /ws link is independent of this and always loopback-only.
	Host string `json:"host"`
	// Port is the TCP port for the HTTP + WebSocket server.
	Port int `json:"port"`
	// Token gates /command and /ws. With a non-loopback bind this is the only
	// thing protecting /command, so it is always set. Empty disables auth
	// (acceptable for a strictly loopback bind only).
	Token string `json:"token"`
	// AutoUpdate, when true, lets the daemon download and apply newer GitHub
	// releases automatically on its daily check. NEW installs default this to
	// true (set in Load on first run). When false the daemon only logs that an
	// update is available and waits for `open-webbridge update`. Existing
	// configs are left exactly as written — flipping the default does not
	// re-enable users who have it off.
	AutoUpdate bool `json:"auto_update"`
	// RateLimits throttles navigations per domain. Each rule caps a domain to at
	// most Max navigations per Window seconds; the daemon blocks a `navigate`
	// call until a slot frees. Empty (default) means no throttling. This is a
	// generic, site-agnostic mechanism — keys are plain domains, never anything
	// hardcoded about a specific site.
	RateLimits []RateLimit `json:"rate_limits,omitempty"`
}

// RateLimit caps navigations to one domain. Domain is matched against the
// navigated URL's host: an exact host match, or a suffix match on a label
// boundary (so "xiaohongshu.com" also covers "www.xiaohongshu.com"). The most
// specific (longest) matching rule wins.
type RateLimit struct {
	Domain string `json:"domain"`
	// Max is the maximum number of navigations allowed within Window. <=0 or
	// Window<=0 disables the rule.
	Max int `json:"max"`
	// Window is the sliding window length in seconds.
	Window int `json:"window_seconds"`
}

// SetRateLimit adds or replaces the rule for domain (case-insensitive).
func (c *Config) SetRateLimit(domain string, max, window int) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	for i := range c.RateLimits {
		if strings.ToLower(c.RateLimits[i].Domain) == domain {
			c.RateLimits[i] = RateLimit{Domain: domain, Max: max, Window: window}
			return
		}
	}
	c.RateLimits = append(c.RateLimits, RateLimit{Domain: domain, Max: max, Window: window})
}

// ClearRateLimit removes the rule for domain, reporting whether one existed.
func (c *Config) ClearRateLimit(domain string) bool {
	domain = strings.ToLower(strings.TrimSpace(domain))
	out := c.RateLimits[:0]
	found := false
	for _, r := range c.RateLimits {
		if strings.ToLower(r.Domain) == domain {
			found = true
			continue
		}
		out = append(out, r)
	}
	c.RateLimits = out
	return found
}

// BinInstallPath is the canonical install location of the daemon binary.
func BinInstallPath() string { return filepath.Join(BaseDir(), "bin", "open-webbridge") }

// ExtensionDir is where the one-click installer unpacks the extension.
func ExtensionDir() string { return filepath.Join(BaseDir(), "extension") }

// BaseDir is ~/.open-webbridge.
func BaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".open-webbridge")
}

func ConfigPath() string { return filepath.Join(BaseDir(), "config.json") }
func PidPath() string    { return filepath.Join(BaseDir(), "daemon.pid") }
func LogDir() string     { return filepath.Join(BaseDir(), "logs") }
func LogPath() string    { return filepath.Join(LogDir(), "daemon.log") }
func FilesDir() string   { return filepath.Join(BaseDir(), "files") }

// EnsureDirs creates the directory tree if missing.
func EnsureDirs() error {
	for _, d := range []string{BaseDir(), LogDir(), FilesDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}
	return nil
}

// Load reads config.json, creating it with a freshly generated token on first
// run. The file is written 0600 so the token is readable only by the owner.
func Load() (*Config, error) {
	if err := EnsureDirs(); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(ConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			// First run: auto-update defaults ON. This only affects fresh
			// installs; existing config.json files keep whatever they have.
			c := &Config{Host: DefaultHost, Port: DefaultPort, Token: genToken(), AutoUpdate: true}
			if err := c.Save(); err != nil {
				return nil, err
			}
			return c, nil
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", ConfigPath(), err)
	}
	dirty := false
	if c.Host == "" {
		c.Host, dirty = DefaultHost, true
	}
	if c.Port == 0 {
		c.Port, dirty = DefaultPort, true
	}
	if c.Token == "" {
		c.Token, dirty = genToken(), true
	}
	if dirty {
		_ = c.Save()
	}
	return &c, nil
}

// Save writes the config atomically-ish with restrictive permissions.
func (c *Config) Save() error {
	if err := EnsureDirs(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ConfigPath(), b, 0o600)
}

// BindAddr is what the server passes to net.Listen.
func (c *Config) BindAddr() string {
	host := c.Host
	if host == "" {
		host = DefaultHost
	}
	return net.JoinHostPort(host, strconv.Itoa(c.Port))
}

// IsRemote reports whether the daemon is bound to a non-loopback address and
// therefore reachable from other machines.
func (c *Config) IsRemote() bool {
	switch c.Host {
	case "", "127.0.0.1", "localhost", "::1":
		return false
	default:
		return true
	}
}

// LocalBaseURL is the HTTP origin the on-machine CLI (call/status) uses. It is
// always loopback-reachable regardless of the bind host: a wildcard bind still
// accepts 127.0.0.1, and a specific bind is reachable at that address.
func (c *Config) LocalBaseURL() string {
	host := "127.0.0.1"
	if c.Host != "" && c.Host != "0.0.0.0" && c.Host != "::" {
		host = c.Host
	}
	return fmt.Sprintf("http://%s", net.JoinHostPort(host, strconv.Itoa(c.Port)))
}

// WSURL returns the WebSocket URL (with token) for the extension popup. It is
// ALWAYS loopback: the extension runs on the same machine as the daemon, even
// when /command is exposed remotely. The daemon also enforces this server-side
// by rejecting non-loopback /ws connections.
func (c *Config) WSURL() string {
	base := fmt.Sprintf("ws://%s/ws", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port)))
	if c.Token == "" {
		return base
	}
	return base + "?token=" + c.Token
}

func genToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Extremely unlikely; fall back to a fixed-length non-secret marker.
		return "insecure-token-rand-failed"
	}
	return hex.EncodeToString(b)
}
