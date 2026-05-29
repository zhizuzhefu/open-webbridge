// evaluate.js — run arbitrary JavaScript in the page's main world and return
// the (JSON-serializable) result. Supports await: if the expression evaluates
// to a Promise it is awaited.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

export async function evaluate(args, session) {
  const tabId = getActiveTab(session);
  const target = args.frame ? { targetId: args.frame } : tabId;
  if (typeof args.code !== "string" || args.code.trim() === "") {
    throw new Error("evaluate requires code: string");
  }
  await cdp.ensureDomain(target, "Runtime");
  const res = await cdp.send(target, "Runtime.evaluate", {
    expression: args.code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    // Keep large DOM/console objects from being serialized into oblivion.
    generatePreview: false,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || "evaluation error");
  }
  return { type: res.result.type, value: res.result.value };
}
