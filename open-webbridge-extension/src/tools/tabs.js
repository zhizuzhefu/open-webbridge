// tabs.js — tab/session lifecycle tools: navigate, find_tab, list_tabs,
// activate_tab, close_tab, close_session.

import { cdp } from "../cdp.js";
import {
  acquireTab,
  setGroupTitle,
  getActiveTab,
  bindTab,
  reconcile,
  closeActiveTab,
  closeSession as endSession,
  closeGroup,
  trackedGroupIds,
} from "../sessions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return t;
    await sleep(150);
  }
  return chrome.tabs.get(tabId);
}

export async function navigate(args, session) {
  if (!args.url) throw new Error("navigate requires url");
  const tabId = await acquireTab(session, { newTab: !!args.newTab });
  await chrome.tabs.update(tabId, { url: args.url });
  const t = await waitForComplete(tabId);
  if (args.group_title) await setGroupTitle(session, args.group_title);
  return { success: true, url: t.url, tabId, title: t.title };
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

export async function find_tab(args, session) {
  if (!args.url) throw new Error("find_tab requires url (a URL or domain)");
  const all = await chrome.tabs.query({});
  const wantHost = hostOf(args.url) || String(args.url).replace(/^https?:\/\//, "").split("/")[0];
  const matches = all.filter((t) => {
    if (!t.url) return false;
    const h = hostOf(t.url);
    if (wantHost && (h === wantHost || h.endsWith("." + wantHost))) return true;
    return t.url.includes(args.url);
  });
  if (matches.length === 0) throw new Error(`no open tab found for ${args.url}`);
  let chosen;
  if (args.active) {
    chosen = matches.find((t) => t.active) || matches[0];
  } else {
    matches.sort((a, b) => a.index - b.index);
    chosen = matches[0];
  }
  bindTab(session, chosen.id);
  return { success: true, url: chosen.url, tabId: chosen.id };
}

export async function list_tabs(args, session) {
  // Reconcile first so tabs in a recovered/orphaned group are listed too.
  const s = await reconcile(session);
  const tabs = [];
  for (const id of s.tabIds) {
    try {
      const t = await chrome.tabs.get(id);
      let groupTitle = null;
      if (t.groupId != null && t.groupId > -1) {
        try {
          const g = await chrome.tabGroups.get(t.groupId);
          groupTitle = g.title;
        } catch {
          /* group gone */
        }
      }
      tabs.push({ tabId: t.id, url: t.url, title: t.title, active: t.active, groupTitle });
    } catch {
      /* tab gone */
    }
  }
  return { success: true, tabs };
}

export async function activate_tab(args, session) {
  const tabId = args.tabId != null ? args.tabId : getActiveTab(session);
  const t = await chrome.tabs.update(tabId, { active: true });
  try {
    await chrome.windows.update(t.windowId, { focused: true });
  } catch {
    /* ignore */
  }
  bindTab(session, tabId);
  return { success: true, tabId };
}

export async function close_tab(args, session) {
  const closed = await closeActiveTab(session);
  return { success: true, closed };
}

// list_sessions enumerates every tab group in the browser the bridge could own,
// including "orphaned" ones whose in-memory state was lost to a reload/update.
// The group title is the session name, so the AI can discover stragglers and
// close them by name (close_session) or by groupId (close_session {groupId}).
export async function list_sessions() {
  let groups;
  try {
    groups = await chrome.tabGroups.query({});
  } catch {
    return { success: true, sessions: [] };
  }
  const tracked = trackedGroupIds();
  const out = [];
  for (const g of groups) {
    let tabCount = 0;
    try {
      tabCount = (await chrome.tabs.query({ groupId: g.id })).length;
    } catch {
      /* group gone */
    }
    out.push({
      session: g.title || "",
      groupId: g.id,
      color: g.color,
      tabCount,
      orphaned: !tracked.has(g.id),
    });
  }
  return { success: true, sessions: out };
}

export async function close_session(args, session) {
  // groupId targets one specific group — used to clear a single orphan when
  // duplicates share a title. Otherwise close the named session (reconcile
  // inside endSession recovers orphans matching the name).
  const closed =
    args.groupId != null ? await closeGroup(args.groupId) : await endSession(session);
  return { success: true, closed };
}

// Re-export so background.js can reach detach via the same module if needed.
export { cdp };
