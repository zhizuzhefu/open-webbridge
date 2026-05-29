// snapshot.js — turns the page's accessibility tree into a compact, indented
// text outline where interactive nodes carry @e<N> refs. The AI reads this to
// understand the page and to target click/fill, instead of guessing CSS
// selectors that break when class hashes change.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";
import { setRefs } from "../refs.js";

// Roles that should always get a clickable/fillable ref.
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch",
  "slider", "spinbutton", "option", "textarea", "treeitem",
]);

// Roles that add no information and whose presence just clutters the tree.
const SKIP_ROLES = new Set(["none", "generic", "presentation", "InlineTextBox"]);

const MAX_NODES = 4000;

export async function snapshot(args, session) {
  const tabId = getActiveTab(session);
  const target = args.frame ? { targetId: args.frame } : tabId;
  const refKey = args.frame || tabId;
  await cdp.ensureDomain(target, "DOM");
  await cdp.ensureDomain(target, "Accessibility");

  const { nodes } = await cdp.send(target, "Accessibility.getFullAXTree", {});
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);

  // Roots are nodes whose parent is missing from the set.
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const lines = [];
  const refMap = new Map();
  let refCounter = 0;
  let emitted = 0;
  let truncated = false;

  const valOf = (f) => (f && typeof f.value !== "undefined" ? f.value : "");

  function walk(node, depth) {
    if (emitted >= MAX_NODES) {
      truncated = true;
      return;
    }
    const role = String(valOf(node.role) || "");
    const name = String(valOf(node.name) || "").trim().replace(/\s+/g, " ").slice(0, 120);
    const value = String(valOf(node.value) || "").trim().replace(/\s+/g, " ").slice(0, 80);

    const ignored = node.ignored || SKIP_ROLES.has(role);
    let childDepth = depth;

    if (!ignored && (name || value || INTERACTIVE.has(role))) {
      let ref = "";
      if (node.backendDOMNodeId != null && (INTERACTIVE.has(role) || name)) {
        refCounter++;
        refMap.set(String(refCounter), node.backendDOMNodeId);
        ref = ` @e${refCounter}`;
      }
      let line = "  ".repeat(depth) + `- ${role || "node"}`;
      if (name) line += ` "${name}"`;
      if (value) line += ` value="${value}"`;
      line += ref;
      lines.push(line);
      emitted++;
      childDepth = depth + 1;
    }

    for (const cid of node.childIds || []) {
      const child = byId.get(cid);
      if (child) walk(child, childDepth);
    }
  }

  for (const r of roots) walk(r, 0);

  setRefs(refKey, refMap);

  let tree = lines.join("\n");
  if (truncated) tree += `\n… (truncated at ${MAX_NODES} nodes)`;

  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, title: tab.title, frame: args.frame || null, refCount: refCounter, tree };
}
