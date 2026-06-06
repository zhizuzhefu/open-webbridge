---
name: open-webbridge
description: |
  Open WebBridge lets AI drive the user's real browser — navigate, click, type, read, screenshot, snapshot, run JS, capture network, read cookies (including HttpOnly), and save PDFs using the user's actual login sessions, via a local daemon. Telemetry-free, open source. Use whenever the user wants to interact with websites, automate browser tasks, scrape web content, log into and operate a site, or anything needing a real browser. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with any website.
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
| `cookies` | `cmd`(get\|all), `domain`(opt), `urls`(opt, for `get`) | `{count, cookies:[{name,value,domain,path,expires,session,httpOnly,secure,sameSite}], header}` — **reads HttpOnly cookies** (which `evaluate`/`document.cookie` cannot) |
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

## Reading cookies (including HttpOnly)

`cookies` reads the browser's real cookie jar through the DevTools Protocol, so
it returns **HttpOnly** cookies too — the login tokens that `evaluate` can never
see because `document.cookie` hides them. Use it to export a logged-in session
(e.g. hand a site's auth cookies to a backend).

```bash
# cookies the active tab would send for the page it's on (default cmd:"get")
open-webbridge call cookies --session goofish

# every cookie for one domain and its subdomains, across the whole profile
open-webbridge call cookies --session goofish --args '{"cmd":"all","domain":"goofish.com"}'

# scope cmd:"get" to specific origins
open-webbridge call cookies --session goofish --args '{"urls":["https://h5api.m.goofish.com"]}'
```

- First `navigate` to (or `find_tab` onto) the logged-in site so the session has
  an open tab, then call `cookies`.
- `cmd:"get"` (default) returns the cookies scoped to the active tab's current
  page; `cmd:"all"` returns the entire profile's jar (use `domain` to filter).
- Each cookie carries `httpOnly`, `secure`, `sameSite`, and `expires` (unix
  seconds, or `null` + `session:true` for a session cookie).
- The result also includes a ready-to-paste `header` string (`k=v; k=v; …`) for
  use directly as a request `Cookie:` header.

## Per-domain rate limiting (avoid hammering a site)

When the user wants to throttle how often a site is hit — e.g. "search Xiaohongshu
at most once every 5s" — set a **per-domain navigation limit**. It is generic
(keyed purely by domain) and lives in the daemon, so it holds across separate
CLI calls.

```bash
# at most 1 navigation to xiaohongshu.com (and its subdomains) every 5s
open-webbridge ratelimit set xiaohongshu.com --per 5

# at most 1 navigation to douyin.com every 10s
open-webbridge ratelimit set douyin.com --per 10 --max 1

open-webbridge ratelimit list            # show current limits
open-webbridge ratelimit clear douyin.com   # remove one
open-webbridge ratelimit clear --all        # remove all
```

- `--per <seconds>` is the window; `--max N` (default 1) is how many navigations
  are allowed within it.
- The domain matches the URL host **and its subdomains**: `xiaohongshu.com` also
  covers `www.xiaohongshu.com`. Use the full host (`www.xiaohongshu.com`) to pin
  one host only. The most specific matching rule wins.
- **Only `navigate` is throttled** — that's the choke point where a fresh
  search/open hits a site. Reading the already-open page (`snapshot`, `click`,
  `fill`, …) is never blocked.
- **Behavior when limited:** the `navigate` call **blocks** until the next slot
  frees, then proceeds normally — you do not need retry logic. If the required
  wait would outlast the request timeout (~90s), it instead returns
  `{"ok":false,"error":"rate limited for this domain; retry in <N>s"}`; sleep
  that long and call again.
- `open-webbridge status` includes the active `rate_limits` so you can see what's
  in effect.

Setting a limit changes daemon config and **restarts the daemon** (briefly drops
the extension connection), like `open-webbridge bind`.

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
