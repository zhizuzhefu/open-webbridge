package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

func TestNoRuleNoWait(t *testing.T) {
	l := New(nil)
	wait, err := l.Wait(context.Background(), "https://example.com/x")
	if err != nil || wait != 0 {
		t.Fatalf("want no wait, got wait=%v err=%v", wait, err)
	}
}

func TestSuffixMatchAndSpacing(t *testing.T) {
	// max 1 per 2s on the registered domain should also cover the www host.
	l := New([]config.RateLimit{{Domain: "xiaohongshu.com", Max: 1, Window: 2}})
	ctx := context.Background()

	// First call is immediate.
	if wait, err := l.Wait(ctx, "https://www.xiaohongshu.com/explore"); err != nil || wait != 0 {
		t.Fatalf("first call: wait=%v err=%v", wait, err)
	}
	// Second call (same domain, different host) must be scheduled ~2s later.
	wait, err := l.Wait(ctx, "https://xiaohongshu.com/search")
	if err != nil {
		t.Fatalf("second call err: %v", err)
	}
	if wait < 1900*time.Millisecond || wait > 2100*time.Millisecond {
		t.Fatalf("second call should wait ~2s, got %v", wait)
	}
}

func TestBurstThenSpace(t *testing.T) {
	// max 2 per 1s: two immediate, the third spaced by a window from the first.
	l := New([]config.RateLimit{{Domain: "douyin.com", Max: 2, Window: 1}})
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if wait, err := l.Wait(ctx, "https://www.douyin.com/search/x"); err != nil || wait != 0 {
			t.Fatalf("burst call %d: wait=%v err=%v", i, wait, err)
		}
	}
	wait, err := l.Wait(ctx, "https://www.douyin.com/search/y")
	if err != nil {
		t.Fatalf("third call err: %v", err)
	}
	if wait < 900*time.Millisecond || wait > 1100*time.Millisecond {
		t.Fatalf("third call should wait ~1s, got %v", wait)
	}
}

func TestWouldExceedDeadline(t *testing.T) {
	l := New([]config.RateLimit{{Domain: "slow.com", Max: 1, Window: 60}})

	// Consume the only slot.
	if _, err := l.Wait(context.Background(), "https://slow.com/a"); err != nil {
		t.Fatalf("first call err: %v", err)
	}
	// A 1s deadline cannot accommodate the ~60s wait → reject, no slot consumed.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	wait, err := l.Wait(ctx, "https://slow.com/b")
	if err != ErrWouldExceed {
		t.Fatalf("want ErrWouldExceed, got %v (wait=%v)", err, wait)
	}
	if wait < 59*time.Second {
		t.Fatalf("reported wait should be ~60s, got %v", wait)
	}
}

func TestMostSpecificRuleWins(t *testing.T) {
	l := New([]config.RateLimit{
		{Domain: "example.com", Max: 1, Window: 100},
		{Domain: "api.example.com", Max: 5, Window: 1},
	})
	if r := l.match("api.example.com"); r == nil || r.Domain != "api.example.com" {
		t.Fatalf("want api.example.com rule, got %+v", r)
	}
	if r := l.match("www.example.com"); r == nil || r.Domain != "example.com" {
		t.Fatalf("want example.com rule, got %+v", r)
	}
}
