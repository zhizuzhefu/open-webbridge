// dialogs.js — handle native JS dialogs (alert / confirm / prompt /
// beforeunload). These block the renderer, so an unhandled dialog would hang
// automation. We auto-handle them per a per-tab policy (default: dismiss, the
// safe choice that won't confirm destructive prompts) and record what appeared.
//
// Page must be enabled for the event to fire — cdp.attach() enables it on every
// tab, so dialogs are handled even before the `dialog` tool is called.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

const policy = new Map(); // tabId -> { action: "accept"|"dismiss", promptText? }
const recent = new Map(); // tabId -> entry[]

chrome.debugger.onEvent.addListener(async (src, method, params) => {
  if (method !== "Page.javascriptDialogOpening") return;
  const tabId = src && src.tabId;
  if (tabId == null) return;

  let r = recent.get(tabId);
  if (!r) {
    r = [];
    recent.set(tabId, r);
  }
  r.push({ type: params.type, message: params.message, url: params.url, defaultPrompt: params.defaultPrompt });
  if (r.length > 20) r.shift();

  const pol = policy.get(tabId) || { action: "dismiss" };
  try {
    await cdp.send(tabId, "Page.handleJavaScriptDialog", {
      accept: pol.action === "accept",
      promptText: pol.promptText,
    });
  } catch {
    /* dialog may have already been handled */
  }
});

export async function dialog(args, session) {
  const tabId = getActiveTab(session);
  if (args.cmd === "list") {
    return { dialogs: recent.get(tabId) || [] };
  }
  // Configure how future dialogs on this tab are handled.
  await cdp.ensureDomain(tabId, "Page");
  const action = args.action === "accept" ? "accept" : "dismiss";
  policy.set(tabId, { action, promptText: args.promptText });
  return { success: true, policy: { action, promptText: args.promptText || null } };
}
