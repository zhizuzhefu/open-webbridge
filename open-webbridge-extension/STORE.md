# Publishing the extension to the Chrome Web Store

The extension is distributed through the Chrome Web Store, which handles
auto-updates for users. The store **forbids obfuscated code** (minification is
allowed), so the package you upload must be the minified build produced by
`npm run build` — never the optional obfuscated `dist-obf/` build.

## 1. Build the upload package

```bash
cd open-webbridge-extension
npm install
npm run package     # → ../dist/open-webbridge-extension.zip  (manifest.json at the zip root)
```

`package` runs the same two steps the release workflow does — `npm run build`
into `dist/`, then zip its *contents* (not the folder) — and writes the archive
to the repository's git-ignored `dist/`. It deletes any previous archive first:
`zip` updates an existing file in place, which would otherwise keep files that
have since been removed from the build.

The release workflow attaches an identical `open-webbridge-extension.zip` to
every GitHub Release, so you can download it from there instead of building.

## 2. One-time developer setup

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in and pay the one-time US$5 registration fee.

## 3. Listing assets

- **Icon:** 128×128 (already in `icon/128.png`).
- **Screenshots:** at least one, 1280×800 or 640×400.
- **Descriptions:** a short summary (≤132 chars) and a detailed description.
- **Category:** Developer Tools. **Language:** as appropriate.
- **Privacy policy URL (required):**
  `https://github.com/zhizuzhefu/open-webbridge/blob/main/PRIVACY.md`

## 4. Upload and submit

1. Dashboard → **New item** → upload `open-webbridge-extension.zip`.
2. Complete the listing.
3. Declare data use as **“does not collect user data”** (accurate), and justify
   each permission:
   - `debugger` — drive pages via the developer protocol (the core feature).
   - `tabs`, `tabGroups`, `windows`, `activeTab` — open/group/activate tabs per task.
   - `scripting` — inject the annotation overlay into a page the user puts into
     annotation mode (on demand only; no persistent content scripts).
   - `storage` — remember the local connection address and token.
   - `alarms` — keep the background connection alive.
   - `downloads` — start and track downloads.
   - `<all_urls>` — automation may act on any site the user navigates to.
4. Submit for review. Extensions that use `debugger` and broad host access are
   reviewed more closely; expect from a few hours to several days.

## 5. After approval

The extension auto-updates for all users. To ship an update: bump the `version`
in `manifest.json`, run `npm run package`, and upload the new zip.

## 6. Listing copy

The dashboard blocks publishing until every field below is filled. They are
reproduced verbatim so a re-submission never has to re-derive them, and so the
justifications keep matching what the code actually does — if a permission's use
changes, change it here in the same commit.

The dashboard cannot be automated: Chrome refuses to let any extension script or
attach a debugger to the Web Store domain ("The extensions gallery cannot be
scripted"), so these are filled in by hand.

### Product details tab

- **Category:** Developer Tools
- **Language:** English (all listing text below is English)
- **Icon:** `open-webbridge-extension/icon/128.png` (128×128)
- **Screenshots:** at least one 1280×800 or 640×400 image
- **Privacy policy URL:**
  `https://github.com/zhizuzhefu/open-webbridge/blob/main/PRIVACY.md`

**Detailed description:**

> Open WebBridge lets your own AI assistant operate the browser you already use,
> with the sessions you are already signed in to.
>
> It is a bridge, not an agent: a small open-source program runs on your computer
> and this extension carries out the page instructions it sends — open a page,
> read its structure, click, type, fill and submit forms, capture a screenshot or
> PDF, record network activity, manage downloads. Because the work happens in
> your real browser profile, the assistant reaches internal dashboards, admin
> consoles and web mail without new logins or API keys.
>
> Pages are read through the accessibility tree, so the assistant targets
> elements by meaning rather than by brittle CSS selectors, and input is
> dispatched as real mouse and keyboard events through the DevTools Protocol.
> Independent tasks are isolated in separate tab groups so several can run at
> once without interfering.
>
> You can also annotate a page by hand: turn annotation mode on, click any
> element, and attach a comment. Your assistant reads those comments back with a
> selector it can act on and a picture of the element — so "this button is
> broken" points at something exact instead of being described in prose.
>
> Nothing leaves your machine. The extension connects only to the companion
> program on 127.0.0.1; there is no analytics, no telemetry, and no remote
> endpoint anywhere in the code. The source is public and auditable at
> https://github.com/zhizuzhefu/open-webbridge (AGPL-3.0).

### Privacy practices tab

**Single purpose:**

> Carry out browser-automation instructions that the user issues from their own
> AI assistant through a companion program running on the same computer
> (127.0.0.1): open and read pages, interact with them, capture screenshots, and
> relay the element-level comments the user leaves on a page. Every permission is
> used only to execute those locally-issued instructions.

**Permission justifications:**

- **`debugger`** — The core function. Page instructions are carried out through
  the Chrome DevTools Protocol: reading the accessibility tree for a structured
  view of the page, dispatching real mouse and keyboard input, capturing
  screenshots and PDFs, reading cookies, and recording network activity. CDP is
  required because synthetic DOM events are rejected by many sites and cannot
  reach cross-origin frames. The debugger is attached only to tabs the user's own
  instructions target, and detached when the task ends.
- **`tabs`** — To open the page the user asked for, switch between pages, read a
  tab's URL and title to confirm a navigation finished, and close the tab when
  the task is over.
- **`tabGroups`** — Each task runs in its own named tab group, so parallel tasks
  stay isolated and the user can see at a glance which tabs the assistant opened.
  Also used to find those groups again after the service worker restarts.
- **`scripting`** — Used only for annotations. When the user turns annotation
  mode on for a specific tab (toolbar button or Alt+Shift+A), an overlay is
  injected into that tab so the user can click elements and attach comments for
  their assistant. Injection is on demand for that one tab, it is removed when
  the user ends the mode, and the extension declares no persistent content
  scripts.
- **`storage`** — Stores the loopback address and access token of the companion
  program, so the connection survives a service-worker restart, plus the comments
  the user writes in annotation mode. Local only; nothing is transmitted.
- **`alarms`** — Chrome suspends the MV3 service worker when idle, which drops
  the connection to the companion program. A short periodic alarm wakes the
  worker so it can reconnect; without it a queued instruction would silently
  never run.
- **`downloads`** — The user can ask the assistant to download a file from the
  current page (for example exporting a report from an internal dashboard) and to
  list or cancel it. Used only for those user-requested downloads.
- **Host permissions (`<all_urls>`)** — The user decides at run time which site
  the assistant should operate: an internal dashboard, a SaaS console, web mail.
  That target cannot be known in advance, so access cannot be narrowed to a fixed
  list. Access is exercised only on the tabs the user's instructions name, and
  page data is passed only to the companion program on 127.0.0.1.
- **Remote code** — Select **"No, I am not using remote code."** Nothing is
  fetched from a remote server; all logic ships inside the package. Disclose the
  one adjacent behaviour so a reviewer is not surprised by it: the `evaluate`
  action runs JavaScript through the DevTools Protocol, and that script text
  comes from the user's own companion program over the loopback connection —
  user-supplied local input, not remotely hosted code.

**Data use:** declare **"does not collect user data"** and confirm all three
compliance statements (not sold to third parties, not used or transferred for
purposes unrelated to the single purpose, not used to determine
creditworthiness). All three are accurate — the extension collects nothing.

## Notes for reviewers

- Source is public at <https://github.com/zhizuzhefu/open-webbridge>.
- The uploaded bundle is produced by `npm run build` (esbuild minify only — no
  obfuscation).
- At runtime the extension connects only to a companion program on the user's own
  machine (`127.0.0.1`); it performs no analytics and no remote calls.
