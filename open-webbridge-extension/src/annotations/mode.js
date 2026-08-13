// mode.js — owns "annotation mode" for a tab: on-demand injection of the
// in-page annotator, the frame bookkeeping needed to keep pins in sync, and the
// element screenshot capture.
//
// Injection is deliberately on demand (chrome.scripting) rather than a manifest
// content script: Open WebBridge should run no code at all in pages the user
// has not explicitly opted in, and stopping the mode tears the overlay down so
// the page is left exactly as it was found.

import { urlKey } from "./model.js";
import * as store from "./store.js";
import { sessionForTab } from "../sessions.js";

const KEY_MODES = "owb_ann_modes";
// Same file name in the source tree and in dist/ (see build.mjs), so the
// injection path does not depend on how the extension was loaded.
const ANNOTATOR_FILE = "annotator.js";

const active = new Set(); // tabIds currently in annotation mode
const frames = new Map(); // tabId -> Map<frameId, url>
let restored = false;

// restore re-reads the mode set after a service-worker restart. Chrome keeps
// the tabs alive across a worker suspend, so without this a user who annotates,
// walks away, and comes back finds a dead overlay.
async function restore() {
  if (restored) return;
  restored = true;
  let saved = [];
  try {
    const got = await chrome.storage.local.get(KEY_MODES);
    saved = Array.isArray(got[KEY_MODES]) ? got[KEY_MODES] : [];
  } catch {
    return;
  }
  for (const tabId of saved) {
    try {
      await chrome.tabs.get(tabId);
      active.add(Number(tabId));
    } catch {
      /* tab is gone */
    }
  }
}

async function persistModes() {
  try {
    await chrome.storage.local.set({ [KEY_MODES]: [...active] });
  } catch {
    /* storage unavailable */
  }
}

export async function isActive(tabId) {
  await restore();
  return active.has(Number(tabId));
}

export async function activeTabs() {
  await restore();
  const out = [];
  for (const tabId of [...active]) {
    try {
      const t = await chrome.tabs.get(tabId);
      out.push({ tabId, url: t.url, title: t.title });
    } catch {
      active.delete(tabId);
    }
  }
  return out;
}

// start injects the annotator into every frame of the tab and switches it on.
export async function start(tabId) {
  await restore();
  const id = Number(tabId);
  const tab = await chrome.tabs.get(id);
  assertAnnotatable(tab);
  active.add(id);
  await persistModes();
  await inject(id);
  await broadcast(id, { type: "OWB_ANN_SET_MODE", on: true });
  await sync(id);
  return tab;
}

export async function stop(tabId) {
  await restore();
  const id = Number(tabId);
  const wasActive = active.delete(id);
  frames.delete(id);
  await persistModes();
  // Tell the page to tear the overlay down. Best effort: the tab may be gone,
  // or may never have been injected.
  await broadcast(id, { type: "OWB_ANN_SET_MODE", on: false });
  return wasActive;
}

export async function stopAll() {
  await restore();
  const ids = [...active];
  for (const id of ids) await stop(id);
  return ids.length;
}

export function handleTabRemoved(tabId) {
  active.delete(Number(tabId));
  frames.delete(Number(tabId));
  void persistModes();
}

// handleTabUpdated re-injects after a navigation/reload so the overlay and the
// existing pins come back on the new document.
export async function handleTabUpdated(tabId, changeInfo) {
  if (changeInfo.status !== "complete") return;
  await restore();
  if (!active.has(Number(tabId))) return;
  frames.delete(Number(tabId));
  try {
    await inject(tabId);
    await broadcast(tabId, { type: "OWB_ANN_SET_MODE", on: true });
    await sync(tabId);
  } catch {
    /* page may be a restricted URL now; leave the mode flag alone */
  }
}

function assertAnnotatable(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || "";
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url) ||
      /^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    throw new Error(`cannot annotate a browser-internal page (${url || "unknown"}) — open a normal web page first`);
  }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), allFrames: true },
    files: [ANNOTATOR_FILE],
    injectImmediately: true,
  });
}

async function broadcast(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(Number(tabId), msg);
  } catch {
    // No receiver (never injected, or the tab navigated away mid-flight).
  }
}

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(Number(tabId), msg, { frameId });
  } catch {
    return null;
  }
}

export function rememberFrame(tabId, frameId, url) {
  const id = Number(tabId);
  let m = frames.get(id);
  if (!m) {
    m = new Map();
    frames.set(id, m);
  }
  m.set(Number(frameId) || 0, url || "");
}

// annotationsForUrl returns the records a frame should render as pins.
export async function annotationsForUrl(url) {
  const key = urlKey(url);
  const items = await store.list({ status: "all" });
  return items.filter((it) => it.url_key === key);
}

// sync pushes the current pin set to each frame that has announced itself, so
// the human sees an AI-side resolve/clear land on the page immediately.
export async function sync(tabId) {
  const id = Number(tabId);
  const m = frames.get(id);
  if (!m || m.size === 0) return;
  for (const [frameId, url] of m.entries()) {
    const annotations = await annotationsForUrl(url);
    await sendToFrame(id, frameId, { type: "OWB_ANN_SYNC", annotations });
  }
}

// syncAll refreshes every tab in annotation mode. Called after AI-side changes
// (resolve / clear) so pages currently on screen update without a reload.
export async function syncAll() {
  await restore();
  for (const tabId of [...active]) await sync(tabId);
}

// addFromPage stores a submission coming from the in-page annotator and, when
// asked, grabs a cropped screenshot of the annotated element.
export async function addFromPage(tabId, input) {
  const record = await store.add({
    input,
    tabId,
    session: sessionForTab(tabId),
  });
  if (input && input.capture !== false) {
    try {
      const shot = await captureElement(tabId, input);
      if (shot) await store.setShot(record.id, shot);
    } catch (e) {
      console.warn("[owb] annotation screenshot failed", e && e.message);
    }
  }
  return store.get(record.id);
}

// locate asks the page whether an annotation's element can still be found, and
// optionally scrolls to and flashes it. This turns "the selector rotted" from a
// silent wrong-element click into an explicit, checkable result.
export async function locate(tabId, annotation, opts = {}) {
  await inject(tabId);
  // Give freshly injected frames a moment to announce themselves; without a
  // frame map we can still reach the top frame (frameId 0).
  await sleep(120);
  const m = frames.get(Number(tabId));
  const targets = m && m.size ? [...m.keys()] : [0];
  let fallback = { found: false, reason: "no frame answered" };
  for (const frameId of targets) {
    const res = await sendToFrame(tabId, frameId, {
      type: "OWB_ANN_LOCATE",
      annotation,
      scroll: opts.scroll !== false,
      flash: opts.flash !== false,
    });
    if (res && res.found) return { ...res, frameId };
    if (res) fallback = { ...res, frameId };
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// handlePageMessage services the in-page annotator. Every OWB_ANN_* message
// from a content script lands here; background.js just routes to it.
export async function handlePageMessage(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const frameId = sender && sender.frameId != null ? sender.frameId : 0;
  const url = (msg && msg.url) || (sender && sender.url) || "";

  switch (msg.type) {
    case "OWB_ANN_READY": {
      if (tabId == null) return { mode: false, annotations: [] };
      rememberFrame(tabId, frameId, url);
      const on = await isActive(tabId);
      return { mode: on, annotations: on ? await annotationsForUrl(url) : [] };
    }
    case "OWB_ANN_ADD": {
      if (tabId == null) return { error: "no tab" };
      const record = await addFromPage(tabId, msg.input);
      await sync(tabId);
      return { ok: true, id: record ? record.id : null };
    }
    case "OWB_ANN_UPDATE": {
      const changes = {};
      if (msg.status) changes.status = msg.status;
      if (msg.comment != null) changes.comment = msg.comment;
      await store.patch({ ids: [msg.id], status: "all" }, changes);
      if (tabId != null) await sync(tabId);
      return { ok: true };
    }
    case "OWB_ANN_DELETE": {
      await store.remove({ ids: [msg.id], status: "all" });
      if (tabId != null) await sync(tabId);
      return { ok: true };
    }
    case "OWB_ANN_STOP": {
      if (tabId != null) await stop(tabId);
      return { ok: true };
    }
    default:
      return { error: `unknown annotation message ${msg.type}` };
  }
}

const SHOT_PADDING = 24;
const SHOT_MAX_EDGE = 1280;
const SHOT_QUALITY = 0.72;

async function captureElement(tabId, input) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab || !tab.active) return null; // captureVisibleTab only sees the front tab
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  if (!dataUrl) return null;

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const vp = (input && input.viewport) || {};
  const rect = (input && input.element && input.element.rect) || null;

  // The capture covers the top-level viewport. Cropping to the element is only
  // sound when the rect is expressed in those same coordinates — i.e. the top
  // frame. Sub-frame annotations keep the full viewport shot, which is still
  // far more useful than nothing.
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (rect && input.top_frame !== false && vp.w > 0) {
    const scale = bitmap.width / vp.w;
    sx = Math.max(0, (rect.x - SHOT_PADDING) * scale);
    sy = Math.max(0, (rect.y - SHOT_PADDING) * scale);
    sw = Math.min(bitmap.width - sx, (rect.w + SHOT_PADDING * 2) * scale);
    sh = Math.min(bitmap.height - sy, (rect.h + SHOT_PADDING * 2) * scale);
    if (!(sw > 8 && sh > 8)) {
      sx = 0;
      sy = 0;
      sw = bitmap.width;
      sh = bitmap.height;
    }
  }

  const shrink = Math.min(1, SHOT_MAX_EDGE / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * shrink));
  const outH = Math.max(1, Math.round(sh * shrink));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: SHOT_QUALITY });
  return "data:image/jpeg;base64," + toBase64(await out.arrayBuffer());
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
