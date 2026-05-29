// network.js — capture network activity for a tab via the CDP Network domain.
//
//   cmd:"start"            begin capturing on the session's active tab
//   cmd:"stop"             stop capturing
//   cmd:"list" [filter]    list captured requests (optionally URL-substring filtered)
//   cmd:"detail" requestId fetch a request's response body

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

const buffers = new Map(); // tabId -> entry[]
const capturing = new Set(); // tabId
const MAX_ENTRIES = 500;

// Single global listener; cheap when the tab isn't capturing.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (tabId == null || !capturing.has(tabId)) return;
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = [];
    buffers.set(tabId, buf);
  }
  if (method === "Network.requestWillBeSent") {
    buf.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || null,
      status: null,
      mimeType: null,
    });
  } else if (method === "Network.responseReceived") {
    const e = buf.find((x) => x.requestId === params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
    }
  }
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
});

export async function network(args, session) {
  const tabId = getActiveTab(session);
  switch (args.cmd) {
    case "start":
      await cdp.ensureDomain(tabId, "Network");
      capturing.add(tabId);
      buffers.set(tabId, []);
      return { success: true, capturing: true };
    case "stop":
      capturing.delete(tabId);
      return { success: true, capturing: false };
    case "list": {
      let buf = buffers.get(tabId) || [];
      if (args.filter) {
        const f = String(args.filter).toLowerCase();
        buf = buf.filter((e) => e.url.toLowerCase().includes(f));
      }
      return { count: buf.length, requests: buf.slice(-200) };
    }
    case "detail": {
      if (!args.requestId) throw new Error("network detail requires requestId");
      const body = await cdp.send(tabId, "Network.getResponseBody", { requestId: args.requestId });
      const meta = (buffers.get(tabId) || []).find((e) => e.requestId === args.requestId) || {};
      const truncated = body.body && body.body.length > 20000;
      return {
        ...meta,
        base64Encoded: !!body.base64Encoded,
        body: body.base64Encoded ? "(binary, base64-encoded omitted)" : (truncated ? body.body.slice(0, 20000) + "…(truncated)" : body.body),
      };
    }
    default:
      throw new Error(`unknown network cmd: ${args.cmd} (use start|stop|list|detail)`);
  }
}
