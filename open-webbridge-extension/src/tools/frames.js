// frames.js — list the frames/targets that belong to the session's tab,
// including cross-origin (out-of-process) iframes. The returned `targetId`
// values can be passed as the `frame` arg to snapshot/click/fill/evaluate/etc.
// to operate inside that frame.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

export async function frames(args, session) {
  const tabId = getActiveTab(session);
  const targets = await cdp.getTargets();
  const seen = new Set();
  const frames = [];
  for (const t of targets) {
    const belongs = t.tabId === tabId || t.type === "iframe";
    if (!belongs || seen.has(t.id)) continue;
    seen.add(t.id);
    frames.push({
      targetId: t.id,
      type: t.type,
      url: t.url,
      title: t.title,
      attached: !!t.attached,
    });
  }
  return { tabId, count: frames.length, frames };
}
