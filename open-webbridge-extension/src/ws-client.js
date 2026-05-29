// ws-client.js — manages the single WebSocket link to the local daemon.
// Handles the hello handshake, daemon pings, incoming tool_calls, and
// automatic reconnection. Connection settings are persisted in
// chrome.storage.local so the service worker can re-establish the link after
// the browser suspends and revives it.

import { dispatch } from "./dispatcher.js";

const RECONNECT_MS = 5000;
// On a rejected connection (another browser already owns the daemon) back off
// longer so two browsers don't fight; recovery still happens once the other
// disconnects.
const REJECTED_RECONNECT_MS = 30000;
// The oldest daemon this extension is willing to drive.
// Bump in lockstep with any breaking wire-protocol change.
const MIN_DAEMON_VERSION = "1.0.0";
const STORE = { url: "owb_ws_url", reconnect: "owb_should_reconnect", notice: "owb_notice" };

let socket = null;
let state = "disconnected"; // disconnected | connecting | connected
let currentUrl = "";
let shouldReconnect = false;
let reconnectTimer = null;
let nextReconnectMs = RECONNECT_MS;
let notice = null; // { level: "warn"|"error", message }

export function isConnected() {
  return state === "connected";
}

export function getUrl() {
  return currentUrl;
}

export function getNotice() {
  return notice;
}

// cmpV compares dotted versions: -1 / 0 / 1.
function cmpV(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function setNotice(n) {
  notice = n;
  chrome.storage.local.set({ [STORE.notice]: n });
}

export async function connect(url) {
  if (url && url !== currentUrl && (state === "connecting" || state === "connected")) {
    await disconnect();
  }
  if (state === "connecting" || state === "connected") return;

  shouldReconnect = true;
  state = "connecting";
  currentUrl = url || currentUrl;
  if (!currentUrl) {
    state = "disconnected";
    return;
  }
  await chrome.storage.local.set({ [STORE.url]: currentUrl, [STORE.reconnect]: true });

  try {
    const s = new WebSocket(currentUrl);
    socket = s;
    s.addEventListener("open", () => {
      state = "connected";
      nextReconnectMs = RECONNECT_MS;
      clearReconnect();
      console.log("[owb] connected to", currentUrl);
      send({
        type: "hello",
        payload: {
          extensionVersion: chrome.runtime.getManifest().version,
          minDaemonVersion: MIN_DAEMON_VERSION,
        },
      });
    });
    s.addEventListener("message", async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      await handleMessage(msg);
    });
    s.addEventListener("close", () => {
      if (socket !== s) return;
      state = "disconnected";
      socket = null;
      console.log("[owb] disconnected");
      if (shouldReconnect) scheduleReconnect();
    });
    s.addEventListener("error", (e) => console.warn("[owb] ws error", e));
  } catch (e) {
    state = "disconnected";
    console.warn("[owb] connect failed", e);
    if (shouldReconnect) scheduleReconnect();
  }
}

export async function disconnect() {
  shouldReconnect = false;
  clearReconnect();
  await chrome.storage.local.set({ [STORE.reconnect]: false });
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  state = "disconnected";
}

// testConnection opens a throwaway socket to verify a URL works.
export function testConnection(url) {
  return new Promise((resolve) => {
    let done = false;
    let s;
    try {
      s = new WebSocket(url);
    } catch (e) {
      resolve({ ok: false, reason: e.message });
      return;
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          s.close();
        } catch {}
        resolve({ ok: false, reason: "timeout" });
      }
    }, 5000);
    s.addEventListener("open", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        s.close();
      } catch {}
      resolve({ ok: true });
    });
    s.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "connection failed (check the token and that the daemon is running)" });
    });
  });
}

// reconnectIfNeeded is called on startup and on the keepalive alarm.
export async function reconnectIfNeeded() {
  if (state === "connected" || state === "connecting") return;
  const st = await chrome.storage.local.get([STORE.url, STORE.reconnect]);
  if (st[STORE.reconnect] && st[STORE.url]) {
    shouldReconnect = true;
    await connect(st[STORE.url]);
  }
}

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "ping":
      send({ type: "pong" });
      break;
    case "hello_ack":
      onHelloAck(msg.payload || {});
      break;
    case "connection_rejected":
      onRejected(msg.payload || {});
      break;
    case "tool_call":
      await handleToolCall(msg);
      break;
    default:
      console.log("[owb] unhandled message", msg.type);
  }
}

// onHelloAck evaluates version compatibility reported by the daemon (#2).
function onHelloAck(payload) {
  const myVer = chrome.runtime.getManifest().version;
  if (payload.compatible === false) {
    setNotice({
      level: "error",
      message: `This extension (v${myVer}) is too old for the daemon (v${payload.daemonVersion}). Update the extension to v${payload.requiredExtensionVersion || payload.minExtensionVersion} or newer — tool calls will be refused until then.`,
    });
    console.warn("[owb] incompatible: extension too old");
  } else if (payload.daemonVersion && cmpV(payload.daemonVersion, MIN_DAEMON_VERSION) < 0) {
    setNotice({
      level: "warn",
      message: `The daemon (v${payload.daemonVersion}) is older than this extension expects (v${MIN_DAEMON_VERSION}). Run \`open-webbridge update\` on the daemon machine.`,
    });
    console.warn("[owb] daemon older than extension expects");
  } else {
    setNotice(null);
  }
}

// onRejected handles "another browser already owns the daemon" (#4). We back
// off rather than flap; once the other side disconnects, this one takes over.
function onRejected(payload) {
  setNotice({
    level: "warn",
    message: (payload && payload.reason) || "Another browser is already connected to this daemon.",
  });
  console.warn("[owb] connection rejected:", notice.message);
  nextReconnectMs = REJECTED_RECONNECT_MS;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}

async function handleToolCall(msg) {
  try {
    const data = await dispatch(msg.action, msg.args, msg.session);
    send({ type: "tool_result", id: msg.id, ok: true, data });
  } catch (e) {
    send({ type: "tool_result", id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
}

function scheduleReconnect() {
  clearReconnect();
  const delay = nextReconnectMs;
  nextReconnectMs = RECONNECT_MS; // one-shot backoff, then back to normal
  reconnectTimer = setTimeout(() => {
    if (shouldReconnect) connect(currentUrl);
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
