// capture.js — screenshot and PDF. Both return base64 to the daemon, which
// writes the bytes to disk and hands the AI a file path (so the context window
// is never flooded with image data).

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";
import { resolveObjectId } from "./interact.js";

export async function screenshot(args, session) {
  const tabId = getActiveTab(session);
  await cdp.ensureDomain(tabId, "Page");
  const format = args.format === "jpeg" || args.format === "jpg" ? "jpeg" : "png";
  const params = { format, captureBeyondViewport: false };
  if (format === "jpeg" && args.quality != null) {
    params.quality = Math.max(0, Math.min(100, Number(args.quality)));
  }
  if (args.selector) {
    const objectId = await resolveObjectId(tabId, args.selector, tabId);
    await cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){ this.scrollIntoView({block:'center'}); }",
    }).catch(() => {});
    const box = await cdp.send(tabId, "DOM.getBoxModel", { objectId });
    const q = box.model.content;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    params.clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
  }
  const res = await cdp.send(tabId, "Page.captureScreenshot", params);
  return { format, dataLength: res.data.length, data: res.data };
}

const PAPER = {
  letter: [8.5, 11],
  a4: [8.27, 11.7],
  legal: [8.5, 14],
  a3: [11.7, 16.5],
  tabloid: [11, 17],
};

export async function save_as_pdf(args, session) {
  const tabId = getActiveTab(session);
  await cdp.ensureDomain(tabId, "Page");
  const [w, h] = PAPER[String(args.paper_format || "letter").toLowerCase()] || PAPER.letter;
  const scale = Math.max(0.1, Math.min(2.0, args.scale == null ? 1.0 : Number(args.scale)));
  const res = await cdp.send(tabId, "Page.printToPDF", {
    landscape: !!args.landscape,
    printBackground: args.print_background !== false,
    scale,
    paperWidth: w,
    paperHeight: h,
    transferMode: "ReturnAsBase64",
  });
  const tab = await chrome.tabs.get(tabId);
  return { format: "pdf", file_name: args.file_name || "", pageTitle: tab.title || "", data: res.data };
}
