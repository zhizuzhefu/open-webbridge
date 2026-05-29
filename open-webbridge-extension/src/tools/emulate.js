// emulate.js — device-metrics / user-agent / geolocation emulation via the CDP
// Emulation domain. Overrides persist on the tab until cleared or the tab
// navigates away under some conditions; call with {clear:true} to reset.

import { cdp } from "../cdp.js";
import { getActiveTab } from "../sessions.js";

export async function emulate(args, session) {
  const tabId = getActiveTab(session);

  if (args.clear) {
    await cdp.send(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send(tabId, "Emulation.clearGeolocationOverride").catch(() => {});
    await cdp.send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
    return { success: true, cleared: true };
  }

  const applied = {};

  if (args.device) {
    const d = args.device;
    if (d.width == null || d.height == null) throw new Error("device requires width and height");
    await cdp.send(tabId, "Emulation.setDeviceMetricsOverride", {
      width: Math.round(d.width),
      height: Math.round(d.height),
      deviceScaleFactor: d.deviceScaleFactor || 0,
      mobile: !!d.mobile,
    });
    applied.device = d;
  }

  if (args.userAgent) {
    await cdp.send(tabId, "Emulation.setUserAgentOverride", { userAgent: String(args.userAgent) });
    applied.userAgent = args.userAgent;
  }

  if (args.geolocation) {
    const g = args.geolocation;
    if (g.latitude == null || g.longitude == null) throw new Error("geolocation requires latitude and longitude");
    // Note: this overrides the coordinates returned to pages that ALREADY have
    // geolocation permission. We can't auto-grant the permission — that's a
    // browser-level CDP command, unreachable from a tab-attached debugger — so
    // a site still showing the permission prompt must be allowed by the user.
    await cdp.send(tabId, "Emulation.setGeolocationOverride", {
      latitude: g.latitude,
      longitude: g.longitude,
      accuracy: g.accuracy || 100,
    });
    applied.geolocation = g;
  }

  if (Object.keys(applied).length === 0) {
    throw new Error("emulate needs one of: device, userAgent, geolocation, or clear:true");
  }
  return { success: true, applied };
}
