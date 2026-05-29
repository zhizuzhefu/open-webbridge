---
name: open-webbridge
description: |
  Open WebBridge lets AI drive the user's real browser — navigate, click, type, read, screenshot, snapshot, run JS, capture network, and save PDFs using the user's actual login sessions, via a local daemon. Telemetry-free, open source. Use whenever the user wants to interact with websites, automate browser tasks, scrape web content, log into and operate a site, or anything needing a real browser. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with any website.
---

# Open WebBridge

Drive the user's real browser (with their logins) through a local, telemetry-free
daemon. You call tools with the `open-webbridge` CLI — it handles the auth token,
the HTTP transport, and writing screenshots/PDFs to disk for you.

Binary location: `~/.open-webbridge/bin/open-webbridge` (assume it is on PATH; if
"command not found", call it by that absolute path).

## Health check (always do this first)

```bash
open-webbridge status
```

Then act on the result:

- **`"running":true` and `"extension_connected":true`** — healthy. Proceed.
- **Anything else** — read `references/operations.md` for the install / start /
  connect routing table. Don't guess fixes.

## Calling tools

Every browser action is one CLI call:

```bash
open-webbridge call <action> --session <name> --args '<json>'
```

- `<action>` — one of the tools below.
- `--session <name>` — groups tabs; use a distinct name per site so parallel
  tasks stay isolated. Defaults to `default`.
- `--args '<json>'` — the tool arguments as a compact JSON object. You may also
  pass the JSON positionally: `open-webbridge call navigate '{"url":"..."}'`.

The command prints a JSON line `{"ok":true,"data":{...}}` (or `{"ok":false,
"error":"..."}`) and exits non-zero on failure.

Example — open a page and read it:

```bash
open-webbridge call navigate --session research --args '{"url":"https://example.com","newTab":true}'
open-webbridge call snapshot --session research
```

## Tools

| Action | Args | Returns |
|--------|------|---------|
| `navigate` | `url`, `newTab`(bool), `group_title` | `{url, tabId, title}` — use `newTab:true` on the first call of a session |
| `find_tab` | `url` (URL or domain), `active`(bool) | `{url, tabId}` — reuse an already-open tab; `active:true` picks the one the user is viewing |
| `snapshot` | — | `{url, title, tree, refCount}` — indented accessibility outline with `@e<N>` refs; **use this to read pages and target elements** |
| `click` | `selector` (`@e<N>` or CSS) | `{tag, text, method}` |
| `fill` | `selector`, `value` | `{mode, tag}` — clears then inserts; works on input/textarea AND contenteditable |
| `hover` | `selector` | `{success}` |
| `scroll` | `selector` OR `x`,`y` | `{success}` |
| `press_key` | `key` (Enter/Tab/Escape/Arrow…/single char), `selector`(opt) | `{key}` |
| `select_option` | `selector`, `value` or `label` | `{value}` |
| `drag` | `from`+`to` (selectors) OR `fromX/fromY`+`toX/toY` | `{from, to}` — real mouse drag |
| `tap` | `selector` OR `x`,`y` | `{point}` — touch tap |
| `evaluate` | `code` (string; supports await) | `{type, value}` |
| `screenshot` | `format`(png\|jpeg), `quality`(0-100), `selector`(opt) | `{path, format, sizeBytes}` — **saved to disk; returns a path, not base64** |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `file_name` | `{path, sizeBytes}` |
| `network` | `cmd`(start\|stop\|list\|detail), `filter`, `requestId` | request/response data |
| `upload` | `selector`, `files`(string[] absolute paths) | `{fileCount}` |
| `frames` | — | `{frames:[{targetId,type,url,title}]}` — list iframes; pass a `targetId` as `frame` to other tools |
| `emulate` | `device`{width,height,deviceScaleFactor,mobile} / `userAgent` / `geolocation`{latitude,longitude,accuracy} / `clear`(bool) | `{applied}` — device/UA/geo emulation |
| `download` | `cmd`(start\|list\|cancel), `url`(for start), `id`(for cancel), `limit` | `{downloads:[{id,url,filename,state,bytesReceived,totalBytes}]}` — native download mgmt |
| `dialog` | `action`(accept\|dismiss), `promptText`(opt), or `cmd:"list"` | `{policy}` / `{dialogs}` — handle native alert/confirm/prompt |
| `list_tabs` | — | `{tabs:[{tabId,url,title,active,groupTitle}]}` |
| `activate_tab` | `tabId`(opt) | `{tabId}` — bring a tab to the foreground |
| `close_tab` | — | `{closed}` — close the session's active tab |
| `close_session` | — | `{closed}` — close all of the session's tabs; **call at task end** |

Most element tools (`snapshot`, `click`, `fill`, `hover`, `scroll`, `press_key`,
`select_option`, `evaluate`, `upload`, `drag`, `tap`) accept an optional `frame`
arg — a `targetId` from `frames` — to act inside a cross-origin iframe. Take the
`snapshot` and use its `@e` refs **with the same `frame`** for click/fill/upload.

Native dialogs (alert/confirm/prompt) are auto-**dismissed** by default so
automation never hangs; call `dialog {"action":"accept"}` first if a flow needs
to accept one, and `dialog {"cmd":"list"}` to see what appeared.

## Prefer snapshot refs over CSS selectors

`snapshot` returns interactive elements as `@e<N>` refs keyed to the accessibility
tree. Pass them straight to `click`/`fill`/etc. They survive CSS class-hash churn
that breaks hand-written selectors. Take a fresh `snapshot` after the page changes
— refs are invalidated by navigation.

Fall back to CSS selectors (or `evaluate`) only when an element has no ref.

## Screenshots return a path

`screenshot` and `save_as_pdf` are written to `~/.open-webbridge/files/` by the
daemon; the result carries `path` (no base64 floods your context). Use the Read
tool on that path to view an image.

## evaluate tips

- Use compact `JSON.stringify(x)` — never pretty-print; large indented blobs can
  truncate in transit.
- Each `evaluate` shares the page realm. Re-declaring the same `const`/`let`
  across two calls throws. Wrap in an IIFE for a fresh scope:
  `(() => { const x = 1; return x; })()`.

## Text input — use `fill`

`fill` is clear-and-insert: it replaces existing content. To append, read the
current value with `evaluate`, concatenate, then `fill` the result.

## Form submit / special keys

There's no page reload on submit — click the submit button (`click`), or use
`press_key` with `{"key":"Enter","selector":"@e7"}` to submit from a field.

## Known limitations

- Sites that strictly check `event.isTrusted` (some banking portals, captchas)
  may reject synthetic `click`/`fill` — this is inherent to any local automation
  that doesn't seize OS input. `click` dispatches real CDP mouse events at the
  element's coordinates, which clears more checks than a synthetic `.click()`.
- Operations default to the top frame. For a cross-origin iframe, use `frames`
  to get its `targetId` and pass it as `frame` to the tool (or `navigate` to the
  iframe's URL directly).

## Versions

Daemon and extension release versions are independent and do not need to match.
Compatibility is governed by the daemon-extension protocol version. Use
`open-webbridge status`: `version` is the daemon version, `extension_version` is
the connected extension version, and `extension_compatible` tells you whether
tool calls are allowed.
