// popup.js — minimal UI to connect/disconnect the extension to the daemon.

const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const dot = $("dot");
const statusText = $("status-text");
const msg = $("msg");
const annBtn = $("annotate");
const annMsg = $("ann-msg");

function setMsg(text, kind) {
  msg.textContent = text || "";
  msg.className = "msg" + (kind ? " " + kind : "");
}

function setAnnMsg(text, kind) {
  annMsg.textContent = text || "";
  annMsg.className = "msg" + (kind ? " " + kind : "");
}

function renderAnnotate(on) {
  annBtn.textContent = on ? "Stop annotating" : "Start annotating";
  annBtn.classList.toggle("active", !!on);
}

function render(connected, url) {
  dot.className = "dot " + (connected ? "on" : "off");
  statusText.textContent = connected ? "Connected" : "Disconnected";
  if (url && !urlInput.value) urlInput.value = url;
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(st.connected, st.url);
  renderAnnotate(st.annotating);
  // Restore last URL even when disconnected.
  if (!urlInput.value) {
    const saved = await chrome.storage.local.get(["owb_ws_url"]);
    if (saved.owb_ws_url) urlInput.value = saved.owb_ws_url;
  }
  // Surface version/connection notices (incompatible version, rejected, …).
  const n = st.notice || (await chrome.storage.local.get(["owb_notice"])).owb_notice;
  if (n && n.message) {
    setMsg(n.message, n.level === "error" ? "err" : "warn");
  } else {
    setMsg("");
  }
}

async function doConnect(url) {
  if (!url) {
    setMsg("Enter the WebSocket URL first.", "err");
    return;
  }
  setMsg("Testing connection…");
  const test = await chrome.runtime.sendMessage({ type: "TEST", url });
  if (!test.ok) {
    setMsg("Could not connect: " + (test.reason || "unknown"), "err");
    return;
  }
  await chrome.runtime.sendMessage({ type: "CONNECT", url });
  setMsg("Connected.", "ok");
  setTimeout(refresh, 200);
}

$("connect").addEventListener("click", () => doConnect(urlInput.value.trim()));

$("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "DISCONNECT" });
  setMsg("Disconnected.");
  setTimeout(refresh, 200);
});

annBtn.addEventListener("click", async () => {
  setAnnMsg("");
  const res = await chrome.runtime.sendMessage({ type: "TOGGLE_ANNOTATE" });
  if (res && res.error) {
    setAnnMsg(res.error, "err");
    return;
  }
  renderAnnotate(res.annotating);
  if (res.annotating) {
    setAnnMsg("Click elements on the page to leave notes.", "ok");
    setTimeout(() => window.close(), 700);
  }
});

// Deep-link: popup.html?url=<ws>&connect=1 prefills and (optionally) connects.
// Handy for scripted setup and "click to connect" links.
(function handleDeepLink() {
  const q = new URLSearchParams(location.search);
  const url = q.get("url");
  if (url) {
    urlInput.value = url;
    if (q.get("connect") === "1") doConnect(url);
  }
})();

refresh();
