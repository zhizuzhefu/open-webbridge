// store.js — the annotation store, owned by the service worker and persisted in
// chrome.storage.local. This is the single source of truth: the daemon holds no
// annotation state and pulls from here on demand, which keeps the daemon
// stateless and lets a human keep annotating while the daemon is stopped.
//
// Two storage keys, deliberately separate:
//   owb_annotations  — { seq, items[] }   small, always loaded
//   owb_ann_shots    — { id: dataUrl }    heavy, capped, evicted oldest-first
//
// Screenshots are evictable; comments are not.

import {
  MAX_ANNOTATIONS,
  MAX_SHOTS,
  filterAnnotations,
  makeRecord,
  pruneItems,
  sanitizeComment,
  sanitizeNote,
  shotIdsToKeep,
  stats,
} from "./model.js";

const KEY_ITEMS = "owb_annotations";
const KEY_SHOTS = "owb_ann_shots";

let cache = null; // { seq, items }
let shots = null; // { [id]: dataUrl }
let loading = null;
let revision = 0; // bumped on every mutation; long-polls watch it

async function load() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    let got = {};
    try {
      got = await chrome.storage.local.get([KEY_ITEMS, KEY_SHOTS]);
    } catch {
      /* storage unavailable; start empty */
    }
    const raw = got[KEY_ITEMS];
    cache = raw && Array.isArray(raw.items)
      ? { seq: Number(raw.seq) || raw.items.length, items: raw.items }
      : { seq: 0, items: [] };
    shots = got[KEY_SHOTS] && typeof got[KEY_SHOTS] === "object" ? got[KEY_SHOTS] : {};
    loading = null;
    return cache;
  })();
  return loading;
}

async function persistItems() {
  try {
    await chrome.storage.local.set({ [KEY_ITEMS]: cache });
  } catch (e) {
    console.warn("[owb] annotation save failed", e);
  }
}

async function persistShots() {
  try {
    await chrome.storage.local.set({ [KEY_SHOTS]: shots });
  } catch (e) {
    // Quota is the expected failure here. Drop the oldest half and retry once —
    // losing images is acceptable, losing comments is not.
    const ids = Object.keys(shots);
    for (const id of ids.slice(0, Math.ceil(ids.length / 2))) delete shots[id];
    try {
      await chrome.storage.local.set({ [KEY_SHOTS]: shots });
    } catch {
      console.warn("[owb] annotation screenshot save failed", e);
    }
  }
}

function touch() {
  revision++;
}

export function currentRevision() {
  return revision;
}

export async function all() {
  const c = await load();
  return c.items;
}

export async function list(filter) {
  const c = await load();
  return filterAnnotations(c.items, filter);
}

export async function summary() {
  const c = await load();
  return stats(c.items);
}

export async function maxSeq() {
  const c = await load();
  return c.seq;
}

// add stores a submission from the in-page annotator and returns the record.
export async function add({ input, tabId, session }) {
  const c = await load();
  c.seq += 1;
  const record = makeRecord({ seq: c.seq, input, tabId, session });
  if (!record.comment) throw new Error("annotation comment is empty");
  c.items.push(record);
  c.items = pruneItems(c.items, MAX_ANNOTATIONS);
  touch();
  await persistItems();
  return record;
}

export async function get(id) {
  const c = await load();
  return c.items.find((it) => it.id === String(id)) || null;
}

// patch applies a change to the matching records and returns the updated ones.
export async function patch(filter, changes) {
  const c = await load();
  const targets = filterAnnotations(c.items, filter);
  const at = new Date().toISOString();
  for (const it of targets) {
    if (changes.status) it.status = changes.status;
    if (changes.comment != null) it.comment = sanitizeComment(changes.comment);
    if (changes.note != null) it.note = sanitizeNote(changes.note);
    it.updated_at = at;
  }
  if (targets.length) {
    touch();
    await persistItems();
  }
  return targets;
}

// remove deletes matching records (and their screenshots).
export async function remove(filter) {
  const c = await load();
  const targets = filterAnnotations(c.items, filter);
  if (!targets.length) return { removed: 0, remaining: c.items.length };
  const kill = new Set(targets.map((t) => t.id));
  c.items = c.items.filter((it) => !kill.has(it.id));
  let shotsDropped = false;
  for (const id of kill) {
    if (shots[id]) {
      delete shots[id];
      shotsDropped = true;
    }
  }
  touch();
  await persistItems();
  if (shotsDropped) await persistShots();
  return { removed: targets.length, remaining: c.items.length };
}

export async function getShot(id) {
  await load();
  return shots[String(id)] || null;
}

// setShot stores an element screenshot and evicts old ones past the cap.
export async function setShot(id, dataUrl) {
  const c = await load();
  if (!dataUrl) return false;
  shots[String(id)] = dataUrl;
  const keep = shotIdsToKeep(c.items, Object.keys(shots), MAX_SHOTS);
  for (const key of Object.keys(shots)) {
    if (!keep.has(key)) delete shots[key];
  }
  const item = c.items.find((it) => it.id === String(id));
  if (item) item.has_screenshot = !!shots[String(id)];
  // A record whose image was just evicted must stop advertising one.
  for (const it of c.items) {
    if (it.has_screenshot && !shots[it.id]) it.has_screenshot = false;
  }
  touch();
  await persistShots();
  await persistItems();
  return !!shots[String(id)];
}

// waitForNew parks until an annotation matching `filter` appears (or the
// deadline passes). It polls the in-memory revision rather than holding a
// callback so that a service-worker hiccup can never strand the caller.
export async function waitForNew(filter, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await list(filter);
    if (found.length) return found;
    const left = deadline - Date.now();
    if (left <= 0) return [];
    await sleep(Math.min(250, left));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
