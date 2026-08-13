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

## Notes for reviewers

- Source is public at <https://github.com/zhizuzhefu/open-webbridge>.
- The uploaded bundle is produced by `npm run build` (esbuild minify only — no
  obfuscation).
- At runtime the extension connects only to a companion program on the user's own
  machine (`127.0.0.1`); it performs no analytics and no remote calls.
