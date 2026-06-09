// sessions.js — maps a logical "session" name to a Chrome tab group plus the
// tabs opened under it. Distinct sessions stay visually and functionally
// isolated (each is its own tab group), so an AI can drive several sites in
// parallel without them interfering.

import { cdp } from "./cdp.js";
import { clearRefs } from "./refs.js";
import { assertDomainTabLimits } from "./tablimit.js";

const sessions = new Map(); // name -> { groupId, activeTabId, tabIds:Set<number> }
const OWNED_GROUPS_KEY = "owb_owned_groups";

const sessionKey = (name) => name || "default";
let tabMutationTail = Promise.resolve();

export function withTabMutationLock(fn) {
  const run = tabMutationTail.catch(() => {}).then(fn);
  tabMutationTail = run.catch(() => {});
  return run;
}

async function loadOwnedGroups() {
  try {
    const got = await chrome.storage.local.get(OWNED_GROUPS_KEY);
    const owned = got[OWNED_GROUPS_KEY];
    return owned && typeof owned === "object" ? owned : {};
  } catch {
    return {};
  }
}

async function saveOwnedGroups(owned) {
  try {
    await chrome.storage.local.set({ [OWNED_GROUPS_KEY]: owned });
  } catch {
    /* storage unavailable */
  }
}

async function rememberOwnedGroup(name, groupId) {
  if (groupId == null) return;
  const owned = await loadOwnedGroups();
  owned[String(groupId)] = sessionKey(name);
  await saveOwnedGroups(owned);
}

async function forgetOwnedGroup(groupId) {
  if (groupId == null) return;
  const owned = await loadOwnedGroups();
  delete owned[String(groupId)];
  await saveOwnedGroups(owned);
}

async function forgetOwnedSession(name) {
  const key = sessionKey(name);
  const owned = await loadOwnedGroups();
  for (const groupId of Object.keys(owned)) {
    if (owned[groupId] === key) delete owned[groupId];
  }
  await saveOwnedGroups(owned);
}

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
  const ownedGroups = await loadOwnedGroups();
  let all;
  try {
    all = await chrome.tabGroups.query({});
  } catch {
    return s; // tabGroups unavailable; fall back to whatever we have in memory.
  }
  // Exact-title match in JS rather than via the query filter so titles with
  // special characters (our session names can be arbitrary) compare reliably.
  // Also recover groups by persisted ownership so a custom group_title does not
  // make a live session disappear after the service worker restarts.
  const groups = all.filter((g) => (g.title || "") === key || ownedGroups[String(g.id)] === key);
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
    await rememberOwnedGroup(name, g.id);
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
export async function trackedGroupIds() {
  const ids = new Set();
  for (const s of sessions.values()) if (s.groupId != null) ids.add(s.groupId);
  const ownedGroups = await loadOwnedGroups();
  for (const groupId of Object.keys(ownedGroups)) ids.add(Number(groupId));
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

export async function acquireTabForNavigation(name, { newTab, domainTabLimits, targetUrl } = {}) {
  const s = await reconcile(name);
  const activeExists = await tabExists(s.activeTabId);
  if (!newTab && activeExists) {
    await ensureDomainTabLimits(domainTabLimits, targetUrl, { excludeTabId: s.activeTabId });
    return s.activeTabId;
  }

  const replacedTabId = newTab && activeExists ? s.activeTabId : null;
  await ensureDomainTabLimits(domainTabLimits, targetUrl, { excludeTabId: replacedTabId });
  if (replacedTabId != null) {
    const closed = await closeActiveTab(name);
    if (!closed) throw new Error(`could not close existing session tab ${replacedTabId}`);
  }

  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  s.tabIds.add(tab.id);
  s.activeTabId = tab.id;
  await groupTab(name, tab.id);
  return tab.id;
}

// ensureDomainTabLimits checks per-domain concurrent tab caps (most specific wins).
// If targetUrl is provided, we only evaluate the rule(s) that would apply to the
// host being navigated to (precise, preferred path from navigate).
// Otherwise we check all rules (conservative).
export async function ensureDomainTabLimits(limits, targetUrl, { excludeTabId } = {}) {
  if (!Array.isArray(limits) || limits.length === 0) return;

  const candidateIds = await collectManagedTabIds();
  if (excludeTabId != null) candidateIds.delete(Number(excludeTabId));

  const tabUrls = [];
  for (const id of candidateIds) {
    try {
      const t = await chrome.tabs.get(id);
      tabUrls.push((t && (t.pendingUrl || t.url)) || "");
    } catch {
      // tab disappeared; ignore
    }
  }
  assertDomainTabLimits(limits, targetUrl, tabUrls);
}

async function collectManagedTabIds() {
  const candidateIds = new Set();
  for (const sess of sessions.values()) {
    for (const id of sess.tabIds) {
      if (await tabExists(id)) candidateIds.add(id);
    }
  }

  let groups = [];
  try {
    groups = await chrome.tabGroups.query({});
  } catch {
    return candidateIds;
  }
  const ownedGroups = await loadOwnedGroups();
  const inMemoryGroups = new Set();
  const knownSessionTitles = new Set(sessions.keys());
  for (const sess of sessions.values()) {
    if (sess.groupId != null) inMemoryGroups.add(sess.groupId);
  }

  for (const g of groups) {
    const owned = ownedGroups[String(g.id)] != null;
    const tracked = inMemoryGroups.has(g.id) || knownSessionTitles.has(g.title || "");
    if (!owned && !tracked) continue;
    let tabs;
    try {
      tabs = await chrome.tabs.query({ groupId: g.id });
    } catch {
      continue;
    }
    for (const t of tabs) candidateIds.add(t.id);
  }
  return candidateIds;
}

async function groupTab(name, tabId) {
  const s = getSession(name);
  try {
    if (s.groupId != null) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId });
      await rememberOwnedGroup(name, s.groupId);
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      s.groupId = groupId;
      await chrome.tabGroups.update(groupId, { title: name || "default" });
      await rememberOwnedGroup(name, groupId);
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
      await rememberOwnedGroup(name, s.groupId);
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
  if (!(await removeManagedTab(id))) return false;
  s.tabIds.delete(id);
  s.activeTabId = s.tabIds.size ? [...s.tabIds][s.tabIds.size - 1] : null;
  return true;
}

async function removeManagedTab(tabId) {
  await cdp.detach(tabId).catch(() => {});
  try {
    await chrome.tabs.remove(tabId);
    clearRefs(tabId);
    return true;
  } catch {
    if (await tabExists(tabId)) return false;
    clearRefs(tabId);
    return true;
  }
}

export async function closeSession(name) {
  // Reconcile first so orphaned tabs left by a reload are closed too — without
  // this, close_session on a recovered session returns closed:0 and the group
  // lingers in the UI.
  const s = await reconcile(name);
  let closed = 0;
  for (const id of [...s.tabIds]) {
    if (await removeManagedTab(id)) {
      s.tabIds.delete(id);
      closed++;
    }
  }
  if (s.tabIds.size === 0) {
    sessions.delete(sessionKey(name));
    await forgetOwnedSession(name);
  } else if (!(await tabExists(s.activeTabId))) {
    s.activeTabId = [...s.tabIds][s.tabIds.size - 1] || null;
  }
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
  let remaining = 0;
  for (const t of tabs) {
    if (await removeManagedTab(t.id)) {
      closed++;
    } else {
      remaining++;
    }
  }
  if (remaining === 0) await forgetOwnedGroup(groupId);
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
