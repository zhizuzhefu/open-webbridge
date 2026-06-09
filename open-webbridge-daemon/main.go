// Command open-webbridge is the local daemon + CLI for Open WebBridge, an
// open, telemetry-free bridge that lets AI agents drive your real browser.
//
// Usage:
//
//	open-webbridge start            launch the background daemon
//	open-webbridge stop             stop it
//	open-webbridge restart          stop then start
//	open-webbridge status           print JSON status
//	open-webbridge url              print the WebSocket URL for the extension
//	open-webbridge token            print the auth token
//	open-webbridge logs [-n N] [-f] tail the daemon log
//	open-webbridge call <action> [--session S] [--args '<json>'] [json]
//	                                invoke a browser tool and print the result
//	open-webbridge version          print the version
//
// There is intentionally no telemetry, analytics SDK, or remote endpoint
// anywhere in this program.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/hub"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/process"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/server"
	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/updater"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	rest := os.Args[2:]

	cfg, err := config.Load()
	if err != nil {
		fatal(err)
	}

	switch cmd {
	case "__serve": // internal: the actual long-lived daemon process
		runServe(cfg)
	case "start":
		runStart(cfg, rest)
	case "stop":
		must(process.Stop())
	case "restart":
		_ = process.Stop()
		must(process.Start(cfg))
	case "bind":
		runBind(cfg, rest)
	case "status":
		must(process.PrintStatus(cfg))
	case "url":
		fmt.Println(cfg.WSURL())
	case "token":
		fmt.Println(cfg.Token)
	case "logs":
		runLogs(rest)
	case "call":
		runCall(cfg, rest)
	case "ratelimit", "rl":
		runRateLimit(cfg, rest)
	case "tablimit", "tl":
		runTabLimit(cfg, rest)
	case "update":
		runUpdate(cfg, rest)
	case "version", "-v", "--version":
		fmt.Printf("open-webbridge %s\n", config.Version)
		fmt.Printf("Source: https://github.com/%s (AGPL-3.0)\n", config.Repo)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func runServe(cfg *config.Config) {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[main] open-webbridge daemon v%s starting (pid %d)", config.Version, os.Getpid())

	h := hub.New(config.Version)
	srv := server.New(cfg, h)

	go autoUpdateLoop(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := srv.Run(ctx); err != nil {
		log.Printf("[main] server exited: %v", err)
		os.Exit(1)
	}
	log.Printf("[main] shutdown complete")
}

// normalizeHost maps friendly aliases to bind addresses.
func normalizeHost(h string) string {
	switch h {
	case "local", "loopback":
		return "127.0.0.1"
	case "remote", "all", "any", "lan":
		return "0.0.0.0"
	default:
		return h
	}
}

func runStart(cfg *config.Config, args []string) {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	host := fs.String("host", "", "bind address for /command (127.0.0.1 | 0.0.0.0 | local | remote); persisted")
	port := fs.Int("port", 0, "TCP port; persisted")
	_ = fs.Parse(args)

	dirty := false
	if *host != "" {
		cfg.Host, dirty = normalizeHost(*host), true
	}
	if *port != 0 {
		cfg.Port, dirty = *port, true
	}
	if dirty {
		must(cfg.Save())
	}
	must(process.Start(cfg))
}

// runBind persists the bind address (and optional port), then restarts the
// daemon if running so the change takes effect immediately.
func runBind(cfg *config.Config, args []string) {
	fs := flag.NewFlagSet("bind", flag.ExitOnError)
	port := fs.Int("port", 0, "TCP port")
	_ = fs.Parse(args)

	rest := fs.Args()
	if len(rest) < 1 {
		fatal(fmt.Errorf("usage: open-webbridge bind <127.0.0.1|0.0.0.0|local|remote|HOST> [--port N]"))
	}
	cfg.Host = normalizeHost(rest[0])
	if *port != 0 {
		cfg.Port = *port
	}
	must(cfg.Save())
	fmt.Printf("bind set to %s:%d\n", cfg.Host, cfg.Port)

	if _, running := process.IsRunning(); running {
		fmt.Println("restarting daemon to apply…")
		_ = process.Stop()
		must(process.Start(cfg))
	} else {
		fmt.Println("run `open-webbridge start` to launch with the new bind.")
	}
}

func runUpdate(cfg *config.Config, args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	check := fs.Bool("check", false, "only report whether an update is available")
	force := fs.Bool("force", false, "reinstall even if already current")
	_ = fs.Parse(args)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	latest, available, err := updater.UpdateAvailable(ctx)
	if err != nil {
		fatal(fmt.Errorf("checking for updates: %w", err))
	}
	if *check {
		if available {
			fmt.Printf("update available: v%s → v%s\n", config.Version, latest)
		} else {
			fmt.Printf("up to date (v%s)\n", config.Version)
		}
		return
	}
	if !available && !*force {
		fmt.Printf("already up to date (v%s)\n", config.Version)
		return
	}
	fmt.Printf("updating to v%s …\n", latest)
	path, err := updater.InstallBinary(ctx, latest)
	if err != nil {
		fatal(fmt.Errorf("installing binary: %w", err))
	}
	fmt.Printf("installed %s\n", path)
	fmt.Println("(daemon updated; the extension updates via the Chrome Web Store, or re-run the installer + reload for a load-unpacked copy)")
	if _, running := process.IsRunning(); running {
		fmt.Println("restarting daemon …")
		_ = process.Stop()
		must(process.Start(cfg))
	}
}

// autoUpdateLoop checks GitHub for newer releases. With auto_update=true (the
// default for new installs) it downloads and re-execs the new binary in place;
// when false it only logs that an update is available.
func autoUpdateLoop(cfg *config.Config) {
	check := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		latest, available, err := updater.UpdateAvailable(ctx)
		if err != nil || !available {
			return
		}
		if !cfg.AutoUpdate {
			log.Printf("[update] v%s available (current v%s) — run `open-webbridge update`", latest, config.Version)
			return
		}
		log.Printf("[update] auto-updating v%s → v%s", config.Version, latest)
		path, err := updater.InstallBinary(ctx, latest)
		if err != nil {
			log.Printf("[update] failed: %v", err)
			return
		}
		log.Printf("[update] installed %s — re-exec", path)
		// Replace this process image with the new binary; keeps the same pid.
		if err := syscall.Exec(path, []string{path, "__serve"}, os.Environ()); err != nil {
			log.Printf("[update] re-exec failed: %v (restart manually)", err)
		}
	}
	time.Sleep(10 * time.Second)
	check()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for range t.C {
		check()
	}
}

// runRateLimit manages per-domain navigation throttles.
// Changes are persisted to config.json. Thanks to hot-reload in the daemon,
// rate limit rule changes take effect on the *next navigate* without requiring
// a daemon restart (unlike bind / host changes).
func runRateLimit(cfg *config.Config, args []string) {
	sub := "list"
	if len(args) > 0 {
		sub = args[0]
	}
	rest := args[1:]

	switch sub {
	case "list", "ls":
		printRateLimits(cfg)
	case "set", "add":
		// The domain comes first; flags follow it. Go's flag package stops at
		// the first non-flag token, so peel the domain before parsing the rest.
		if len(rest) < 1 || strings.HasPrefix(rest[0], "-") {
			fatal(fmt.Errorf("usage: open-webbridge ratelimit set <domain> --per <seconds> [--max N]"))
		}
		domain := normalizeDomain(rest[0])
		fs := flag.NewFlagSet("ratelimit set", flag.ExitOnError)
		per := fs.Int("per", 0, "window length in seconds (required)")
		max := fs.Int("max", 1, "max navigations allowed per window")
		_ = fs.Parse(rest[1:])
		if *per <= 0 {
			fatal(fmt.Errorf("--per <seconds> is required and must be > 0, e.g. --per 5"))
		}
		if *max <= 0 {
			fatal(fmt.Errorf("--max must be > 0"))
		}
		cfg.SetRateLimit(domain, *max, *per)
		must(cfg.Save())
		fmt.Printf("rate limit set: %s → at most %d navigation(s) per %ds\n", domain, *max, *per)
		fmt.Println("change will take effect on the next navigate (no daemon restart required).")
		// Hot reload: daemon will pick up the new rules from the file on next use.
		// We intentionally do NOT restart here (unlike bind).
	case "clear", "rm", "remove", "unset":
		fs := flag.NewFlagSet("ratelimit clear", flag.ExitOnError)
		all := fs.Bool("all", false, "remove every rate limit")
		_ = fs.Parse(rest)
		if *all {
			cfg.RateLimits = nil
			must(cfg.Save())
			fmt.Println("all rate limits cleared")
			fmt.Println("change will take effect on the next navigate (no daemon restart required).")
			return
		}
		if fs.NArg() < 1 {
			fatal(fmt.Errorf("usage: open-webbridge ratelimit clear <domain> | --all"))
		}
		domain := normalizeDomain(fs.Arg(0)) // clear takes only flags + one domain, so flag.Parse order is fine
		if cfg.ClearRateLimit(domain) {
			must(cfg.Save())
			fmt.Printf("rate limit cleared: %s\n", domain)
			fmt.Println("change will take effect on the next navigate (no daemon restart required).")
		} else {
			fmt.Printf("no rate limit set for %s\n", domain)
		}
	default:
		fatal(fmt.Errorf("unknown ratelimit subcommand %q (use list | set | clear)", sub))
	}
}

func printRateLimits(cfg *config.Config) {
	if len(cfg.RateLimits) == 0 {
		fmt.Println("no rate limits configured")
		return
	}
	for _, r := range cfg.RateLimits {
		fmt.Printf("  %-30s at most %d navigation(s) per %ds\n", r.Domain, r.Max, r.Window)
	}
}

// normalizeDomain accepts either a bare domain or a full URL and returns the
// lowercased host (no scheme, path, or port).
func normalizeDomain(s string) string {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "://") {
		if u, err := url.Parse(s); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname())
		}
	}
	// Strip a leading scheme-less "//", any path, and any :port.
	s = strings.TrimPrefix(s, "//")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, ':'); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(s)
}

// applyRateLimitChange is kept for compatibility / future "heavy" config, but
// rate limit (and tablimit) changes are now hot-reloaded from the config file
// by the running daemon (see server.refreshRateLimitsIfChanged). Only things
// that affect the listener (bind) still require a restart.
func applyRateLimitChange(cfg *config.Config) {
	if _, running := process.IsRunning(); running {
		fmt.Println("restarting daemon to apply…")
		_ = process.Stop()
		must(process.Start(cfg))
	} else {
		fmt.Println("run `open-webbridge start` to launch with the new limits.")
	}
}

// runTabLimit manages per-domain (and future global) caps on the *number* of
// concurrently open Open WebBridge tabs. This complements ratelimit (which
// controls *rate* of navigations) by controlling *quantity* of tabs per site.
//
// Example:
//
//	open-webbridge tablimit set xiaohongshu.com --max 2
//	open-webbridge tablimit list
//	open-webbridge tablimit clear xiaohongshu.com
//
// Rules are sent to the extension on every tool call so they apply without
// daemon restart (hot update).
func runTabLimit(cfg *config.Config, args []string) {
	sub := "list"
	if len(args) > 0 {
		sub = args[0]
	}
	rest := args[1:]

	switch sub {
	case "list", "ls":
		printTabLimits(cfg)
	case "set", "add":
		if len(rest) < 1 || strings.HasPrefix(rest[0], "-") {
			fatal(fmt.Errorf("usage: open-webbridge tablimit set <domain> --max N"))
		}
		domain := normalizeDomain(rest[0])
		fs := flag.NewFlagSet("tablimit set", flag.ExitOnError)
		max := fs.Int("max", 0, "maximum concurrent OWB tabs for this domain (required)")
		_ = fs.Parse(rest[1:])
		if *max <= 0 {
			fatal(fmt.Errorf("--max N is required and must be > 0, e.g. --max 2"))
		}
		cfg.SetDomainTabLimit(domain, *max)
		must(cfg.Save())
		fmt.Printf("domain tab limit set: %s → at most %d Open WebBridge tab(s)\n", domain, *max)
		fmt.Println("change will take effect on the next navigate (no daemon restart required).")
	case "clear", "rm", "remove", "unset":
		fs := flag.NewFlagSet("tablimit clear", flag.ExitOnError)
		all := fs.Bool("all", false, "remove every per-domain tab limit")
		_ = fs.Parse(rest)
		if *all {
			cfg.DomainTabLimits = nil
			must(cfg.Save())
			fmt.Println("all per-domain tab limits cleared")
			fmt.Println("change will take effect on the next navigate (no daemon restart required).")
			return
		}
		if fs.NArg() < 1 {
			fatal(fmt.Errorf("usage: open-webbridge tablimit clear <domain> | --all"))
		}
		domain := normalizeDomain(fs.Arg(0))
		if cfg.ClearDomainTabLimit(domain) {
			must(cfg.Save())
			fmt.Printf("domain tab limit cleared: %s\n", domain)
			fmt.Println("change will take effect on the next navigate (no daemon restart required).")
		} else {
			fmt.Printf("no domain tab limit set for %s\n", domain)
		}
	default:
		fatal(fmt.Errorf("unknown tablimit subcommand %q (use list | set | clear)", sub))
	}
}

func printTabLimits(cfg *config.Config) {
	if len(cfg.DomainTabLimits) == 0 {
		fmt.Println("no per-domain tab limits configured")
		return
	}
	for _, r := range cfg.DomainTabLimits {
		fmt.Printf("  %-30s at most %d Open WebBridge tab(s)\n", r.Domain, r.Max)
	}
}

func runLogs(args []string) {
	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	n := fs.Int("n", 100, "number of lines")
	follow := fs.Bool("f", false, "follow")
	_ = fs.Parse(args)
	must(process.Logs(*n, *follow))
}

func runCall(cfg *config.Config, args []string) {
	// The action is the first argument; flags follow it. Go's flag package
	// stops at the first non-flag token, so we peel off the action first and
	// parse the remainder — this lets `call navigate --args '{...}'` work.
	if len(args) < 1 {
		fatal(fmt.Errorf("usage: open-webbridge call <action> [--session S] [--args '<json>'] [json]"))
	}
	action := args[0]

	fs := flag.NewFlagSet("call", flag.ExitOnError)
	session := fs.String("session", "", "browser session name (maps to a tab group)")
	argsFlag := fs.String("args", "", "tool arguments as a JSON object")
	daemon := fs.String("daemon", "", "drive a REMOTE daemon, e.g. http://10.0.0.5:9234 (default: local). Env: OWB_DAEMON")
	token := fs.String("token", "", "token for the remote daemon (default: local config / env OWB_TOKEN)")
	_ = fs.Parse(args[1:])

	raw := *argsFlag
	if raw == "" && fs.NArg() > 0 {
		raw = fs.Arg(0) // allow positional JSON: call navigate '{"url":"..."}'
	}
	var args2 json.RawMessage
	if raw != "" {
		if !json.Valid([]byte(raw)) {
			fatal(fmt.Errorf("--args is not valid JSON: %s", raw))
		}
		args2 = json.RawMessage(raw)
	}

	// Remote target resolution: flags win, then env, then local defaults.
	target := process.Target{BaseURL: cfg.LocalBaseURL(), Token: cfg.Token}
	if v := *daemon; v != "" {
		target.BaseURL = v
	} else if v := os.Getenv("OWB_DAEMON"); v != "" {
		target.BaseURL = v
	}
	if v := *token; v != "" {
		target.Token = v
	} else if v := os.Getenv("OWB_TOKEN"); v != "" && (*daemon != "" || os.Getenv("OWB_DAEMON") != "") {
		target.Token = v
	}

	err := process.Call(target, action, *session, args2)
	if process.IsSilent(err) {
		os.Exit(1)
	}
	must(err)
}

func usage() {
	fmt.Print(`open-webbridge — telemetry-free local browser bridge for AI agents

Commands:
  start [--host H] [--port N]
                        launch the background daemon (flags persist)
  stop                  stop the daemon
  restart               restart the daemon
  bind <host> [--port N]
                        expose /command remotely or revert, e.g.
                        open-webbridge bind remote          # 0.0.0.0; /command reachable, /ws stays loopback
                        open-webbridge bind local           # 127.0.0.1 (default, safest)
  status                print JSON status
  url                   print the WebSocket URL to paste into the extension
  token                 print the auth token
  logs [-n N] [-f]      tail the daemon log
  update [--check] [--force]
                        self-update from the latest GitHub release
  call <action> [--session S] [--args '<json>'] [json]
                        invoke a browser tool, e.g.
                        open-webbridge call navigate --session work '{"url":"https://example.com","newTab":true}'
  ratelimit list
  ratelimit set <domain> --per <seconds> [--max N]
  ratelimit clear <domain> | --all
                        throttle navigations per domain (blocks until a slot
                        frees), e.g.
                        open-webbridge ratelimit set xiaohongshu.com --per 5
                        open-webbridge ratelimit set douyin.com --per 10 --max 1
  tablimit list
  tablimit set <domain> --max N
  tablimit clear <domain> | --all
                        cap concurrent Open WebBridge tabs per domain (to avoid
                        too many tabs for one site), e.g.
                        open-webbridge tablimit set xiaohongshu.com --max 2
  version               print the version

Source: https://github.com/zhizuzhefu/open-webbridge (AGPL-3.0)
`)
}

func must(err error) {
	if err != nil && err.Error() != "" {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
