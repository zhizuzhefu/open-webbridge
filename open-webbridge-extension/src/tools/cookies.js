// cookies.js — read cookies (including HttpOnly) via the CDP Network domain.
//
// HttpOnly cookies are invisible to page JS (`document.cookie`), so `evaluate`
// can never see them — that is exactly the flag a login token like `_m_h5_tk`
// hides behind. The DevTools Protocol bypasses HttpOnly, so this tool can
// export the real session an AI needs to hand off to a backend (e.g. import a
// logged-in account elsewhere).
//
//   cmd:"get"  [urls] [domain]   cookies for the active tab (default: current
//                                page's frames); pass urls to scope to specific
//                                origins.
//   cmd:"all"  [domain]          every cookie in the browser profile, optionally
//                                filtered to one domain (and its subdomains).
//
// Each cookie carries name, value, domain, path, expires, httpOnly, secure,
// sameSite, and a `session` flag. The result also includes a ready-to-paste
// `header` string ("k=v; k=v; …") for use as a request Cookie: header.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

// Match a cookie domain against a requested domain: exact, or a subdomain of
// it. Leading dots (".goofish.com") are normalized away on both sides.
function matchesDomain(cookieDomain, want) {
  const c = String(cookieDomain || "").toLowerCase().replace(/^\./, "");
  const w = String(want).toLowerCase().replace(/^\./, "");
  return c === w || c.endsWith("." + w);
}

function shape(c) {
  const persistent = typeof c.expires === "number" && c.expires > 0;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: persistent ? c.expires : null, // unix seconds, or null for a session cookie
    session: !persistent,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || null,
  };
}

export async function cookies(args, session) {
  const tabId = getActiveTab(session);
  await cdp.ensureDomain(tabId, "Network");
  const cmd = args.cmd || "get";

  let list;
  if (cmd === "all") {
    const res = await cdp.send(tabId, "Network.getAllCookies");
    list = res.cookies || [];
  } else if (cmd === "get") {
    const params = {};
    if (args.urls) params.urls = Array.isArray(args.urls) ? args.urls : [String(args.urls)];
    const res = await cdp.send(tabId, "Network.getCookies", params);
    list = res.cookies || [];
  } else {
    throw new Error(`unknown cookies cmd: ${cmd} (use get|all)`);
  }

  if (args.domain) list = list.filter((c) => matchesDomain(c.domain, args.domain));
  list.sort(
    (a, b) =>
      String(a.domain || "").localeCompare(String(b.domain || "")) ||
      String(a.name || "").localeCompare(String(b.name || "")),
  );

  const out = list.map(shape);
  const header = out.map((c) => `${c.name}=${c.value}`).join("; ");
  return { count: out.length, cookies: out, header };
}
