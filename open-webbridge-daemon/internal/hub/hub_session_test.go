package hub

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/wsserver"
)

// Same session must be mutually exclusive: at no point may two holders be in
// the critical section at once. Run with -race to also catch data races.
func TestAcquireSession_SameKeySerializes(t *testing.T) {
	h := New("test")
	const key = "s1"
	const workers = 16

	var inFlight int32
	var maxObserved int32
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.acquireSession(context.Background(), key); err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			n := atomic.AddInt32(&inFlight, 1)
			for {
				m := atomic.LoadInt32(&maxObserved)
				if n <= m || atomic.CompareAndSwapInt32(&maxObserved, m, n) {
					break
				}
			}
			time.Sleep(time.Millisecond) // widen the window for overlap to show
			atomic.AddInt32(&inFlight, -1)
			h.releaseSession(key)
		}()
	}
	wg.Wait()

	if maxObserved != 1 {
		t.Fatalf("same-session calls overlapped: max concurrent = %d, want 1", maxObserved)
	}
}

// Different sessions must not block each other: N sessions held simultaneously
// should all be in flight at the same time.
func TestAcquireSession_DistinctKeysConcurrent(t *testing.T) {
	h := New("test")
	const n = 8

	var holding int32
	release := make(chan struct{})
	var wg sync.WaitGroup

	for i := 0; i < n; i++ {
		key := "sess-" + string(rune('a'+i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.acquireSession(context.Background(), key); err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			atomic.AddInt32(&holding, 1)
			<-release // hold until everyone has acquired
			h.releaseSession(key)
		}()
	}

	// Wait until all distinct sessions are held concurrently.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&holding) < n {
		if time.Now().After(deadline) {
			close(release)
			t.Fatalf("distinct sessions did not run concurrently: holding = %d, want %d", atomic.LoadInt32(&holding), n)
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
}

// A queued waiter whose context is cancelled must give up rather than block on
// a slow predecessor forever.
func TestAcquireSession_ContextCancelWhileQueued(t *testing.T) {
	h := New("test")
	const key = "s1"

	if err := h.acquireSession(context.Background(), key); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer h.releaseSession(key)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := h.acquireSession(ctx, key) // slot is taken; must wait then time out
	if err == nil {
		t.Fatal("expected context error while queued, got nil")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("waiter did not honor ctx promptly: waited %v", time.Since(start))
	}
}

// A long-polling `annotations` call must not hold the session lock, otherwise
// waiting for a human's next note would block every page action on that session.
func TestCall_SessionIndependentActionDoesNotHoldLock(t *testing.T) {
	h := New("test")
	h.reconnectWait = 50 * time.Millisecond

	if err := h.acquireSession(context.Background(), "s1"); err != nil {
		t.Fatalf("pre-acquire: %v", err)
	}
	defer h.releaseSession("s1")

	// The session slot is taken. A session-bound action would queue behind it and
	// hit the context deadline; annotations must reach the extension check and
	// fail with ErrNoExtension instead.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := h.Call(ctx, "annotations", nil, "s1", nil); err != ErrNoExtension {
		t.Fatalf("annotations: got %v, want ErrNoExtension (it must skip the session lock)", err)
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	if _, err := h.Call(ctx2, "snapshot", nil, "s1", nil); err != context.DeadlineExceeded {
		t.Fatalf("snapshot: got %v, want DeadlineExceeded (session-bound calls still serialize)", err)
	}
}

func TestWaitForExtension_WaitsForReconnect(t *testing.T) {
	h := New("test")
	h.reconnectWait = time.Second

	errc := make(chan error, 1)
	go func() {
		errc <- h.waitForExtension(context.Background())
	}()

	time.Sleep(20 * time.Millisecond)
	h.mu.Lock()
	h.conn = &wsserver.Conn{}
	h.connected = true
	h.notifyStateChangedLocked()
	h.mu.Unlock()

	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("waitForExtension returned error after reconnect: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waitForExtension did not unblock after reconnect")
	}
}

func TestWaitForExtension_Timeout(t *testing.T) {
	h := New("test")
	h.reconnectWait = 20 * time.Millisecond

	start := time.Now()
	err := h.waitForExtension(context.Background())
	if err != ErrNoExtension {
		t.Fatalf("got %v, want ErrNoExtension", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("waitForExtension did not honor reconnect timeout promptly: waited %v", time.Since(start))
	}
}

// Call must acquire and release the session lock even when no extension is
// attached, so a failed call never strands the session.
func TestCall_NoExtensionReleasesSession(t *testing.T) {
	h := New("test")
	h.reconnectWait = time.Millisecond
	for i := 0; i < 3; i++ {
		_, err := h.Call(context.Background(), "noop", nil, "s1", nil)
		if err != ErrNoExtension {
			t.Fatalf("call %d: got %v, want ErrNoExtension", i, err)
		}
	}
	// If the lock were stranded, this acquire would block forever.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := h.acquireSession(ctx, "s1"); err != nil {
		t.Fatalf("session lock was stranded after failed calls: %v", err)
	}
	h.releaseSession("s1")
}
