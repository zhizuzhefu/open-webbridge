// background.js — the MV3 service worker entry point. Wires up the WebSocket
// client, a keepalive alarm (so the worker revives and reconnects after the
// browser suspends it), tab-removal cleanup, and popup messaging.

import * as ws from "./ws-client.js";
import { handleTabRemoved } from "./sessions.js";

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
});

// Popup ↔ service worker messaging.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATUS":
          sendResponse({ connected: ws.isConnected(), url: ws.getUrl(), notice: ws.getNotice() });
          break;
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
