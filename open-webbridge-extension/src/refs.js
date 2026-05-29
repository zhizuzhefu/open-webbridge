// refs.js — stores the @e<N> element references produced by snapshot, mapping
// them to CDP backendNodeIds per tab. Click/fill/etc. resolve refs through
// here. A fresh snapshot replaces the tab's ref table.

const store = new Map(); // tabId -> Map<string refNumber, number backendNodeId>

export function setRefs(tabId, map) {
  store.set(tabId, map);
}

export function getBackendId(tabId, ref) {
  const m = store.get(tabId);
  if (!m) return undefined;
  const num = String(ref).replace(/^@?e/i, "");
  return m.get(num);
}

export function clearRefs(tabId) {
  store.delete(tabId);
}
