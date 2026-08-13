// dispatcher.js — maps a tool action name to its implementation. This is the
// single registry the WebSocket layer calls into.

import * as tabs from "./tools/tabs.js";
import { snapshot } from "./tools/snapshot.js";
import * as interact from "./tools/interact.js";
import { evaluate } from "./tools/evaluate.js";
import * as capture from "./tools/capture.js";
import { network } from "./tools/network.js";
import { frames } from "./tools/frames.js";
import { emulate } from "./tools/emulate.js";
import { download } from "./tools/downloads.js";
import { dialog } from "./tools/dialogs.js";
import { cookies } from "./tools/cookies.js";
import { annotate, annotations } from "./tools/annotate.js";

const handlers = {
  // tabs / sessions
  navigate: tabs.navigate,
  find_tab: tabs.find_tab,
  list_tabs: tabs.list_tabs,
  list_sessions: tabs.list_sessions,
  activate_tab: tabs.activate_tab,
  close_tab: tabs.close_tab,
  close_session: tabs.close_session,
  // reading
  snapshot,
  evaluate,
  frames,
  // interaction
  click: interact.click,
  fill: interact.fill,
  hover: interact.hover,
  scroll: interact.scroll,
  press_key: interact.press_key,
  select_option: interact.select_option,
  upload: interact.upload,
  drag: interact.drag,
  tap: interact.tap,
  // capture
  screenshot: capture.screenshot,
  save_as_pdf: capture.save_as_pdf,
  // human ↔ AI annotations
  annotate,
  annotations,
  // network / emulation / downloads / dialogs / cookies
  network,
  emulate,
  download,
  dialog,
  cookies,
};

export async function dispatch(action, args, session, options) {
  const handler = handlers[action];
  if (!handler) throw new Error(`unknown action: ${action}`);
  return handler(args || {}, session || "default", options || {});
}

export function actionNames() {
  return Object.keys(handlers);
}
