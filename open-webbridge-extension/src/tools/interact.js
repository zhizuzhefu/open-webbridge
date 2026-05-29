// interact.js — element-level actions: click, fill, hover, scroll, press_key,
// select_option, upload, drag, tap. Selectors are either @e<N> refs from
// snapshot or raw CSS selectors. An optional `frame` arg (a targetId from the
// `frames` tool) runs the action inside a cross-origin iframe.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";
import { getBackendId } from "../refs.js";

// targetOf resolves the CDP target + ref-store key for a tool call.
function targetOf(session, args) {
  const tabId = getActiveTab(session);
  const target = args.frame ? { targetId: args.frame } : tabId;
  const refKey = args.frame || tabId;
  return { target, refKey };
}

// resolveObjectId turns a selector into a CDP Runtime objectId on `target`.
export async function resolveObjectId(target, selector, refKey) {
  if (!selector) throw new Error("selector is required");
  const refMatch = /^@?e(\d+)$/i.exec(String(selector).trim());
  if (refMatch) {
    const backendNodeId = getBackendId(refKey, refMatch[1]);
    if (backendNodeId == null) {
      throw new Error(`unknown element ref ${selector} — take a fresh snapshot first (same frame)`);
    }
    const res = await cdp.send(target, "DOM.resolveNode", { backendNodeId });
    if (!res.object || !res.object.objectId) {
      throw new Error(`could not resolve ref ${selector}`);
    }
    return res.object.objectId;
  }
  await cdp.ensureDomain(target, "Runtime");
  const res = await cdp.send(target, "Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (res.exceptionDetails) throw new Error(`invalid selector: ${selector}`);
  if (!res.result || res.result.subtype === "null" || !res.result.objectId) {
    throw new Error(`no element matches selector: ${selector}`);
  }
  return res.result.objectId;
}

async function callOn(target, objectId, functionDeclaration, args) {
  const res = await cdp.send(target, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: (args || []).map((v) => ({ value: v })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || "call failed");
  }
  return res.result.value;
}

function centerOf(boxModel) {
  const q = boxModel.model.content;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return {
    x: (xs[0] + xs[1] + xs[2] + xs[3]) / 4,
    y: (ys[0] + ys[1] + ys[2] + ys[3]) / 4,
  };
}

// pointFor returns viewport coordinates from a selector or explicit x/y.
async function pointFor(target, refKey, selector, x, y) {
  if (selector) {
    const objectId = await resolveObjectId(target, selector, refKey);
    await callOn(target, objectId, "function(){ this.scrollIntoView({block:'center',inline:'center'}); }");
    const box = await cdp.send(target, "DOM.getBoxModel", { objectId });
    return centerOf(box);
  }
  if (x == null || y == null) throw new Error("provide a selector or explicit x/y");
  return { x: Number(x), y: Number(y) };
}

export async function click(args, session) {
  const { target, refKey } = targetOf(session, args);
  const objectId = await resolveObjectId(target, args.selector, refKey);
  await callOn(target, objectId, "function(){ this.scrollIntoView({block:'center',inline:'center'}); }");

  let dispatched = false;
  try {
    const box = await cdp.send(target, "DOM.getBoxModel", { objectId });
    const { x, y } = centerOf(box);
    await cdp.attach(target);
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
    dispatched = true;
  } catch {
    // Off-screen / zero-size; fall back to a synthetic click.
  }
  if (!dispatched) {
    await callOn(target, objectId, "function(){ this.click(); }");
  }
  const info = await callOn(
    target,
    objectId,
    "function(){ return {tag:(this.tagName||'').toLowerCase(), text:((this.innerText||this.value||this.getAttribute&&this.getAttribute('aria-label')||'')+'').trim().slice(0,120)}; }"
  );
  return { success: true, method: dispatched ? "mouse" : "synthetic", ...info };
}

export async function fill(args, session) {
  const { target, refKey } = targetOf(session, args);
  const objectId = await resolveObjectId(target, args.selector, refKey);
  const fn = `function(value){
    const el=this; el.focus();
    const tag=(el.tagName||'').toLowerCase();
    if (el.isContentEditable){
      const sel=window.getSelection(); const r=document.createRange();
      r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('insertText', false, value);
      return {mode:'contenteditable', tag};
    }
    let proto = HTMLInputElement.prototype;
    if (tag==='textarea') proto = HTMLTextAreaElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto,'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return {mode:'value', tag};
  }`;
  const r = await callOn(target, objectId, fn, [args.value == null ? "" : String(args.value)]);
  return { success: true, ...r };
}

export async function hover(args, session) {
  const { target, refKey } = targetOf(session, args);
  const pt = await pointFor(target, refKey, args.selector, args.x, args.y);
  await cdp.attach(target);
  await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
  return { success: true };
}

export async function scroll(args, session) {
  const { target, refKey } = targetOf(session, args);
  await cdp.ensureDomain(target, "Runtime");
  if (args.selector) {
    const objectId = await resolveObjectId(target, args.selector, refKey);
    await callOn(target, objectId, "function(){ this.scrollIntoView({block:'center',inline:'center'}); }");
    return { success: true, mode: "element" };
  }
  const dx = Number(args.x) || 0;
  const dy = Number(args.y) || 0;
  await cdp.send(target, "Runtime.evaluate", { expression: `window.scrollBy(${dx}, ${dy})` });
  return { success: true, mode: "window", x: dx, y: dy };
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

export async function press_key(args, session) {
  const { target, refKey } = targetOf(session, args);
  if (!args.key) throw new Error("press_key requires key");
  if (args.selector) {
    const objectId = await resolveObjectId(target, args.selector, refKey);
    await callOn(target, objectId, "function(){ this.focus(); }");
  }
  await cdp.attach(target);
  const spec = KEYS[args.key] || { key: args.key, text: args.key.length === 1 ? args.key : undefined };
  await cdp.send(target, "Input.dispatchKeyEvent", { type: "keyDown", ...spec });
  if (spec.text) {
    await cdp.send(target, "Input.dispatchKeyEvent", { type: "char", text: spec.text });
  }
  await cdp.send(target, "Input.dispatchKeyEvent", { type: "keyUp", ...spec });
  return { success: true, key: args.key };
}

export async function select_option(args, session) {
  const { target, refKey } = targetOf(session, args);
  const objectId = await resolveObjectId(target, args.selector, refKey);
  const fn = `function(want){
    const el=this;
    if ((el.tagName||'').toLowerCase()!=='select') throw new Error('not a <select>');
    let matched=false;
    for (const o of el.options){
      if (o.value===want || o.label===want || o.textContent.trim()===want){ el.value=o.value; matched=true; break; }
    }
    if(!matched) throw new Error('no option matching '+want);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return {value: el.value};
  }`;
  const r = await callOn(target, objectId, fn, [String(args.value != null ? args.value : args.label || "")]);
  return { success: true, ...r };
}

export async function upload(args, session) {
  const { target, refKey } = targetOf(session, args);
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length === 0) throw new Error("upload requires files: string[] of absolute paths");
  const objectId = await resolveObjectId(target, args.selector, refKey);
  await cdp.send(target, "DOM.setFileInputFiles", { objectId, files });
  return { success: true, fileCount: files.length };
}

// drag performs a real mouse drag from one point/element to another.
export async function drag(args, session) {
  const { target, refKey } = targetOf(session, args);
  const start = await pointFor(target, refKey, args.from, args.fromX, args.fromY);
  const end = await pointFor(target, refKey, args.to, args.toX, args.toY);
  await cdp.attach(target);
  await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y });
  await cdp.send(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const x = start.x + ((end.x - start.x) * i) / steps;
    const y = start.y + ((end.y - start.y) * i) / steps;
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 1, clickCount: 1 });
  return { success: true, from: start, to: end };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("touch dispatch timed out")), ms)),
  ]);
}

// tap dispatches a touch tap at a point/element. On desktop Chrome the CDP touch
// dispatch is sometimes never acknowledged, so we cap it with a short timeout
// and fall back to a mouse tap — `tap` therefore always lands and never hangs.
export async function tap(args, session) {
  const { target, refKey } = targetOf(session, args);
  const pt = await pointFor(target, refKey, args.selector, args.x, args.y);
  await cdp.attach(target);
  try {
    await cdp.send(target, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }).catch(() => {});
    await withTimeout(cdp.send(target, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 0 }] }), 1500);
    await withTimeout(cdp.send(target, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }), 1500);
    return { success: true, point: pt, mode: "touch" };
  } catch {
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
    return { success: true, point: pt, mode: "mouse-fallback" };
  }
}
