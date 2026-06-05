// Package ratelimit implements generic, per-domain throttling of browser
// navigations. State lives in the long-running daemon process (each
// `open-webbridge call` is a separate short-lived process and could not hold it
// otherwise).
//
// Each rule caps a domain to at most Max navigations per sliding Window. When a
// `navigate` would exceed its domain's rule, Wait BLOCKS until the next slot
// frees, honoring the caller's context deadline. If the wait would outlast that
// deadline, Wait returns ErrWouldExceed together with the computed delay so the
// caller can report a retry-after instead of hanging the request.
//
// The mechanism is deliberately site-agnostic: it keys purely off the URL host
// and the user-configured rules. Nothing here is specific to any website.
package ratelimit

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

// ErrWouldExceed is returned when the throttling delay would pass the caller's
// context deadline; the navigation is not performed and no slot is consumed.
var ErrWouldExceed = errors.New("rate limit wait would exceed the request deadline")

// Limiter throttles navigations according to a fixed set of rules. It is safe
// for concurrent use. Rules are captured at construction; the daemon restarts to
// pick up config changes (mirroring how `bind` applies), so the rule set is
// immutable for a Limiter's lifetime.
type Limiter struct {
	rules []config.RateLimit

	mu     sync.Mutex
	grants map[string][]time.Time // domain key -> granted (possibly future) execution times
}

// New builds a Limiter from the configured rules.
func New(rules []config.RateLimit) *Limiter {
	return &Limiter{rules: rules, grants: make(map[string][]time.Time)}
}

// Wait blocks until a navigation to rawURL is permitted under its domain's rule,
// then returns the delay it waited. If rawURL has no host or no rule applies, it
// returns immediately with a zero delay. If the required delay would pass ctx's
// deadline, it consumes no slot and returns (delay, ErrWouldExceed). If ctx is
// cancelled while waiting, it returns ctx.Err().
func (l *Limiter) Wait(ctx context.Context, rawURL string) (time.Duration, error) {
	host := hostOf(rawURL)
	if host == "" {
		return 0, nil
	}
	rule := l.match(host)
	if rule == nil || rule.Max <= 0 || rule.Window <= 0 {
		return 0, nil
	}
	window := time.Duration(rule.Window) * time.Second
	key := strings.ToLower(rule.Domain)

	now := time.Now()
	l.mu.Lock()
	// Drop grants old enough that they can no longer constrain a new one.
	g := l.grants[key][:0]
	for _, t := range l.grants[key] {
		if t.Add(window).After(now) {
			g = append(g, t)
		}
	}
	// Grants are monotonically non-decreasing, so the rule is satisfied by
	// scheduling this navigation no earlier than the Max-ago grant plus a window.
	grantAt := now
	if len(g) >= rule.Max {
		if c := g[len(g)-rule.Max].Add(window); c.After(grantAt) {
			grantAt = c
		}
	}
	wait := grantAt.Sub(now)

	if dl, ok := ctx.Deadline(); ok && grantAt.After(dl) {
		l.grants[key] = g // keep the prune, but do not consume a slot
		l.mu.Unlock()
		return wait, ErrWouldExceed
	}
	g = append(g, grantAt)
	l.grants[key] = g
	l.mu.Unlock()

	if wait <= 0 {
		return 0, nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return wait, ctx.Err()
	case <-timer.C:
		return wait, nil
	}
}

// match returns the most specific rule whose domain matches host, or nil.
func (l *Limiter) match(host string) *config.RateLimit {
	var best *config.RateLimit
	for i := range l.rules {
		d := strings.ToLower(strings.TrimSpace(l.rules[i].Domain))
		if d == "" {
			continue
		}
		if host == d || strings.HasSuffix(host, "."+d) {
			if best == nil || len(d) > len(best.Domain) {
				best = &l.rules[i]
			}
		}
	}
	return best
}

// hostOf extracts the lowercased hostname (no port) from a URL, or "" if it has
// none (e.g. an about: page or a malformed string).
func hostOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}
