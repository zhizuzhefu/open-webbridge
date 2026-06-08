// sessions.js — maps a logical "session" name to a Chrome tab group plus the
// tabs opened under it. Distinct sessions stay visually and functionally
// isolated (each is its own tab group), so an AI can drive several sites in
// parallel without them interfering.

import { cdp } from "./cdp.js";
import { clearRefs } from "./refs.js";

const sessions = new Map(); // name -> { groupId, activeTabId, tabIds:Set<number> }

const sessionKey = (name) => name || "default";

export function getSession(name) {
  const key = sessionKey(name);
  let s = sessions.get(key);
  if (!s) {
    s = { groupId: null, activeTabId: null, tabIds: new Set() };
    sessions.set(key, s);
  }
  return s;
}

// reconcile rebuilds a session's in-memory state from the tab groups Chrome has
// actually kept alive. The in-memory map is volatile: a service-worker suspend,
// an extension update, or a daemon restart wipes it, yet Chrome keeps the tab
// groups (titled with the session name) open. Those become "orphaned" — known
// to the browser but invisible to us, so list_tabs returns nothing and
// close_session closes nothing. Matching live groups back to the session by
// title re-adopts them, which makes the bridge self-healing: navigate reuses the
// existing group instead of spawning a duplicate, and close_session/list_tabs
// see every tab again. Call this before any operation that depends on knowing a
// session's real tabs.
export async function reconcile(name) {
  const key = sessionKey(name);
  const s = getSession(name);
  let all;
  try {
    all = await chrome.tabGroups.query({});
  } catch {
    return s; // tabGroups unavailable; fall back to whatever we have in memory.
  }
  // Exact-title match in JS rather than via the query filter so titles with
  // special characters (our session names can be arbitrary) compare reliably.
  const groups = all.filter((g) => (g.title || "") === key);
  if (groups.length === 0) {
    // Drop a groupId pointing at a group Chrome no longer has.
    if (s.groupId != null && !all.some((g) => g.id === s.groupId)) s.groupId = null;
    return s;
  }
  // Repeated reloads can pile up several groups sharing one title. Adopt the
  // first as canonical (new tabs join it) and fold every duplicate's tabs into
  // the session so close_session reaches them all.
  s.groupId = groups[0].id;
  for (const g of groups) {
    let tabs;
    try {
      tabs = await chrome.tabs.query({ groupId: g.id });
    } catch {
      continue;
    }
    for (const t of tabs) s.tabIds.add(t.id);
  }
  if (!(await tabExists(s.activeTabId))) {
    s.activeTabId = s.tabIds.size ? [...s.tabIds][s.tabIds.size - 1] : null;
  }
  return s;
}

// trackedGroupIds returns the Chrome group IDs the in-memory map currently owns,
// so callers can tell which live groups are orphaned (present in Chrome but not
// adopted by any session).
export function trackedGroupIds() {
  const ids = new Set();
  for (const s of sessions.values()) if (s.groupId != null) ids.add(s.groupId);
  return ids;
}

async function tabExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// acquireTab returns a usable tab for the session, creating one when needed.
export async function acquireTab(name, { newTab } = {}) {
  // Recover any orphaned group/tab first so we reuse it instead of duplicating.
  const s = await reconcile(name);
  if (!newTab && (await tabExists(s.activeTabId))) {
    return s.activeTabId;
  }
  // newTab:true on a session that already has a live tab REPLACES that tab
  // rather than leaving it open. A session models one logical slot; without
  // this, repeatedly navigating with newTab:true piled up orphan tabs that
  // close_tab (which only closes the active one) could never reclaim.
  if (newTab && (await tabExists(s.activeTabId))) {
    await closeActiveTab(name);
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  s.tabIds.add(tab.id);
  s.activeTabId = tab.id;
  await groupTab(name, tab.id);
  return tab.id;
}

async function groupTab(name, tabId) {
  const s = getSession(name);
  try {
    if (s.groupId != null) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      s.groupId = groupId;
      await chrome.tabGroups.update(groupId, { title: name || "default" });
    }
  } catch {
    // Grouping is best-effort (e.g. tab already closed); ignore.
  }
}

export async function setGroupTitle(name, title) {
  const s = getSession(name);
  if (s.groupId != null) {
    try {
      await chrome.tabGroups.update(s.groupId, { title });
    } catch {
      /* ignore */
    }
  }
}

export function getActiveTab(name) {
  const s = getSession(name);
  if (s.activeTabId == null) {
    throw new Error(`session "${name || "default"}" has no open tab — call navigate (with newTab:true) first`);
  }
  return s.activeTabId;
}

// bindTab attaches an already-open tab (found via find_tab) to a session.
export function bindTab(name, tabId) {
  const s = getSession(name);
  s.tabIds.add(tabId);
  s.activeTabId = tabId;
}

export async function closeActiveTab(name) {
  const s = getSession(name);
  if (s.activeTabId == null) return false;
  const id = s.activeTabId;
  await cdp.detach(id).catch(() => {});
  try {
    await chrome.tabs.remove(id);
  } catch {
    /* already gone */
  }
  s.tabIds.delete(id);
  clearRefs(id);
  s.activeTabId = s.tabIds.size ? [...s.tabIds][s.tabIds.size - 1] : null;
  return true;
}

export async function closeSession(name) {
  // Reconcile first so orphaned tabs left by a reload are closed too — without
  // this, close_session on a recovered session returns closed:0 and the group
  // lingers in the UI.
  const s = await reconcile(name);
  let closed = 0;
  for (const id of [...s.tabIds]) {
    await cdp.detach(id).catch(() => {});
    clearRefs(id);
    try {
      await chrome.tabs.remove(id);
      closed++;
    } catch {
      /* already gone */
    }
  }
  sessions.delete(sessionKey(name));
  return closed;
}

// closeGroup closes every tab in a specific Chrome tab group by id. This is the
// escape hatch for orphans the AI located via list_sessions and wants to remove
// precisely — e.g. when duplicate groups share a title and closing by name is
// ambiguous. Any in-memory session bookkeeping is cleaned up by the
// tabs.onRemoved listener as the tabs disappear.
export async function closeGroup(groupId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ groupId });
  } catch {
    return 0;
  }
  let closed = 0;
  for (const t of tabs) {
    await cdp.detach(t.id).catch(() => {});
    clearRefs(t.id);
    try {
      await chrome.tabs.remove(t.id);
      closed++;
    } catch {
      /* already gone */
    }
  }
  return closed;
}

// handleTabRemoved keeps session bookkeeping consistent when the user closes a
// tab manually.
export function handleTabRemoved(tabId) {
  clearRefs(tabId);
  cdp.cleanup(tabId);
  for (const s of sessions.values()) {
    if (s.tabIds.delete(tabId) && s.activeTabId === tabId) {
      s.activeTabId = s.tabIds.size ? [...s.tabIds][s.tabIds.size - 1] : null;
    }
  }
}
