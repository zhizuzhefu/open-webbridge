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

// Limiter throttles navigations according to a (hot-swappable) set of rules.
// It is safe for concurrent use. Rules can be updated at runtime via SetRules
// (enabling `ratelimit set` without a daemon restart). Grant history is preserved
// across rule updates.
type Limiter struct {
	rules []config.RateLimit

	mu     sync.Mutex
	grants map[string][]time.Time // domain key -> granted (possibly future) execution times
}

// Reservation is a granted rate-limit slot that can still be rolled back if the
// downstream navigation fails before it reaches the browser.
type Reservation struct {
	limiter *Limiter
	key     string
	grantAt time.Time

	mu   sync.Mutex
	done bool
}

// New builds a Limiter from the configured rules.
func New(rules []config.RateLimit) *Limiter {
	copied := make([]config.RateLimit, len(rules))
	copy(copied, rules)
	return &Limiter{rules: copied, grants: make(map[string][]time.Time)}
}

// Wait blocks until a navigation to rawURL is permitted under its domain's rule,
// then returns the delay it waited. If rawURL has no host or no rule applies, it
// returns immediately with a zero delay. If the required delay would pass ctx's
// deadline, it consumes no slot and returns (delay, ErrWouldExceed). If ctx is
// cancelled while waiting, it returns ctx.Err().
func (l *Limiter) Wait(ctx context.Context, rawURL string) (time.Duration, error) {
	res, wait, err := l.Reserve(ctx, rawURL)
	if err != nil {
		return wait, err
	}
	res.Commit()
	return wait, nil
}

// Reserve blocks until a navigation to rawURL is permitted, then returns a
// reservation that must be committed after the browser accepts the navigation or
// rolled back if the downstream operation fails.
func (l *Limiter) Reserve(ctx context.Context, rawURL string) (*Reservation, time.Duration, error) {
	host := hostOf(rawURL)
	if host == "" {
		return nil, 0, nil
	}
	now := time.Now()
	l.mu.Lock()
	rule := l.matchLocked(host)
	if rule == nil || rule.Max <= 0 || rule.Window <= 0 {
		l.mu.Unlock()
		return nil, 0, nil
	}
	window := time.Duration(rule.Window) * time.Second
	key := strings.ToLower(strings.TrimSpace(rule.Domain))

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
		return nil, wait, ErrWouldExceed
	}
	g = append(g, grantAt)
	l.grants[key] = g
	l.mu.Unlock()

	res := &Reservation{limiter: l, key: key, grantAt: grantAt}

	if wait <= 0 {
		return res, 0, nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		l.removeGrant(key, grantAt)
		return nil, wait, ctx.Err()
	case <-timer.C:
		return res, wait, nil
	}
}

// Commit makes a reservation permanent. A nil reservation is a no-op so callers
// can defer cleanup without special-casing unthrottled URLs.
func (r *Reservation) Commit() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.done = true
	r.mu.Unlock()
}

// Rollback releases a reserved slot when the downstream navigation did not
// happen. It is safe to call multiple times.
func (r *Reservation) Rollback() {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.done {
		r.mu.Unlock()
		return
	}
	r.done = true
	r.mu.Unlock()
	r.limiter.removeGrant(r.key, r.grantAt)
}

// match returns the most specific rule whose domain matches host, or nil.
func (l *Limiter) match(host string) *config.RateLimit {
	l.mu.Lock()
	defer l.mu.Unlock()
	rule := l.matchLocked(host)
	if rule == nil {
		return nil
	}
	copied := *rule
	return &copied
}

func (l *Limiter) matchLocked(host string) *config.RateLimit {
	var best *config.RateLimit
	bestLen := -1
	for i := range l.rules {
		d := strings.ToLower(strings.TrimSpace(l.rules[i].Domain))
		if d == "" {
			continue
		}
		if host == d || strings.HasSuffix(host, "."+d) {
			if len(d) > bestLen {
				best = &l.rules[i]
				bestLen = len(d)
			}
		}
	}
	return best
}

func (l *Limiter) removeGrant(key string, grantAt time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	grants := l.grants[key]
	for i := len(grants) - 1; i >= 0; i-- {
		if grants[i].Equal(grantAt) {
			l.grants[key] = append(grants[:i], grants[i+1:]...)
			if len(l.grants[key]) == 0 {
				delete(l.grants, key)
			}
			return
		}
	}
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

// SetRules replaces the active rules without clearing existing grant history.
// This enables hot updates of rate limits (no daemon restart required).
func (l *Limiter) SetRules(rules []config.RateLimit) {
	l.mu.Lock()
	l.rules = make([]config.RateLimit, len(rules))
	copy(l.rules, rules)
	l.mu.Unlock()
}

// RateLimitStatus reports live usage for one configured rule.
type RateLimitStatus struct {
	Domain string `json:"domain"`
	Max    int    `json:"max"`
	Window int    `json:"window_seconds"`
	// InUse is the number of recent navigations still counting against the limit.
	InUse int `json:"in_use"`
	// WaitSeconds is how long until the next navigation to this domain would be
	// allowed (0 if a slot is available right now). This is a point-in-time value.
	WaitSeconds float64 `json:"wait_seconds"`
}

// Status returns runtime information for all configured rules (best effort).
// It does not mutate grant state for the purpose of reporting.
func (l *Limiter) Status() []RateLimitStatus {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	out := make([]RateLimitStatus, 0, len(l.rules))
	for i := range l.rules {
		rule := &l.rules[i]
		if rule.Max <= 0 || rule.Window <= 0 || rule.Domain == "" {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(rule.Domain))
		window := time.Duration(rule.Window) * time.Second

		// Compute active grants for this key (same logic as Wait but read-only).
		var active []time.Time
		if ts, ok := l.grants[key]; ok {
			for _, t := range ts {
				if t.Add(window).After(now) {
					active = append(active, t)
				}
			}
		}

		inUse := len(active)
		var waitSec float64
		if inUse >= rule.Max && inUse > 0 {
			// The grant that will free the next slot is the one Max positions from the end.
			idx := len(active) - rule.Max
			if idx < 0 {
				idx = 0
			}
			next := active[idx].Add(window)
			if next.After(now) {
				waitSec = next.Sub(now).Seconds()
			}
		}

		out = append(out, RateLimitStatus{
			Domain:      rule.Domain,
			Max:         rule.Max,
			Window:      rule.Window,
			InUse:       inUse,
			WaitSeconds: waitSec,
		})
	}
	return out
}
