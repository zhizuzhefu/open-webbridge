# Operations: install, lifecycle, connect, diagnose

Read this when `open-webbridge status` is not fully healthy, or when the user
asks to install, start, stop, restart, or troubleshoot Open WebBridge.

## Path convention

The binary lives at `~/.open-webbridge/bin/open-webbridge`. Config, pidfile,
logs, and saved files all live under `~/.open-webbridge/`:

```
~/.open-webbridge/
├── bin/open-webbridge      the daemon + CLI
├── config.json             { port, token }   (0600)
├── daemon.pid
├── logs/daemon.log
└── files/                  screenshots & PDFs land here
```

## Routing table (what to do based on status)

Run: `open-webbridge status`

| Observed | Action |
|---|---|
| `command not found` | Not installed. Install the release binary with the official installer: `curl -fsSL https://raw.githubusercontent.com/zhizuzhefu/open-webbridge/main/scripts/install.sh | bash`. |
| `{"running":false}` | Daemon not running. Run: `open-webbridge start` |
| `running:true`, `extension_connected:false` | Extension not connected. See **Connecting the extension** below. |
| `running:true`, `extension_connected:true` | Healthy. Return to SKILL.md and call tools. |

## Connecting the extension (one-time)

1. Install the Open WebBridge extension from the Chrome Web Store.
2. Get the connection URL (it embeds the auth token):
   ```bash
   open-webbridge url
   # ws://127.0.0.1:9234/ws?token=<hex>
   ```
3. Click the Open WebBridge toolbar icon, paste that URL into the popup, and
   click **Connect**. The dot turns green.
4. Verify: `open-webbridge status` now shows `"extension_connected":true`.

The extension remembers the URL and reconnects automatically afterward.

## Daily operations

- **Status:** `open-webbridge status`
- **Start:** `open-webbridge start` (idempotent)
- **Stop:** `open-webbridge stop`
- **Restart:** `open-webbridge restart`
- **Logs:** `open-webbridge logs -n 100` / follow: `open-webbridge logs -f`
- **Connection URL:** `open-webbridge url`
- **Token only:** `open-webbridge token`

## Remote automation (drive a Chrome that runs on another machine)

The browser and the daemon are **always on the same machine** — the daemon
talks to its local Chrome over a loopback-only `/ws` channel that can never be
reached from another host. What you expose for remote use is the **`/command`
HTTP endpoint**, so a user/AI elsewhere can send tool calls to that machine.

```
              machine A (the one with Chrome)
        ┌───────────────────────────────────────┐
 you ──▶│  /command (0.0.0.0:9234, token) ─▶ daemon ──127.0.0.1/ws──▶ extension ─▶ Chrome │
(machine B)                                 └───────────────────────────────────────┘
```

On machine A (where Chrome runs):

```bash
open-webbridge bind remote          # expose /command on 0.0.0.0 (restarts daemon)
open-webbridge token                # note the token
open-webbridge bind local           # revert to local-only when done
```

The extension on machine A still connects to `ws://127.0.0.1:9234/ws?token=…`
(unchanged — `open-webbridge url` always prints a loopback URL).

From machine B (driving it), point `call` at machine A:

```bash
open-webbridge call snapshot --session work \
  --daemon http://<machine-A-ip>:9234 --token <token-from-A>
# or set env once:
export OWB_DAEMON=http://<machine-A-ip>:9234 OWB_TOKEN=<token>
open-webbridge call navigate --session work --args '{"url":"https://example.com","newTab":true}'
```

**Security for remote `/command`:**

- The token is the *only* gate and HTTP traffic is **unencrypted**. Use only on
  a trusted LAN.
- For untrusted networks, keep the bind local and use an **SSH tunnel**:
  on machine B run `ssh -L 9234:127.0.0.1:9234 userA@machineA`, then
  `OWB_DAEMON=http://127.0.0.1:9234 OWB_TOKEN=<token> open-webbridge call …`.
  Encrypted end-to-end, no `bind remote` needed.

## Security model

- Default bind is **127.0.0.1 only**. The `/ws` browser-control channel is
  **always** loopback-only, even when `/command` is exposed remotely — a remote
  party can never attach as the extension.
- `/command` and `/ws` require the token from `config.json` (readable only by
  your user). This stops other local processes or web pages from driving your
  browser. The `open-webbridge call` CLI injects the token for you.
- **No telemetry.** There is no analytics SDK and no remote endpoint anywhere in
  the daemon or extension. Verify with `open-webbridge logs` (only local activity)
  or by inspecting the source.

## Diagnosing common failures

| Symptom | Action |
|---|---|
| `start` fails: "address already in use" | Another process holds the port. `lsof -i :9234`; or change `port` in `~/.open-webbridge/config.json` and `restart`. |
| `call` returns `"no browser extension connected"` | The extension isn't connected — do **Connecting the extension** above; make sure the browser is open. |
| `call` returns `"invalid or missing token"` | The popup URL is stale. Re-run `open-webbridge url` and paste the fresh URL. |
| Tool calls time out | `open-webbridge logs -n 100` for `[error]`/`panic`. A page that never finishes loading can stall `navigate`. |
| "debugger attach failed: ... another debugger" | DevTools is open on that tab, or another automation is attached. Close DevTools and retry. |
| Element ref errors ("unknown element ref") | The page changed since the last `snapshot`. Take a fresh `snapshot`. |
