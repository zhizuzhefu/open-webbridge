// Package process implements the daemon lifecycle commands (start/stop/
// restart/status/logs) and the thin HTTP client the `call` subcommand uses.
//
// `start` re-execs the binary with a hidden `__serve` argument, detached into
// its own session with stdout/stderr redirected to the log file. The child is
// the actual long-lived daemon.
package process

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

// IsRunning returns the pid if a live daemon is recorded in the pidfile.
func IsRunning() (int, bool) {
	b, err := os.ReadFile(config.PidPath())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	if proc, err := os.FindProcess(pid); err == nil {
		if err := proc.Signal(syscall.Signal(0)); err == nil {
			return pid, true
		}
	}
	return 0, false
}

// Start launches the detached daemon if not already running.
func Start(cfg *config.Config) error {
	if pid, ok := IsRunning(); ok {
		fmt.Printf("already running (pid %d)\n", pid)
		printConnectionInfo(cfg)
		return nil
	}
	if err := config.EnsureDirs(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(config.LogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "__serve")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach into new session
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	if err := os.WriteFile(config.PidPath(), []byte(strconv.Itoa(pid)), 0o644); err != nil {
		return err
	}
	// Let the child outlive this process.
	_ = cmd.Process.Release()

	// Wait for the HTTP server to answer before reporting success.
	if err := waitHealthy(cfg, 5*time.Second); err != nil {
		return fmt.Errorf("daemon started but did not become healthy: %w", err)
	}
	fmt.Printf("started (pid %d)\n", pid)
	printConnectionInfo(cfg)
	return nil
}

// Stop terminates the running daemon.
func Stop() error {
	pid, ok := IsRunning()
	if !ok {
		fmt.Println("not running")
		_ = os.Remove(config.PidPath())
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	// Give it a moment, then force kill.
	for i := 0; i < 20; i++ {
		if _, ok := IsRunning(); !ok {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, ok := IsRunning(); ok {
		_ = proc.Signal(syscall.SIGKILL)
	}
	_ = os.Remove(config.PidPath())
	fmt.Println("stopped")
	return nil
}

// PrintStatus queries the live daemon's /status, falling back to pidfile info.
func PrintStatus(cfg *config.Config) error {
	body, err := getStatus(cfg)
	if err != nil {
		if _, ok := IsRunning(); ok {
			fmt.Println(`{"running":true,"extension_connected":false,"note":"daemon up but /status unreachable"}`)
			return nil
		}
		fmt.Println(`{"running":false}`)
		return nil
	}
	fmt.Println(strings.TrimSpace(string(body)))
	return nil
}

// Logs prints the tail of the daemon log.
func Logs(lines int, follow bool) error {
	path := config.LogPath()
	if follow {
		c := exec.Command("tail", "-n", strconv.Itoa(lines), "-f", path)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		return c.Run()
	}
	c := exec.Command("tail", "-n", strconv.Itoa(lines), path)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// Target identifies which daemon `call` talks to. For local use it is the
// loopback URL + local token; for remote use it points at another machine.
type Target struct {
	BaseURL string
	Token   string
}

// Call performs POST /command with the auth token and prints the JSON result.
func Call(t Target, action, session string, args json.RawMessage) error {
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	reqBody, _ := json.Marshal(map[string]any{
		"action":  action,
		"args":    args,
		"session": session,
	})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(t.BaseURL, "/")+"/command", bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if t.Token != "" {
		req.Header.Set("X-OWB-Token", t.Token)
	}
	// Kept strictly larger than the daemon's commandTimeout (5m) so the server's
	// own timeout fires first and returns a clean JSON error rather than the
	// client aborting the connection.
	client := &http.Client{Timeout: 6 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("daemon not reachable at %s (is it running? `open-webbridge start`): %w", t.BaseURL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Println(strings.TrimSpace(string(body)))
	// Exit non-zero when the command failed so scripts can detect it.
	var parsed struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(body, &parsed) == nil && !parsed.OK {
		return errSilent
	}
	return nil
}

// errSilent signals a failed command without printing a duplicate message.
var errSilent = errors.New("")

// IsSilent reports whether err is the sentinel used to set a non-zero exit
// code without extra output.
func IsSilent(err error) bool { return errors.Is(err, errSilent) }

func waitHealthy(cfg *config.Config, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := getStatus(cfg); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("timeout")
}

func getStatus(cfg *config.Config) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.LocalBaseURL()+"/status", nil)
	if cfg.Token != "" {
		req.Header.Set("X-OWB-Token", cfg.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func printConnectionInfo(cfg *config.Config) {
	mode := "local-only (127.0.0.1)"
	if cfg.IsRemote() {
		mode = "/command exposed on " + cfg.Host + " (remote callers); /ws stays loopback-only"
	}
	fmt.Printf("  bind:      %s\n", mode)
	fmt.Printf("  command:   %s/command\n", cfg.LocalBaseURL())
	fmt.Printf("  extension: paste this into the Open WebBridge popup (always loopback) →\n             %s\n", cfg.WSURL())
	if cfg.IsRemote() {
		fmt.Printf("  remote:    drive from another machine with:\n")
		fmt.Printf("             open-webbridge call <action> --daemon http://<this-host>:%d --token %s\n", cfg.Port, cfg.Token)
		fmt.Printf("  ⚠ token auth only and traffic is unencrypted — trusted networks or SSH tunnel only.\n")
	}
}
