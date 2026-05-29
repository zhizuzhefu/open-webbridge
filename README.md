# Open WebBridge — User Manual

**English** | [中文](README.zh-CN.md)

Open WebBridge is a local tool that lets an AI agent operate your real Chrome
browser. The agent can open pages, read their contents, click, type, fill and
submit forms, download files, capture screenshots and PDFs, and complete
multi-step tasks — within your existing browser profile, using the sessions and
logins you already have. The software runs entirely on your computer and sends
no data to any external service.

This manual covers installation, configuration, the command-line interface, the
full set of actions, common workflows, remote operation, and troubleshooting.

---

## Table of contents

1. [Overview](#1-overview)
2. [Key capabilities](#2-key-capabilities)
3. [Typical use cases](#3-typical-use-cases)
4. [System requirements](#4-system-requirements)
5. [Installation](#5-installation)
6. [Core concepts](#6-core-concepts)
7. [Command-line reference](#7-command-line-reference)
8. [Action reference](#8-action-reference)
9. [Examples and workflows](#9-examples-and-workflows)
10. [Remote operation](#10-remote-operation)
11. [Configuration and file locations](#11-configuration-and-file-locations)
12. [Updating](#12-updating)
13. [Security and privacy](#13-security-and-privacy)
14. [Troubleshooting](#14-troubleshooting)
15. [Uninstalling](#15-uninstalling)
16. [License](#16-license)

---

## 1. Overview

Open WebBridge has three parts that you install once:

- A **background service** (a small command-line program) that runs on your
  machine and accepts instructions.
- A **browser extension** that performs those instructions inside your Chrome.
- An optional **agent skill** that teaches a compatible AI assistant how to issue
  the instructions.

You — or your AI assistant — issue instructions with a single command,
`open-webbridge call <action>`. Each instruction is carried out in your own
browser, so the agent sees the same pages you would see, already signed in.

Because the browser and the service run together on one machine and the service
makes no outbound network connections, your browsing and data never leave your
computer.

## 2. Key capabilities

- **Operate authenticated sites.** Work runs in your real browser profile, so the
  agent reaches anything you are already logged into — internal dashboards, SaaS
  applications, admin consoles, web mail — without re-authenticating or API keys.
- **Read pages reliably.** The agent receives a clean, labelled outline of each
  page (based on its accessibility structure) and targets elements by meaning, so
  automations keep working even when a site's styling or markup changes.
- **Interact like a person.** Click, type into inputs and rich text editors,
  choose dropdown options, hover, scroll, press keys, drag, tap, and upload files.
- **Run JavaScript** in the context of a page to read values or perform custom
  logic.
- **Capture output.** Save full-page or single-element screenshots and export
  pages to PDF. Captured files are written to disk and referenced by path.
- **Inspect and emulate.** Record network requests and responses; emulate device
  screen size, user agent, and geolocation.
- **Manage files and pop-ups.** Start, list, and cancel downloads; handle native
  browser dialogs (alert / confirm / prompt) automatically so tasks never stall.
- **Work across frames.** Operate inside embedded (including cross-origin)
  iframes, not only the top-level page.
- **Run tasks in parallel.** Independent jobs are isolated in separate groups of
  tabs (“sessions”) so they do not interfere with one another.
- **Operate a remote browser.** Run the service on a server or spare machine and
  send instructions to it from your laptop or a CI pipeline.

## 3. Typical use cases

- AI agents that must use the live, logged-in web — research and operational
  tasks that an API cannot perform.
- Automating internal portals and SaaS interfaces that have no usable API.
- Extracting data from sites that require a login or render with JavaScript.
- Recurring web chores such as generating and downloading reports or filing
  records.
- Producing screenshots or PDF copies of web pages for records and review.
- Inspecting a web application's network behaviour.
- Verifying mobile or region-specific behaviour through device and location
  emulation.

## 4. System requirements

- **Operating system:** macOS or Linux.
- **Browser:** a Chromium-based browser (Google Chrome or Microsoft Edge).
- **To build from source (optional):** Go 1.24 or newer for the service;
  Node.js 18 or newer for the extension.

A prebuilt service binary is available, so most users do not need a build
toolchain.

## 5. Installation

Installation has three steps: install the background service, add the browser
extension, and connect them.

### 5.1 Install the background service

Run the installer, which downloads the prebuilt binary for your platform and
starts the service:

```bash
curl -fsSL https://raw.githubusercontent.com/zhizuzhefu/open-webbridge/main/scripts/install.sh | bash
```

To install a specific version, set `OWB_VERSION` (e.g. `OWB_VERSION=v1.0.2`).
To build from source instead, clone the repository and run
`./scripts/dev-install.sh`.

The program is installed to `~/.open-webbridge/bin/open-webbridge`. Add it to
your `PATH` for convenience:

```bash
export PATH="$PATH:$HOME/.open-webbridge/bin"
```

### 5.2 Install the browser extension

Choose one of the following:

- **Chrome Web Store** (recommended; updates automatically): install the
  Open WebBridge extension from its store listing.
- **Manual install:** build the extension and load it unpacked.

  ```bash
  cd open-webbridge-extension
  npm install
  npm run build          # produces the dist/ folder
  ```

  Then open `chrome://extensions`, enable **Developer mode**, choose **Load
  unpacked**, and select the `dist/` folder.

### 5.3 Connect the extension

1. Print the connection link, which includes your machine's access token:

   ```bash
   open-webbridge url
   # ws://127.0.0.1:9234/ws?token=…
   ```

2. Click the Open WebBridge icon in the browser toolbar, paste the link into the
   field, and press **Connect**. The status indicator turns green.

The extension remembers the link and reconnects automatically afterwards.

### 5.4 Verify the installation

```bash
open-webbridge status
```

A healthy result reports `"running": true` and `"extension_connected": true`.

## 6. Core concepts

**Sessions.** Every instruction belongs to a session, named with `--session`.
Each session corresponds to a separate group of tabs in the browser, which keeps
parallel tasks isolated. If you omit `--session`, the session `default` is used.

**Element references.** The `snapshot` action returns a text outline of the page
in which interactive elements are labelled `@e1`, `@e2`, and so on. Pass these
labels to actions such as `click` and `fill`. Because the labels are derived from
the page's accessibility structure rather than its CSS, they remain valid across
cosmetic changes to the site. Take a fresh `snapshot` after the page changes.

**Captured files.** Screenshots and PDFs are written to
`~/.open-webbridge/files/`. The action returns the file path so that large image
data is never returned inline.

**Access token.** A secret token, generated on first run and stored in your
configuration file, is required for every instruction. The command-line tool
supplies it automatically. This prevents other programs or web pages on your
machine from driving your browser.

## 7. Command-line reference

General form:

```bash
open-webbridge <command> [options]
```

| Command | Description |
|---------|-------------|
| `start [--host H] [--port N]` | Start the background service. `--host` and `--port` are saved to the configuration. |
| `stop` | Stop the service. |
| `restart` | Restart the service. |
| `status` | Print service and connection status as JSON. |
| `url` | Print the connection link (with token) for the extension. |
| `token` | Print the access token. |
| `logs [-n N] [-f]` | Show the last `N` log lines; `-f` follows the log live. |
| `update [--check] [--force]` | Update the service to the latest release. `--check` only reports availability. |
| `bind <host> [--port N]` | Set the network binding (`local`/`127.0.0.1`, or `remote`/`0.0.0.0`) and restart. See [Remote operation](#10-remote-operation). |
| `call <action> [options]` | Perform a browser action (see below). |
| `version` | Print the version. |
| `help` | Show usage. |

### The `call` command

```bash
open-webbridge call <action> [--session NAME] [--args '<json>'] [json] \
                             [--daemon URL] [--token TOKEN]
```

| Option | Description |
|--------|-------------|
| `<action>` | The action to perform (see [Action reference](#8-action-reference)). |
| `--session NAME` | The session (tab group) to act in. Default: `default`. |
| `--args '<json>'` | The action's arguments as a JSON object. Arguments may also be given as a trailing JSON string. |
| `--daemon URL` | Send the instruction to a remote service instead of the local one. Also settable via the `OWB_DAEMON` environment variable. |
| `--token TOKEN` | Access token for a remote service. Also settable via `OWB_TOKEN`. |

The command prints a JSON result of the form `{"ok": true, "data": …}` or
`{"ok": false, "error": "…"}` and exits non-zero on failure.

### The `status` result

| Field | Meaning |
|-------|---------|
| `running` | The service is listening. |
| `host`, `port` | The address the service is bound to. |
| `remote` | Whether the command endpoint is exposed beyond loopback. |
| `version` | Service version. |
| `extension_connected` | Whether the browser extension is attached. |
| `extension_version` | Version reported by the extension. |
| `extension_compatible` | Whether the extension's protocol version matches the daemon's. |
| `uptime_seconds` | Service uptime. |

## 8. Action reference

Every action is invoked through `open-webbridge call`. Arguments are passed as a
JSON object via `--args`. Many element actions also accept an optional `frame`
argument — a frame identifier obtained from `frames` — to act inside an embedded
iframe.

### Navigation and tabs

| Action | Arguments | Returns |
|--------|-----------|---------|
| `navigate` | `url` (string, required); `newTab` (bool); `group_title` (string) | `{ url, tabId, title }` |
| `find_tab` | `url` (string — URL or domain, required); `active` (bool) | `{ url, tabId }` |
| `list_tabs` | — | `{ tabs: [ { tabId, url, title, active, groupTitle } ] }` |
| `activate_tab` | `tabId` (number, optional) | `{ tabId }` |
| `close_tab` | — | `{ closed }` |
| `close_session` | — | `{ closed }` |

Use `newTab: true` on the first `navigate` of a session. Call `close_session`
when a task is finished.

### Reading a page

| Action | Arguments | Returns |
|--------|-----------|---------|
| `snapshot` | `frame` (string, optional) | `{ url, title, frame, refCount, tree }` |
| `evaluate` | `code` (string, required); `frame` (string, optional) | `{ type, value }` |
| `frames` | — | `{ tabId, count, frames: [ { targetId, type, url, title, attached } ] }` |

`snapshot` is the primary way to read a page and to locate elements. `evaluate`
runs JavaScript and returns its (JSON-serialisable) result; it supports `await`.

### Interaction

| Action | Arguments | Returns |
|--------|-----------|---------|
| `click` | `selector` (`@eN` reference or CSS, required); `frame` | `{ tag, text, method }` |
| `fill` | `selector` (required); `value` (string); `frame` | `{ mode, tag }` |
| `hover` | `selector`, or `x` and `y`; `frame` | `{ success }` |
| `scroll` | `selector`, or `x` and `y`; `frame` | `{ success, mode }` |
| `press_key` | `key` (e.g. `Enter`, `Tab`, `Escape`, `ArrowDown`, or a single character); `selector` (optional); `frame` | `{ key }` |
| `select_option` | `selector` (required); `value` or `label`; `frame` | `{ value }` |
| `drag` | `from` and `to` (selectors), or `fromX`/`fromY` and `toX`/`toY`; `frame` | `{ from, to }` |
| `tap` | `selector`, or `x` and `y`; `frame` | `{ point, mode }` |
| `upload` | `selector` (required); `files` (array of absolute paths, required); `frame` | `{ fileCount }` |

`fill` replaces existing content. To append, read the current value with
`evaluate`, concatenate, and `fill` the result.

### Capture

| Action | Arguments | Returns |
|--------|-----------|---------|
| `screenshot` | `format` (`png` or `jpeg`); `quality` (0–100, for JPEG); `selector` (optional, capture one element) | `{ path, format, sizeBytes }` |
| `save_as_pdf` | `paper_format` (`letter`/`a4`/`legal`/`a3`/`tabloid`); `landscape` (bool); `scale` (0.1–2.0); `print_background` (bool); `file_name` (string) | `{ path, sizeBytes }` |

### Inspect and emulate

| Action | Arguments | Returns |
|--------|-----------|---------|
| `network` | `cmd` (`start` / `stop` / `list` / `detail`); `filter` (substring, for `list`); `requestId` (for `detail`) | request/response data |
| `emulate` | `device` `{ width, height, deviceScaleFactor, mobile }`; `userAgent` (string); `geolocation` `{ latitude, longitude, accuracy }`; `clear` (bool) | `{ applied }` |

For `network`, call `start`, perform the activity, then `list` (optionally
filtered) and `detail` for a specific request. For `emulate` geolocation, the
site must already have geolocation permission for the override to take effect.

### Files and dialogs

| Action | Arguments | Returns |
|--------|-----------|---------|
| `download` | `cmd` (`start` / `list` / `cancel`); `url` (for `start`); `filename` (optional); `id` (for `cancel`); `limit` (for `list`) | `{ id }` or `{ downloads: [ … ] }` |
| `dialog` | `action` (`accept` / `dismiss`); `promptText` (optional); or `cmd: "list"` | `{ policy }` or `{ dialogs: [ … ] }` |

Native dialogs are dismissed automatically by default so that automation never
freezes. Call `dialog` with `{"action":"accept"}` beforehand if a flow needs a
dialog accepted, and `{"cmd":"list"}` to review dialogs that appeared.

The complete reference, including notes and edge cases, is in
[`open-webbridge-skill/SKILL.md`](open-webbridge-skill/SKILL.md).

## 9. Examples and workflows

**Read a page and extract its title:**

```bash
open-webbridge call navigate --session demo --args '{"url":"https://example.com","newTab":true}'
open-webbridge call snapshot --session demo
open-webbridge call evaluate --session demo --args '{"code":"document.title"}'
open-webbridge call close_session --session demo
```

**Fill in and submit a form** (using element references from a snapshot):

```bash
open-webbridge call navigate --session form --args '{"url":"https://example.com/login","newTab":true}'
open-webbridge call snapshot --session form          # find the field/button references
open-webbridge call fill  --session form --args '{"selector":"@e3","value":"my-user"}'
open-webbridge call fill  --session form --args '{"selector":"@e4","value":"secret"}'
open-webbridge call click --session form --args '{"selector":"@e5"}'
```

**Capture a page as PDF:**

```bash
open-webbridge call navigate    --session cap --args '{"url":"https://example.com/report","newTab":true}'
open-webbridge call save_as_pdf --session cap --args '{"paper_format":"a4","file_name":"report"}'
```

**Record network activity:**

```bash
open-webbridge call network --session net --args '{"cmd":"start"}'
open-webbridge call navigate --session net --args '{"url":"https://example.com"}'
open-webbridge call network --session net --args '{"cmd":"list","filter":"api"}'
```

**Run two jobs in parallel** by using distinct session names:

```bash
open-webbridge call navigate --session research --args '{"url":"https://news.example","newTab":true}'
open-webbridge call navigate --session filing   --args '{"url":"https://admin.example","newTab":true}'
```

## 10. Remote operation

The browser and the service always run on the same machine. To operate that
machine's browser from elsewhere, expose only the instruction endpoint:

```bash
# On the machine running Chrome:
open-webbridge bind remote      # bind the command endpoint to all interfaces
open-webbridge token            # note the access token
open-webbridge bind local       # revert to local-only when finished
```

From another machine, direct `call` at the remote service:

```bash
open-webbridge call snapshot --session work \
  --daemon http://<remote-host>:9234 --token <token>
```

The control channel between the service and the browser remains restricted to
the local machine at all times, so a remote party can never attach as the
browser. Remote instruction traffic is authenticated by token but not encrypted;
use it only on a trusted network, or tunnel it over SSH. See
[`open-webbridge-skill/references/operations.md`](open-webbridge-skill/references/operations.md)
for details.

## 11. Configuration and file locations

All data is stored under `~/.open-webbridge/`:

```
~/.open-webbridge/
├── bin/open-webbridge      the service / command-line program
├── config.json             configuration (permissions 0600)
├── daemon.pid              process id of the running service
├── logs/daemon.log         activity log
└── files/                  saved screenshots and PDFs
```

`config.json` contains:

| Field | Default | Meaning |
|-------|---------|---------|
| `host` | `127.0.0.1` | Network binding for the instruction endpoint. |
| `port` | `9234` | TCP port. |
| `token` | generated | Access token required for every instruction. |
| `auto_update` | `false` | When `true`, the service installs newer releases automatically during its daily check. |

Edit the file while the service is stopped, then `open-webbridge start`.

## 12. Updating

```bash
open-webbridge update --check     # report whether a newer version is available
open-webbridge update             # install the latest version and restart
```

The service also checks for updates once a day and notes availability in its log;
set `auto_update` to `true` to apply updates automatically. The browser extension
updates through the Chrome Web Store.

The daemon and the extension are versioned **independently** — they ship on
separate channels (GitHub Releases and the Chrome Web Store) and their release
numbers need not match. Compatibility is governed by a small **protocol version**
that the two exchange on connect; it changes only when the message format changes
incompatibly. So a routine daemon update never forces an extension update (or
vice versa). If the protocol versions ever differ, the connection is refused with
a message telling you which side to update.

## 13. Security and privacy

- The service runs entirely on your machine and makes no outbound connections by
  default.
- It contains no analytics or usage reporting of any kind.
- Every instruction requires the access token from your configuration file,
  which is readable only by your user account. This prevents other local programs
  or web pages from controlling your browser.
- The channel between the service and the browser is restricted to the local
  machine even when remote instructions are enabled.
- `open-webbridge logs` records the activity performed.

Because actions run in your real browser profile, an agent you authorise can act
with your logged-in sessions. Grant access only to agents you trust, and stop the
service (`open-webbridge stop`) when it is not needed.

See the full [Privacy Policy](PRIVACY.md).

## 14. Troubleshooting

| Symptom | Resolution |
|---------|------------|
| `command not found` | The service is not installed, or its directory is not on your `PATH`. Re-run the installer or call it by full path: `~/.open-webbridge/bin/open-webbridge`. |
| `status` shows `"running": false` | Start it: `open-webbridge start`. |
| `status` shows `"extension_connected": false` | Open your browser and ensure the extension is installed and connected (see [5.3](#53-connect-the-extension)). |
| A call returns `no browser extension connected` | Same as above — connect the extension. |
| A call returns `invalid or missing token` | The link in the extension popup is out of date. Re-run `open-webbridge url` and paste the new link. |
| A call returns `unknown element ref …` | The page changed since the last snapshot. Take a fresh `snapshot` and use the new references. |
| `start` reports the address is in use | Another program holds the port. Change `port` in `config.json` and restart, or free the port. |
| The extension card shows an error after loading | Rebuild it (`npm run build`) and reload it in `chrome://extensions`. |
| Tool calls time out | Inspect recent activity with `open-webbridge logs -n 100`; a page that never finishes loading can stall navigation. |
| macOS: `killed: 9` / "cannot be opened" | The binary lost its signature (e.g. downloaded via a browser, which quarantines it). Re-run the installer, or fix it manually: `xattr -dr com.apple.quarantine ~/.open-webbridge/bin/open-webbridge && codesign --force --sign - ~/.open-webbridge/bin/open-webbridge`. |

## 15. Uninstalling

1. Stop the service: `open-webbridge stop`.
2. Remove the extension from `chrome://extensions`.
3. Delete the data directory: `rm -rf ~/.open-webbridge`.
4. Remove the agent skill directory if it was installed (for example,
   `~/.claude/skills/open-webbridge`).

## 16. License

Copyright (C) 2026 zhizuzhefu (https://github.com/zhizuzhefu).

Open WebBridge is free software, licensed under the **GNU Affero General Public
License v3.0 or later (AGPL-3.0-or-later)**. You may use, study, share, and
modify it under the terms of that license. In particular, if you run a modified
version to provide a service over a network, you must make the modified source
available to that service's users. See [LICENSE](LICENSE) for the full text.

The copyright holders may also offer the software under separate commercial terms;
contact them if AGPL does not suit your use.
