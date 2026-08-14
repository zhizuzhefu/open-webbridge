// annotator.js — the in-page annotation overlay.
//
// Injected on demand by the service worker (chrome.scripting) into every frame
// of a tab the user put into annotation mode, and torn down completely when the
// mode ends: Open WebBridge leaves no code running in pages nobody asked it to
// touch.
//
// It lives at the extension root (like popup.js) so the injected path is the
// same in the source tree and in the built dist/ — see build.mjs.
//
// Responsibilities:
//   * hover highlight + click-to-pick any element (shadow DOM aware)
//   * a composer to write the note, and pins that show existing notes
//   * an element "fingerprint" (several independent selectors) so the AI can
//     find the same element later even after the page re-renders
//   * relaying everything to the service worker, which owns the store
//
// It is deliberately dependency-free and self-contained: it is injected as a
// plain file, not as part of the module bundle.

(() => {
  "use strict";

  if (window.__owbAnnotator) {
    window.__owbAnnotator.rearm();
    return;
  }

  const IS_TOP = window.top === window;
  const HOST_ATTR = "data-owb-annotator";
  const Z = 2147483600;

  let mode = false;
  let host = null;
  let root = null;
  let ui = null; // { highlight, label, pins, panel, bar }
  let items = []; // annotations for this frame's URL
  let hovered = null;
  let picked = null;
  let composerOpen = false;
  let pinsVisible = true;
  let layoutTimer = null;
  let rafPending = false;
  const resolvedCache = new Map(); // annotation id -> Element
  const missCache = new Map(); // annotation id -> last failed lookup timestamp

  // ---------------------------------------------------------------- styles --

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; }
    .box {
      position: absolute; border: 2px solid #2f6bff; border-radius: 3px;
      background: rgba(47,107,255,.10); pointer-events: none;
      box-shadow: 0 0 0 1px rgba(255,255,255,.55); transition: none;
    }
    .box.flash { border-color: #f59e0b; background: rgba(245,158,11,.18); animation: owbpulse 1.1s ease-out 2; }
    @keyframes owbpulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
    .tagline {
      position: absolute; max-width: 320px; padding: 3px 7px; border-radius: 4px;
      background: #2f6bff; color: #fff; font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
    }
    .pin {
      position: absolute; min-width: 22px; height: 22px; padding: 0 5px;
      border-radius: 11px; background: #2f6bff; color: #fff; border: 2px solid #fff;
      font: 600 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center; cursor: pointer; pointer-events: auto;
      box-shadow: 0 1px 4px rgba(15,23,42,.35);
    }
    .pin.resolved { background: #16a34a; }
    .pin.lost { background: #94a3b8; }
    .pin[data-active="1"] { outline: 2px solid #1e293b; outline-offset: 1px; }
    .card {
      position: absolute; width: 320px; max-width: calc(100vw - 24px);
      background: #fff; color: #0f172a; border-radius: 10px; pointer-events: auto;
      border: 1px solid #e2e8f0; box-shadow: 0 12px 32px rgba(15,23,42,.22);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      padding: 12px; box-sizing: border-box; direction: ltr; text-align: left;
    }
    .card .target {
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #475569;
      background: #f1f5f9; border-radius: 5px; padding: 5px 7px; margin-bottom: 8px;
      overflow-wrap: anywhere; max-height: 54px; overflow: hidden;
    }
    .card textarea {
      width: 100%; min-height: 74px; resize: vertical; box-sizing: border-box;
      border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 8px; color: #0f172a;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      background: #fff; outline: none;
    }
    .card textarea:focus { border-color: #2f6bff; box-shadow: 0 0 0 3px rgba(47,107,255,.15); }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 2px; }
    .chip {
      border: 1px solid #cbd5e1; background: #fff; color: #475569; border-radius: 999px;
      padding: 2px 9px; font-size: 11px; cursor: pointer; user-select: none;
    }
    .chip[data-on="1"] { background: #2f6bff; border-color: #2f6bff; color: #fff; }
    .row { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
    .spacer { flex: 1; }
    button.btn {
      border-radius: 6px; padding: 5px 11px; font-size: 12px; cursor: pointer;
      border: 1px solid #cbd5e1; background: #fff; color: #334155; font-family: inherit;
    }
    button.btn:hover { background: #f8fafc; }
    button.btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
    button.btn.primary:hover { background: #245ae0; }
    button.btn.danger { color: #b91c1c; }
    .meta { font-size: 11px; color: #64748b; margin-top: 8px; }
    .note {
      margin-top: 8px; padding: 7px 8px; border-radius: 6px; font-size: 12px;
      background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; white-space: pre-wrap;
    }
    .body { white-space: pre-wrap; word-break: break-word; }
    .bar {
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px; pointer-events: auto;
      background: #0f172a; color: #f8fafc; border-radius: 999px; padding: 7px 8px 7px 14px;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      box-shadow: 0 8px 28px rgba(15,23,42,.4);
    }
    .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
    .bar .hint { color: #94a3b8; font-size: 11px; }
    .bar button.btn { background: #1e293b; border-color: #334155; color: #e2e8f0; }
    .bar button.btn:hover { background: #334155; }
    .bar button.btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
    .hidden { display: none !important; }
  `;

  const TAGS = ["bug", "layout", "copy", "behaviour", "request", "question"];

  // ------------------------------------------------------------------ host --

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute(HOST_ATTR, "");
    host.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;margin:0;padding:0;border:0;" +
      "pointer-events:none;z-index:" + Z + ";color-scheme:light;";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const layer = el("div", "layer");
    const highlight = el("div", "box hidden");
    const label = el("div", "tagline hidden");
    const pins = el("div", "layer");
    layer.appendChild(highlight);
    layer.appendChild(label);
    root.appendChild(layer);
    root.appendChild(pins);

    const panelHost = el("div", "layer");
    root.appendChild(panelHost);

    let bar = null;
    if (IS_TOP) {
      bar = buildBar();
      root.appendChild(bar.el);
    }
    ui = { highlight, label, pins, panelHost, bar, card: null };
    (document.body || document.documentElement).appendChild(host);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildBar() {
    const wrap = el("div", "bar");
    const dot = el("div", "dot");
    const count = el("span", "", "Annotating");
    const hint = el("span", "hint", "click an element · ⌥↑ parent · Esc exit");
    const toggle = el("button", "btn", "Hide pins");
    const done = el("button", "btn primary", "Done");
    wrap.append(dot, count, hint, toggle, done);
    toggle.addEventListener("click", (e) => {
      stopAll(e);
      pinsVisible = !pinsVisible;
      toggle.textContent = pinsVisible ? "Hide pins" : "Show pins";
      renderPins();
    });
    done.addEventListener("click", (e) => {
      stopAll(e);
      send({ type: "OWB_ANN_STOP" });
      setMode(false);
    });
    return { el: wrap, count, toggle };
  }

  function updateBar() {
    if (!ui || !ui.bar) return;
    const open = items.filter((i) => i.status !== "resolved").length;
    ui.bar.count.textContent = open ? `Annotating · ${open} note${open === 1 ? "" : "s"}` : "Annotating";
  }

  // ------------------------------------------------------- element details --

  const AUTO_ID = /^\d|[0-9a-f]{8,}|:r[0-9a-z]+:|^(ember|react|radix|mui|headlessui)/i;
  const AUTO_CLASS = /[0-9a-f]{6,}|^(css|sc|jsx|emotion)-|^_[a-z0-9]{4,}/i;
  const TESTID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];

  const IMPLICIT_ROLE = {
    a: "link", button: "button", select: "combobox", textarea: "textbox", img: "img",
    form: "form", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    aside: "complementary", table: "table", ul: "list", ol: "list", li: "listitem",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    label: "label", summary: "button", dialog: "dialog", p: "paragraph",
  };

  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/[^\w-]/g, "\\$&");
  }

  function attrVal(v) {
    return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function tidy(s, max) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max || 200);
  }

  function scopeOf(node) {
    const r = node.getRootNode ? node.getRootNode() : document;
    return r && r.querySelectorAll ? r : document;
  }

  function unique(scope, sel) {
    try {
      return scope.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function stableClasses(node) {
    const out = [];
    for (const c of node.classList || []) {
      if (c.length < 2 || c.length > 30 || AUTO_CLASS.test(c)) continue;
      out.push(c);
      if (out.length === 2) break;
    }
    return out;
  }

  function cssPath(node) {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      if (cur.id && !AUTO_ID.test(cur.id)) {
        parts.unshift("#" + esc(cur.id));
        break;
      }
      let seg = cur.localName;
      const cls = stableClasses(cur);
      if (cls.length) seg += "." + cls.map(esc).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.localName === cur.localName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function xpathOf(node) {
    if (node.getRootNode() !== document) return ""; // XPath cannot cross a shadow root
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      let i = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.localName === cur.localName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${cur.localName}[${i}]`);
      cur = cur.parentElement;
    }
    return "/" + parts.join("/");
  }

  function accessibleName(node) {
    const g = (a) => (node.getAttribute ? node.getAttribute(a) : null);
    const aria = g("aria-label");
    if (aria) return tidy(aria);
    const by = g("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => {
          const t = scopeOf(node).getElementById ? scopeOf(node).getElementById(id) : null;
          return t ? t.textContent : "";
        })
        .join(" ");
      if (tidy(text)) return tidy(text);
    }
    if (node.labels && node.labels.length) return tidy(node.labels[0].textContent);
    for (const a of ["alt", "title", "placeholder", "value"]) {
      const v = g(a);
      if (v) return tidy(v);
    }
    return tidy(node.innerText || node.textContent);
  }

  function roleOf(node) {
    const explicit = node.getAttribute && node.getAttribute("role");
    if (explicit) return tidy(explicit, 40);
    const tag = node.localName;
    if (tag === "input") {
      const t = (node.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    return IMPLICIT_ROLE[tag] || "";
  }

  function selectorsFor(node) {
    const scope = scopeOf(node);
    const tag = node.localName;
    const out = { css: "", xpath: xpathOf(node), testid: "", aria: "", text: "" };
    const candidates = [];

    for (const a of TESTID_ATTRS) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v) {
        const sel = `[${a}="${attrVal(v)}"]`;
        out.testid = out.testid || sel;
        candidates.push({ kind: "testid", sel });
      }
    }
    if (node.id && !AUTO_ID.test(node.id)) candidates.push({ kind: "id", sel: "#" + esc(node.id) });
    const nameAttr = node.getAttribute && node.getAttribute("name");
    if (nameAttr) candidates.push({ kind: "name", sel: `${tag}[name="${attrVal(nameAttr)}"]` });
    const aria = node.getAttribute && node.getAttribute("aria-label");
    if (aria) {
      const sel = `${tag}[aria-label="${attrVal(aria)}"]`;
      out.aria = sel;
      candidates.push({ kind: "aria", sel });
    }

    const path = cssPath(node);
    out.css = path;
    for (const c of candidates) {
      if (unique(scope, c.sel)) return { selectors: out, selector: c.sel, kind: c.kind, unique: true };
    }
    const fallback = candidates[0];
    if (path && unique(scope, path)) return { selectors: out, selector: path, kind: "path", unique: true };
    if (fallback) return { selectors: out, selector: fallback.sel, kind: fallback.kind, unique: false };
    return { selectors: out, selector: path, kind: "path", unique: false };
  }

  function ancestorsOf(node) {
    const out = [];
    let cur = node.parentElement;
    while (cur && out.length < 5) {
      let s = cur.localName;
      if (cur.id && !AUTO_ID.test(cur.id)) s += "#" + cur.id;
      else {
        const cls = stableClasses(cur);
        if (cls.length) s += "." + cls.join(".");
      }
      out.unshift(s);
      cur = cur.parentElement;
    }
    return out;
  }

  const ATTRS_OF_INTEREST = ["href", "type", "name", "placeholder", "title", "alt", "role", "aria-label", "disabled", "src"];

  function describe(node) {
    const s = selectorsFor(node);
    const r = node.getBoundingClientRect();
    const attrs = {};
    for (const a of ATTRS_OF_INTEREST) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v != null && v !== "") attrs[a] = tidy(v, 200);
    }
    if (node.value != null && String(node.value) !== "") attrs.value = tidy(node.value, 200);
    return {
      tag: node.localName,
      role: roleOf(node),
      name: accessibleName(node),
      text: tidy(node.innerText || node.textContent, 400),
      selector: s.selector,
      selector_kind: s.kind,
      unique: s.unique,
      shadow: node.getRootNode() !== document,
      selectors: { ...s.selectors, text: tidy(node.innerText || node.textContent, 120) },
      attrs,
      ancestors: ancestorsOf(node),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      page: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
    };
  }

  function describeShort(node) {
    let s = node.localName;
    if (node.id) s += "#" + node.id;
    const cls = stableClasses(node);
    if (cls.length) s += "." + cls.join(".");
    const name = accessibleName(node);
    if (name) s += ` "${name.slice(0, 40)}"`;
    const r = node.getBoundingClientRect();
    return `${s} · ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  // -------------------------------------------------------- element lookup --

  // resolve finds the element an annotation refers to, trying each recorded
  // selector in turn. Selectors rot as pages change; reporting *which* strategy
  // worked (or that none did) is what lets the AI trust the answer.
  const MISS_BACKOFF_MS = 3000;

  function resolve(ann) {
    const cached = resolvedCache.get(ann.id);
    if (cached && cached.isConnected) return { el: cached, strategy: "cache" };
    // A failed lookup can be expensive (XPath + deep shadow scan). Do not repeat
    // it on every layout tick for an element that has genuinely gone.
    const missedAt = missCache.get(ann.id);
    if (missedAt && Date.now() - missedAt < MISS_BACKOFF_MS) {
      return { el: null, strategy: "none", matches: 0 };
    }
    const found = lookup(ann);
    if (found.el) {
      resolvedCache.set(ann.id, found.el);
      missCache.delete(ann.id);
    } else {
      resolvedCache.delete(ann.id);
      missCache.set(ann.id, Date.now());
    }
    return found;
  }

  // collectRoots walks open shadow roots. Only used as a fallback for elements
  // that were annotated inside a shadow tree — a plain document query cannot
  // see them, and a blind deep scan on every frame would be far too expensive.
  function collectRoots(limit) {
    const cap = limit || 4000;
    const roots = [];
    const queue = [document];
    let seen = 0;
    while (queue.length && seen < cap) {
      const r = queue.shift();
      roots.push(r);
      let all;
      try {
        all = r.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const n of all) {
        if (++seen > cap) break;
        if (n.shadowRoot) queue.push(n.shadowRoot);
      }
    }
    return roots;
  }

  function queryAllDeep(sel) {
    const out = [];
    for (const r of collectRoots()) {
      try {
        for (const n of r.querySelectorAll(sel)) out.push(n);
      } catch {
        return out;
      }
    }
    return out;
  }

  function lookup(ann) {
    const e = (ann && ann.element) || {};
    const deep = !!e.shadow;
    const tries = [
      ["selector", e.selector],
      ["testid", e.selectors && e.selectors.testid],
      ["aria", e.selectors && e.selectors.aria],
      ["css", e.selectors && e.selectors.css],
    ];
    for (const [strategy, sel] of tries) {
      if (!sel) continue;
      let found = [];
      try {
        found = [...document.querySelectorAll(sel)];
        if (!found.length && deep) found = queryAllDeep(sel);
      } catch {
        continue;
      }
      if (found.length === 1) return { el: found[0], strategy, matches: 1, selector: sel };
      if (found.length > 1) {
        const byText = e.text ? found.find((n) => tidy(n.innerText || n.textContent, 400) === e.text) : null;
        return { el: byText || found[0], strategy, matches: found.length, selector: sel, ambiguous: !byText };
      }
    }
    const xp = e.selectors && e.selectors.xpath;
    if (xp) {
      try {
        const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (r && r.singleNodeValue) return { el: r.singleNodeValue, strategy: "xpath", matches: 1, selector: xp };
      } catch {
        /* malformed xpath */
      }
    }
    if (e.text && e.tag) {
      const cands = [...document.getElementsByTagName(e.tag)].filter(
        (n) => tidy(n.innerText || n.textContent, 400) === e.text
      );
      if (cands.length) {
        return { el: cands[0], strategy: "text", matches: cands.length, selector: `${e.tag} :text("${e.text.slice(0, 40)}")` };
      }
    }
    return { el: null, strategy: "none", matches: 0 };
  }

  // ------------------------------------------------------------ highlights --

  function showHighlight(node) {
    ensureHost();
    const r = node.getBoundingClientRect();
    const h = ui.highlight;
    h.classList.remove("hidden", "flash");
    h.style.left = r.left + "px";
    h.style.top = r.top + "px";
    h.style.width = r.width + "px";
    h.style.height = r.height + "px";
    const lab = ui.label;
    // The label names whatever is under the cursor. Once a card is open the
    // element is already named in the card's header, and the label only ends up
    // underneath it — so drop it rather than draw it behind.
    if (composerOpen || (ui.card && ui.card.el)) {
      lab.classList.add("hidden");
      return;
    }
    lab.classList.remove("hidden");
    lab.textContent = describeShort(node);
    const above = r.top > 24;
    lab.style.left = Math.max(2, Math.min(r.left, window.innerWidth - 330)) + "px";
    lab.style.top = (above ? r.top - 22 : Math.min(r.bottom + 4, window.innerHeight - 24)) + "px";
  }

  function hideHighlight() {
    if (!ui) return;
    ui.highlight.classList.add("hidden");
    ui.label.classList.add("hidden");
  }

  function flash(node) {
    ensureHost();
    const r = node.getBoundingClientRect();
    const box = el("div", "box flash");
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    // Not the pin layer — that one is rebuilt on every layout tick.
    ui.panelHost.appendChild(box);
    setTimeout(() => {
      box.remove();
      if (!mode && !composerOpen) teardownHost();
    }, 2400);
  }

  // ----------------------------------------------------------------- pins ---

  function renderPins() {
    if (!ui) return;
    ui.pins.textContent = "";
    updateBar();
    if (!mode || !pinsVisible) return;
    for (const ann of items) {
      const res = resolve(ann);
      const pin = el("button", "pin", String(ann.id).replace(/^a/, ""));
      pin.setAttribute("type", "button");
      pin.title = ann.comment ? ann.comment.slice(0, 160) : ann.id;
      if (ann.status === "resolved") pin.classList.add("resolved");
      if (!res.el) {
        pin.classList.add("lost");
        pin.style.left = "-9999px";
        pin.style.top = "-9999px";
      } else {
        const r = res.el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
          pin.style.left = "-9999px";
          pin.style.top = "-9999px";
        } else {
          pin.style.left = Math.max(0, Math.min(r.left - 8, window.innerWidth - 30)) + "px";
          pin.style.top = Math.max(0, Math.min(r.top - 8, window.innerHeight - 30)) + "px";
        }
      }
      pin.addEventListener("click", (e) => {
        stopAll(e);
        openViewer(ann, res.el);
      });
      pin.addEventListener("mouseenter", () => {
        if (res.el) showHighlight(res.el);
      });
      pin.addEventListener("mouseleave", hideHighlight);
      ui.pins.appendChild(pin);
    }
  }

  function scheduleLayout() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!mode) return;
      // Single-page apps sometimes replace <body> wholesale, taking our overlay
      // with it; rebuild rather than silently stop painting.
      ensureHost();
      renderPins();
      if (picked) showHighlight(picked);
      // Keep an open card glued to its element as the page scrolls.
      if (ui && ui.card) positionCard(ui.card.el, anchorRect(ui.card.node));
    });
  }

  // ---------------------------------------------------------------- cards ---

  function closeCard() {
    if (ui && ui.card) {
      ui.card.el.remove();
      ui.card = null;
    }
    composerOpen = false;
    picked = null;
    hideHighlight();
  }

  function positionCard(card, rect) {
    const margin = 12;
    const w = card.offsetWidth || 320;
    const h = card.offsetHeight || 220;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 8);
    if (top < margin) top = margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  // anchorRect is where a card should hang: the element's box when it is still
  // in the document, otherwise a fixed spot near the top-left.
  function anchorRect(node) {
    if (node && node.isConnected) {
      const r = node.getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return { left: 40, top: 40, bottom: 60 };
  }

  function mountCard(card, node) {
    ensureHost();
    if (ui.card) ui.card.el.remove();
    ui.panelHost.appendChild(card);
    ui.card = { el: card, node: node || null };
    positionCard(card, anchorRect(node));
  }

  function openComposer(node) {
    picked = node;
    composerOpen = true;
    showHighlight(node);

    const card = el("div", "card");
    const target = el("div", "target", describeShort(node));
    const ta = el("textarea");
    ta.placeholder = "What is wrong here, or what should change?";
    const chips = el("div", "chips");
    const chosen = new Set();
    for (const t of TAGS) {
      const chip = el("button", "chip", t);
      chip.setAttribute("type", "button");
      chip.addEventListener("click", (e) => {
        stopAll(e);
        if (chosen.has(t)) {
          chosen.delete(t);
          chip.dataset.on = "0";
        } else {
          chosen.add(t);
          chip.dataset.on = "1";
        }
      });
      chips.appendChild(chip);
    }
    const row = el("div", "row");
    const parent = el("button", "btn", "Parent ⌥↑");
    const spacer = el("div", "spacer");
    const cancel = el("button", "btn", "Cancel");
    const save = el("button", "btn primary", "Save ⌘↵");
    row.append(parent, spacer, cancel, save);
    card.append(target, ta, chips, row);
    mountCard(card, node);
    ta.focus();

    parent.addEventListener("click", (e) => {
      stopAll(e);
      const p = picked && picked.parentElement;
      if (!p) return;
      const text = ta.value;
      closeCard();
      openComposer(p);
      const nextTa = ui.card.el.querySelector("textarea");
      nextTa.value = text;
      nextTa.focus();
    });
    cancel.addEventListener("click", (e) => {
      stopAll(e);
      closeCard();
    });
    save.addEventListener("click", (e) => {
      stopAll(e);
      submit(ta.value, [...chosen], node);
    });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit(ta.value, [...chosen], node);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeCard();
      }
    });
  }

  function openViewer(ann, node) {
    const card = el("div", "card");
    const target = el("div", "target", ann.element ? `${ann.element.tag} — ${ann.element.selector}` : ann.id);
    const body = el("div", "body", ann.comment || "");
    card.append(target, body);
    if (ann.tags && ann.tags.length) {
      const chips = el("div", "chips");
      for (const t of ann.tags) {
        const chip = el("span", "chip");
        chip.dataset.on = "1";
        chip.textContent = t;
        chips.appendChild(chip);
      }
      card.appendChild(chips);
    }
    if (ann.note) card.appendChild(el("div", "note", "AI: " + ann.note));
    card.appendChild(
      el("div", "meta", `${ann.id} · ${ann.status}${node ? "" : " · element not found on this page"}`)
    );

    const row = el("div", "row");
    const del = el("button", "btn danger", "Delete");
    const spacer = el("div", "spacer");
    const close = el("button", "btn", "Close");
    const toggle = el("button", "btn primary", ann.status === "resolved" ? "Reopen" : "Resolve");
    row.append(del, spacer, close, toggle);
    card.appendChild(row);
    mountCard(card, node);
    if (node) showHighlight(node);

    del.addEventListener("click", async (e) => {
      stopAll(e);
      await send({ type: "OWB_ANN_DELETE", id: ann.id });
      closeCard();
    });
    close.addEventListener("click", (e) => {
      stopAll(e);
      closeCard();
    });
    toggle.addEventListener("click", async (e) => {
      stopAll(e);
      await send({
        type: "OWB_ANN_UPDATE",
        id: ann.id,
        status: ann.status === "resolved" ? "open" : "resolved",
      });
      closeCard();
    });
  }

  async function submit(text, tags, node) {
    const comment = String(text || "").trim();
    if (!comment) {
      const ta = ui.card && ui.card.el.querySelector("textarea");
      if (ta) ta.focus();
      return;
    }
    const element = describe(node);
    closeCard();
    // Hide our own overlay so it never ends up inside the element screenshot.
    if (host) host.style.visibility = "hidden";
    await twoFrames();
    const res = await send({
      type: "OWB_ANN_ADD",
      input: {
        comment,
        tags,
        url: location.href,
        title: document.title,
        frame_url: location.href,
        top_frame: IS_TOP,
        element,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      },
    });
    if (host) host.style.visibility = "";
    if (res && res.error) console.warn("[owb] annotation not saved:", res.error);
  }

  function twoFrames() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  // ---------------------------------------------------------------- events --

  function fromOverlay(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return host ? path.includes(host) || (e.target && host.contains(e.target)) : false;
  }

  function pickTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) {
      if (n === host) return null;
      if (n && n.nodeType === 1 && n !== document.documentElement) return n;
    }
    return e.target && e.target.nodeType === 1 ? e.target : null;
  }

  function onMove(e) {
    if (!mode || composerOpen || fromOverlay(e)) return;
    const node = pickTarget(e);
    if (!node || node === hovered) return;
    hovered = node;
    showHighlight(node);
  }

  function onClick(e) {
    if (!mode || fromOverlay(e)) return;
    stopAll(e);
    if (composerOpen) {
      closeCard();
      return;
    }
    const node = pickTarget(e);
    if (node) openComposer(node);
  }

  function swallow(e) {
    if (!mode || fromOverlay(e)) return;
    stopAll(e);
  }

  function onKey(e) {
    if (!mode) return;
    if (e.key === "Escape") {
      stopAll(e);
      if (composerOpen || (ui && ui.card)) {
        closeCard();
      } else {
        send({ type: "OWB_ANN_STOP" });
        setMode(false);
      }
      return;
    }
    if (e.altKey && e.key === "ArrowUp" && hovered && hovered.parentElement && !composerOpen) {
      stopAll(e);
      hovered = hovered.parentElement;
      showHighlight(hovered);
    }
  }

  function stopAll(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  const listeners = [
    ["mousemove", onMove, true],
    ["click", onClick, true],
    ["mousedown", swallow, true],
    ["mouseup", swallow, true],
    ["pointerdown", swallow, true],
    ["pointerup", swallow, true],
    ["dblclick", swallow, true],
    ["contextmenu", swallow, true],
    ["keydown", onKey, true],
  ];

  function addListeners() {
    for (const [type, fn, capture] of listeners) {
      document.addEventListener(type, fn, capture);
    }
    window.addEventListener("scroll", scheduleLayout, true);
    window.addEventListener("resize", scheduleLayout);
  }

  function removeListeners() {
    for (const [type, fn, capture] of listeners) {
      document.removeEventListener(type, fn, capture);
    }
    window.removeEventListener("scroll", scheduleLayout, true);
    window.removeEventListener("resize", scheduleLayout);
  }

  // ------------------------------------------------------------ lifecycle ---

  function setMode(on) {
    if (on === mode) {
      if (on) renderPins();
      return;
    }
    mode = on;
    if (on) {
      ensureHost();
      addListeners();
      // Pages relayout constantly (lazy images, async content); a slow tick
      // keeps pins glued to their elements without a MutationObserver storm.
      layoutTimer = setInterval(scheduleLayout, 700);
      renderPins();
    } else {
      removeListeners();
      clearInterval(layoutTimer);
      layoutTimer = null;
      closeCard();
      teardownHost();
      hovered = null;
      resolvedCache.clear();
      missCache.clear();
    }
  }

  function teardownHost() {
    if (host) host.remove();
    host = null;
    root = null;
    ui = null;
  }

  function destroy() {
    setMode(false);
    chrome.runtime.onMessage.removeListener(onMessage);
    delete window.__owbAnnotator;
  }

  function send(msg) {
    return new Promise((resolve2) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve2(res || null);
        });
      } catch {
        resolve2(null);
      }
    });
  }

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg.type !== "string") return undefined;
    switch (msg.type) {
      case "OWB_ANN_SET_MODE":
        if (msg.on) setMode(true);
        else destroy();
        sendResponse({ ok: true });
        return undefined;
      case "OWB_ANN_SYNC":
        items = Array.isArray(msg.annotations) ? msg.annotations : [];
        resolvedCache.clear();
        missCache.clear();
        renderPins();
        sendResponse({ ok: true, count: items.length });
        return undefined;
      case "OWB_ANN_LOCATE": {
        const res = lookup(msg.annotation || {});
        if (res.el) {
          if (msg.scroll !== false) res.el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
          if (msg.flash !== false) setTimeout(() => flash(res.el), 220);
        }
        const r = res.el ? res.el.getBoundingClientRect() : null;
        sendResponse({
          found: !!res.el,
          strategy: res.strategy,
          matches: res.matches || 0,
          selector: res.selector || "",
          ambiguous: !!res.ambiguous,
          url: location.href,
          rect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
          visible: r ? r.width > 0 && r.height > 0 : false,
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  function rearm() {
    // Re-injection while already loaded: re-ask the worker for the current
    // state instead of building a second overlay.
    announce();
  }

  async function announce() {
    const res = await send({ type: "OWB_ANN_READY", url: location.href, top: IS_TOP });
    if (!res) return;
    items = Array.isArray(res.annotations) ? res.annotations : [];
    setMode(!!res.mode);
    renderPins();
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.__owbAnnotator = { rearm, destroy };
  announce();
})();
