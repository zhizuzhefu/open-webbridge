// model.js — pure data rules for the annotation store: record shape,
// sanitising, filtering, pruning, and the wire projection sent back to the AI.
//
// Deliberately free of chrome.* APIs so every rule here is unit-testable under
// plain node (see model.test.js). store.js owns the I/O; this file owns the
// semantics.

// A browser profile is a long-lived place. Cap the store so a forgotten
// annotation session can never grow without bound.
export const MAX_ANNOTATIONS = 500;
// Screenshots dominate the storage quota, so far fewer are retained than
// comments. Dropping an image never drops its annotation.
export const MAX_SHOTS = 30;

export const DEFAULT_WAIT_MS = 60000;
export const MAX_WAIT_MS = 240000;

const MAX_COMMENT = 4000;
const MAX_NOTE = 4000;
const MAX_TAGS = 6;
const MAX_TAG_LEN = 24;

// urlKey normalises a URL for "same page" comparisons: the fragment is dropped
// (in-page anchors are not a different page) but the query is kept (it usually
// selects different content).
export function urlKey(url) {
  try {
    const u = new URL(String(url));
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

function clip(v, max) {
  const s = v == null ? "" : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

export function sanitizeComment(text) {
  return clip(text, MAX_COMMENT).trim();
}

export function sanitizeNote(text) {
  return clip(text, MAX_NOTE).trim();
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = clip(t, MAX_TAG_LEN).trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function rect(r) {
  if (!r || typeof r !== "object") return null;
  return { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) };
}

// sanitizeElement bounds every string coming out of the page. The annotator
// runs inside untrusted pages, so nothing it reports is taken on length faith.
export function sanitizeElement(el) {
  const e = el && typeof el === "object" ? el : {};
  const selectors = e.selectors && typeof e.selectors === "object" ? e.selectors : {};
  const attrs = e.attrs && typeof e.attrs === "object" ? e.attrs : {};
  const outAttrs = {};
  for (const k of Object.keys(attrs).slice(0, 12)) {
    const key = clip(k, 40).trim();
    const v = clip(attrs[k], 200);
    if (key && v) outAttrs[key] = v;
  }
  return {
    tag: clip(e.tag, 40).toLowerCase(),
    role: clip(e.role, 40),
    name: clip(e.name, 200),
    text: clip(e.text, 400),
    selector: clip(e.selector, 600),
    selector_kind: clip(e.selector_kind, 20),
    unique: !!e.unique,
    shadow: !!e.shadow,
    selectors: {
      css: clip(selectors.css, 600),
      xpath: clip(selectors.xpath, 600),
      testid: clip(selectors.testid, 200),
      aria: clip(selectors.aria, 200),
      text: clip(selectors.text, 200),
    },
    attrs: outAttrs,
    ancestors: Array.isArray(e.ancestors) ? e.ancestors.slice(0, 6).map((a) => clip(a, 120)) : [],
    rect: rect(e.rect),
    page: rect(e.page),
  };
}

// makeRecord turns a raw in-page submission into the stored record. `now` is
// injected so tests are deterministic.
export function makeRecord({ seq, input, tabId, session, now }) {
  const src = input && typeof input === "object" ? input : {};
  const at = new Date(now == null ? Date.now() : now).toISOString();
  const url = clip(src.url, 2000);
  return {
    id: `a${seq}`,
    seq,
    created_at: at,
    updated_at: at,
    status: "open",
    comment: sanitizeComment(src.comment),
    tags: normalizeTags(src.tags),
    note: "",
    url,
    url_key: urlKey(url),
    title: clip(src.title, 300),
    tabId: tabId == null ? null : Number(tabId),
    session: clip(session, 120) || null,
    frame_url: src.top_frame === false ? clip(src.frame_url, 2000) : "",
    top_frame: src.top_frame !== false,
    element: sanitizeElement(src.element),
    viewport: src.viewport && typeof src.viewport === "object"
      ? { w: num(src.viewport.w), h: num(src.viewport.h), dpr: num(src.viewport.dpr) }
      : null,
    has_screenshot: false,
  };
}

// filterAnnotations applies the query the AI (or the in-page renderer) asked
// for. Results come back in creation order; `limit` keeps the newest N.
export function filterAnnotations(items, filter = {}) {
  const status = filter.status || "open";
  const ids = Array.isArray(filter.ids) && filter.ids.length
    ? new Set(filter.ids.map((v) => String(v).trim()))
    : null;
  const url = filter.url ? String(filter.url).toLowerCase() : "";
  const tag = filter.tag ? String(filter.tag).toLowerCase() : "";
  const tabId = filter.tabId == null ? null : Number(filter.tabId);
  const sinceRaw = filter.since == null ? null : Number(filter.since);
  const since = Number.isFinite(sinceRaw) ? sinceRaw : null;

  let out = (items || []).filter((it) => {
    if (!it) return false;
    if (ids && !ids.has(it.id)) return false;
    if (status !== "all" && it.status !== status) return false;
    if (url && !String(it.url || "").toLowerCase().includes(url)) return false;
    if (tag && !(it.tags || []).some((t) => String(t).toLowerCase() === tag)) return false;
    if (tabId != null && Number(it.tabId) !== tabId) return false;
    if (since != null && !(Number(it.seq) > since)) return false;
    return true;
  });

  out.sort((a, b) => a.seq - b.seq);
  const limit = Number(filter.limit);
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) {
    out = out.slice(out.length - limit);
  }
  return out;
}

// toWire projects a stored record into what the AI receives. The compact form
// is the default because a list of 30 annotations should not cost more context
// than the page snapshot they refer to.
export function toWire(item, { verbose = false } = {}) {
  const el = item.element || {};
  const out = {
    id: item.id,
    seq: item.seq,
    status: item.status,
    comment: item.comment,
    created_at: item.created_at,
    url: item.url,
    title: item.title,
    tabId: item.tabId,
    element: {
      tag: el.tag,
      name: el.name,
      text: el.text,
      selector: el.selector,
      unique: el.unique,
    },
    has_screenshot: !!item.has_screenshot,
  };
  if (item.tags && item.tags.length) out.tags = item.tags;
  if (item.note) out.note = item.note;
  if (item.status === "resolved") out.updated_at = item.updated_at;
  if (item.session) out.session = item.session;
  if (!item.top_frame && item.frame_url) out.frame_url = item.frame_url;
  if (el.role) out.element.role = el.role;
  if (verbose) {
    out.element.selectors = el.selectors;
    out.element.selector_kind = el.selector_kind;
    out.element.attrs = el.attrs;
    out.element.ancestors = el.ancestors;
    out.element.shadow = el.shadow;
    out.element.rect = el.rect;
    out.element.page = el.page;
    out.viewport = item.viewport;
    out.url_key = item.url_key;
    out.top_frame = item.top_frame;
  }
  return out;
}

// pruneItems keeps the newest `max` records.
export function pruneItems(items, max = MAX_ANNOTATIONS) {
  const list = (items || []).slice().sort((a, b) => a.seq - b.seq);
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

// shotIdsToKeep decides which screenshots survive: the newest `max` that still
// have a live annotation. Everything else is evictable — the comment stays.
export function shotIdsToKeep(items, shotIds, max = MAX_SHOTS) {
  const bySeq = new Map();
  for (const it of items || []) bySeq.set(it.id, Number(it.seq) || 0);
  const live = (shotIds || []).filter((id) => bySeq.has(id));
  live.sort((a, b) => bySeq.get(a) - bySeq.get(b));
  return new Set(live.slice(Math.max(0, live.length - max)));
}

export function stats(items) {
  const list = items || [];
  let open = 0;
  let resolved = 0;
  let shots = 0;
  const urls = new Map();
  for (const it of list) {
    if (it.status === "resolved") resolved++;
    else open++;
    if (it.has_screenshot) shots++;
    const k = it.url_key || it.url || "";
    urls.set(k, (urls.get(k) || 0) + 1);
  }
  return {
    total: list.length,
    open,
    resolved,
    with_screenshot: shots,
    pages: [...urls.entries()].map(([url, count]) => ({ url, count })),
  };
}

// clampWait bounds a long-poll request so a caller can never park a tool_call
// past the daemon's own 5-minute command timeout.
export function clampWait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(n, 250), MAX_WAIT_MS);
}
