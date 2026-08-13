// annotate.js — the two AI-facing annotation tools.
//
//   annotate     turn the in-page annotation mode on/off for a tab, and locate
//                the element an existing annotation points at
//   annotations  read, resolve, and clear the notes a human left on the page
//
// The split is deliberate: `annotate` drives a *tab* (so it is session-scoped
// like every other page tool), while `annotations` reads the *store*, which is
// global and tab-independent — the daemon therefore exempts it from session
// serialisation so a long poll cannot block other work (see hub.go).

import { getActiveTab } from "../sessions.js";
import * as store from "../annotations/store.js";
import * as mode from "../annotations/mode.js";
import { DEFAULT_WAIT_MS, clampWait, toWire } from "../annotations/model.js";

const START_HINT =
  "Annotation mode is on: click any element on the page, type the note, ⌘/Ctrl+Enter to save. " +
  "Esc or the Done button ends it. Read the notes with `annotations`.";

async function tabAlive(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(Number(tabId));
    return true;
  } catch {
    return false;
  }
}

// resolveTab picks the tab to annotate: an explicit tabId, else the session's
// current tab, else whatever the user is actually looking at. The last case
// matters — a human turning this on is usually on a page the bridge never
// opened.
async function resolveTab(args, session) {
  if (args.tabId != null) {
    if (!(await tabAlive(args.tabId))) throw new Error(`tab ${args.tabId} is not open`);
    return Number(args.tabId);
  }
  if (args.target !== "active") {
    try {
      return getActiveTab(session);
    } catch {
      /* session has no tab; fall through to the focused one */
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id != null) return tab.id;
  throw new Error("no tab to annotate — open a page first (navigate), or pass tabId");
}

async function stateOf(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  const existing = await mode.annotationsForUrl(tab.url);
  return {
    tabId: Number(tabId),
    url: tab.url,
    title: tab.title,
    annotations_on_page: existing.length,
  };
}

export async function annotate(args, session) {
  const op = String(args.mode || "start").toLowerCase();

  if (op === "stop" && args.all) {
    const stopped = await mode.stopAll();
    return { success: true, mode: "off", stopped };
  }

  if (op === "status") {
    const active = await mode.activeTabs();
    const summary = await store.summary();
    return { success: true, active, annotating: active.length > 0, ...summary };
  }

  if (op === "locate") {
    return locate(args, session);
  }

  const tabId = await resolveTab(args, session);
  const on = await mode.isActive(tabId);

  switch (op) {
    case "start": {
      await mode.start(tabId);
      return { success: true, mode: "on", ...(await stateOf(tabId)), hint: START_HINT };
    }
    case "stop": {
      await mode.stop(tabId);
      return { success: true, mode: "off", ...(await stateOf(tabId)) };
    }
    case "toggle": {
      if (on) {
        await mode.stop(tabId);
        return { success: true, mode: "off", ...(await stateOf(tabId)) };
      }
      await mode.start(tabId);
      return { success: true, mode: "on", ...(await stateOf(tabId)), hint: START_HINT };
    }
    default:
      throw new Error(`unknown annotate mode "${op}" (use start | stop | toggle | status | locate)`);
  }
}

// locate answers "is this annotation's element still on the page, and where?".
// Selectors rot as pages change; this makes that visible instead of letting the
// AI act on a stale one.
async function locate(args, session) {
  const id = args.id || (Array.isArray(args.ids) ? args.ids[0] : null);
  if (!id) throw new Error("annotate {mode:\"locate\"} requires id (e.g. \"a3\")");
  const ann = await store.get(id);
  if (!ann) throw new Error(`no annotation ${id}`);

  let tabId = args.tabId != null ? Number(args.tabId) : null;
  if (tabId == null && (await tabAlive(ann.tabId))) tabId = Number(ann.tabId);
  if (tabId == null) tabId = await resolveTab(args, session);

  const tab = await chrome.tabs.get(tabId);
  const res = await mode.locate(tabId, ann, { scroll: args.scroll, flash: args.flash });
  return {
    success: true,
    id: ann.id,
    tabId,
    found: !!res.found,
    strategy: res.strategy || "none",
    matches: res.matches || 0,
    ambiguous: !!res.ambiguous,
    visible: !!res.visible,
    rect: res.rect || null,
    selector_used: res.selector || "",
    selector_recorded: (ann.element && ann.element.selector) || "",
    page_url: tab.url,
    recorded_url: ann.url,
    same_page: ann.url_key === (res.url ? urlKeyOf(res.url) : ""),
  };
}

function urlKeyOf(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

const STATUSES = new Set(["open", "resolved", "all"]);

function normalizeStatus(value, fallback) {
  const s = String(value || "").toLowerCase();
  return STATUSES.has(s) ? s : fallback;
}

function idsOf(args) {
  if (Array.isArray(args.ids) && args.ids.length) return args.ids;
  if (args.id) return [args.id];
  return null;
}

function buildFilter(args, defaultStatus) {
  return {
    status: normalizeStatus(args.status, defaultStatus),
    url: args.url,
    tabId: args.tabId,
    tag: args.tag,
    ids: idsOf(args),
    since: args.since,
    limit: args.limit,
  };
}

export async function annotations(args) {
  const op = String(args.op || "list").toLowerCase();
  switch (op) {
    case "list":
      return listOp(args);
    case "get":
      return listOp({ ...args, status: "all", verbose: args.verbose !== false });
    case "clear":
    case "delete":
      return clearOp(args);
    case "resolve":
      return patchOp(args, "resolved");
    case "reopen":
      return patchOp(args, "open");
    case "note":
      return patchOp(args, null);
    case "screenshot":
      return screenshotOp(args);
    case "stats":
      return statsOp();
    default:
      throw new Error(
        `unknown annotations op "${op}" (use list | get | clear | delete | resolve | reopen | note | screenshot | stats)`
      );
  }
}

async function listOp(args) {
  const filter = buildFilter(args, "open");
  const wait = clampWait(args.wait_ms == null ? 0 : args.wait_ms === true ? DEFAULT_WAIT_MS : args.wait_ms);
  const found = wait > 0 ? await store.waitForNew(filter, wait) : await store.list(filter);
  const verbose = !!args.verbose;
  return {
    success: true,
    count: found.length,
    annotations: found.map((it) => toWire(it, { verbose })),
    cursor: await store.maxSeq(),
    waited_ms: wait || undefined,
    timed_out: wait > 0 && found.length === 0 ? true : undefined,
    ...(await statusLine()),
  };
}

async function clearOp(args) {
  const filter = buildFilter(args, "all");
  const res = await store.remove(filter);
  await mode.syncAll();
  return { success: true, cleared: res.removed, remaining: res.remaining };
}

function hasTargeting(args) {
  return !!(idsOf(args) || args.url || args.tag || args.tabId != null || args.since != null);
}

// patchOp is how the AI closes the loop: mark the note handled and leave a
// reply the human sees on the page itself.
async function patchOp(args, status) {
  // Resolving is per-note by nature. An unfiltered call would silently close
  // every note the human left, so make "all of them" an explicit choice.
  if (!hasTargeting(args) && !args.all) {
    throw new Error("pass ids (e.g. {\"ids\":[\"a3\"]}) or a url/tag filter — or all:true to apply to every annotation");
  }
  const filter = buildFilter(args, "all");
  const changes = {};
  if (status) changes.status = status;
  if (args.note != null) changes.note = args.note;
  if (args.comment != null) changes.comment = args.comment;
  if (!status && args.note == null && args.comment == null) {
    throw new Error("nothing to change — pass note (and/or comment)");
  }
  const updated = await store.patch(filter, changes);
  await mode.syncAll();
  return {
    success: true,
    updated: updated.length,
    annotations: updated.map((it) => toWire(it)),
  };
}

async function screenshotOp(args) {
  const id = args.id || (Array.isArray(args.ids) ? args.ids[0] : null);
  if (!id) throw new Error("annotations {op:\"screenshot\"} requires id");
  const ann = await store.get(id);
  if (!ann) throw new Error(`no annotation ${id}`);
  const shot = await store.getShot(id);
  if (!shot) {
    throw new Error(`annotation ${id} has no screenshot (it may have been evicted to save space)`);
  }
  return {
    success: true,
    ann_id: ann.id,
    format: "jpeg",
    file_name: `annotation_${ann.id}`,
    data: String(shot).replace(/^data:[^,]*,/, ""),
  };
}

async function statsOp() {
  const summary = await store.summary();
  const active = await mode.activeTabs();
  return { success: true, ...summary, annotating: active };
}

async function statusLine() {
  const summary = await store.summary();
  const active = await mode.activeTabs();
  return {
    total: summary.total,
    open: summary.open,
    resolved: summary.resolved,
    annotating: active.map((a) => a.tabId),
  };
}
