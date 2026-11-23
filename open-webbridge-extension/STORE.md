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

Use the copy below when updating the listing. Keep the permission explanations
in sync with the extension's behavior.

Use the Chrome Web Store Developer Dashboard for listing fields. Chrome
restricts extension scripts and debugger access on the Web Store domain.

### Product details tab

- **Category:** Developer Tools
- **Default language:** English. Add Simplified Chinese as a localized description.
- **Icon:** `open-webbridge-extension/icon/128.png` (128×128)
- **Screenshots:** at least one 1280×800 or 640×400 image
- **Privacy policy URL:**
  `https://github.com/zhizuzhefu/open-webbridge/blob/main/PRIVACY.md`

**Official website:** https://apps.zhizuzhefu.com/open-webbridge/

**Support URL:** https://github.com/zhizuzhefu/open-webbridge/issues

Check the public listing after review. Use the Dashboard's impressions, daily
installs, uninstalls, and weekly users to compare the 28 days before and after
the listing update. Use Search Console to check indexing, queries, and clicks
for both landing page URLs.

**Short description (from the manifest):**

> Free, open-source Chrome automation for AI agents. Use your signed-in browser, with a local companion app.

**Detailed description (English):**

> Open WebBridge is a free, open-source Chrome extension for AI browser automation. It lets an AI agent that can run shell commands use the desktop Chrome profile you already use, including sites where you are signed in.
>
> WHAT YOU CAN DO
>
> • Read pages through an accessibility snapshot, click controls, fill forms, and navigate across tabs.
> • Capture screenshots, export pages as PDF, and manage downloads.
> • Attach comments to elements on a live page so your agent can find the exact control you want it to review.
>
> HOW TO GET STARTED
>
> 1. Add Open WebBridge to desktop Chrome.
> 2. Install the free companion program on the same computer. macOS and Linux have an installer. Windows has x64 and ARM64 executables.
> 3. Run open-webbridge url, paste the address into the extension, and click Connect. Run open-webbridge status to verify the connection.
>
> Installation and downloads: https://apps.zhizuzhefu.com/open-webbridge/
>
> LOCAL CONNECTION AND OPEN SOURCE
>
> The extension connects to the companion program on your computer over loopback and has no telemetry. Chrome debugger permission lets it read page structure and perform the browser actions you request. Your selected AI agent controls how it processes tool results.
>
> Source code and AGPL-3.0 license: https://github.com/zhizuzhefu/open-webbridge

**Detailed description (Simplified Chinese):**

> Open WebBridge 是免费开源的 Chrome AI 浏览器自动化扩展。它让可以运行命令的 AI 助手使用你正在用的桌面版 Chrome，包括你已登录的网站。
>
> 可以读取网页、点击、填写表单、截图、导出 PDF 和管理下载。你还可以在真实网页的元素上添加评论，让助手找到你希望它检查的控件。
>
> 安装方法
>
> 1. 在桌面版 Chrome 中添加 Open WebBridge 扩展。
> 2. 在同一台电脑上安装配套程序。macOS 和 Linux 可运行安装脚本，Windows 可下载 x64 或 ARM64 可执行文件。
> 3. 运行 open-webbridge url，把地址粘贴到扩展并点击 Connect。用 open-webbridge status 确认连接。
>
> 中文安装说明和下载：https://apps.zhizuzhefu.com/open-webbridge/zh-cn/
>
> 扩展通过本机回环地址连接配套程序，无遥测。Chrome 调试权限用于读取页面结构和执行你请求的操作。工具结果由你选用的 AI 助手处理。
>
> 源代码和 AGPL-3.0 许可：https://github.com/zhizuzhefu/open-webbridge

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
