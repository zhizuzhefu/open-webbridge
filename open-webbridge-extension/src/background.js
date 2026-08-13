// background.js — the MV3 service worker entry point. Wires up the WebSocket
// client, a keepalive alarm (so the worker revives and reconnects after the
// browser suspends it), tab-removal cleanup, annotation mode, and popup
// messaging.

import * as ws from "./ws-client.js";
import { handleTabRemoved } from "./sessions.js";
import * as annotations from "./annotations/mode.js";

const KEEPALIVE_ALARM = "owb-keepalive";

function ensureAlarm() {
  // 0.5 min is the minimum period Chrome honors; it keeps the SW warm enough
  // to maintain the connection during active tasks.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ws.reconnectIfNeeded();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ws.reconnectIfNeeded();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ws.reconnectIfNeeded();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId);
  annotations.handleTabRemoved(tabId);
});

// Re-inject the annotation overlay after a navigation or reload, so a human who
// turned annotation mode on keeps it (and their existing pins) across page
// changes instead of silently losing it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  annotations.handleTabUpdated(tabId, changeInfo);
});

// Keyboard entry point (default Alt+Shift+A): the fastest way for a human to
// start marking up whatever page they are already looking at.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-annotate") return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) return;
    try {
      if (await annotations.isActive(tab.id)) await annotations.stop(tab.id);
      else await annotations.start(tab.id);
    } catch (e) {
      console.warn("[owb] annotation toggle failed:", e.message);
    }
  });
}

// Popup / in-page annotator ↔ service worker messaging.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && typeof msg.type === "string" && msg.type.startsWith("OWB_ANN_")) {
        sendResponse(await annotations.handlePageMessage(msg, sender));
        return;
      }
      switch (msg.type) {
        case "GET_STATUS": {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          sendResponse({
            connected: ws.isConnected(),
            url: ws.getUrl(),
            notice: ws.getNotice(),
            tabId: tab ? tab.id : null,
            annotating: tab && tab.id != null ? await annotations.isActive(tab.id) : false,
          });
          break;
        }
        case "CONNECT":
          await ws.connect(msg.url);
          sendResponse({ ok: true, connected: ws.isConnected() });
          break;
        case "DISCONNECT":
          await ws.disconnect();
          sendResponse({ ok: true });
          break;
        case "TEST":
          sendResponse(await ws.testConnection(msg.url));
          break;
        case "TOGGLE_ANNOTATE": {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab || tab.id == null) {
            sendResponse({ error: "no active tab" });
            break;
          }
          const on = await annotations.isActive(tab.id);
          if (on) await annotations.stop(tab.id);
          else await annotations.start(tab.id);
          sendResponse({ ok: true, annotating: !on });
          break;
        }
        default:
          sendResponse({ error: `unknown message: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Kick things off on initial worker load.
ensureAlarm();
ws.reconnectIfNeeded();
