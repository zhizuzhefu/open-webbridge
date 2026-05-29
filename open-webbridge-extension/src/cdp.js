// cdp.js — a thin promise wrapper around chrome.debugger (Chrome DevTools
// Protocol). Every page action in Open WebBridge goes through here.
//
// A "target" is either a tab id (number, or {tabId}) for the top frame, or
// {targetId} for an out-of-process iframe / worker discovered via getTargets().
// This lets tools operate inside cross-origin frames, not just the top frame.
//
// We attach the debugger lazily on first use and keep it attached for the
// target's lifetime, enabling CDP domains on demand. External detaches (the
// user opening DevTools, or the tab/target closing) are handled by clearing our
// bookkeeping so the next call re-attaches cleanly.

const PROTOCOL_VERSION = "1.3";

const attached = new Set(); // key()
const enabledDomains = new Map(); // key() -> Set<domain>

function norm(target) {
  return typeof target === "number" ? { tabId: target } : target;
}

function key(d) {
  return d.tabId != null ? "tab:" + d.tabId : "target:" + d.targetId;
}

function rawSend(debuggee, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`${method}: ${err.message}`));
        return;
      }
      resolve(result);
    });
  });
}

async function attach(target) {
  const d = norm(target);
  const k = key(d);
  if (attached.has(k)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach(d, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/already attached/i.test(err.message)) {
          resolve();
          return;
        }
        reject(new Error(`debugger attach failed: ${err.message}`));
        return;
      }
      resolve();
    });
  });
  attached.add(k);
  // Enable Page on tab targets so native-dialog and lifecycle events flow
  // (lets the dialogs tool auto-handle alert/confirm and prevents hangs).
  if (d.tabId != null) {
    let set = enabledDomains.get(k);
    if (!set) {
      set = new Set();
      enabledDomains.set(k, set);
    }
    if (!set.has("Page")) {
      await rawSend(d, "Page.enable").catch(() => {});
      set.add("Page");
    }
  }
}

async function ensureDomain(target, domain) {
  const d = norm(target);
  await attach(d);
  const k = key(d);
  let set = enabledDomains.get(k);
  if (!set) {
    set = new Set();
    enabledDomains.set(k, set);
  }
  if (set.has(domain)) return;
  // Some "domains" (e.g. Input) have no .enable; ignore the resulting error.
  await rawSend(d, `${domain}.enable`).catch(() => {});
  set.add(domain);
}

async function send(target, method, params) {
  const d = norm(target);
  await attach(d);
  return rawSend(d, method, params);
}

async function detach(target) {
  const d = norm(target);
  const k = key(d);
  if (!attached.has(k)) {
    cleanup(target);
    return;
  }
  await new Promise((resolve) => {
    chrome.debugger.detach(d, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  cleanup(target);
}

function cleanup(target) {
  const d = norm(target);
  const k = key(d);
  attached.delete(k);
  enabledDomains.delete(k);
}

// getTargets lists all debuggable targets (tabs, iframes, workers).
function getTargets() {
  return new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
}

// If the debugger is detached out from under us, forget the target.
chrome.debugger.onDetach.addListener((source) => {
  if (!source) return;
  if (source.tabId != null) cleanup({ tabId: source.tabId });
  if (source.targetId != null) cleanup({ targetId: source.targetId });
});

export const cdp = { send, ensureDomain, attach, detach, cleanup, getTargets };
