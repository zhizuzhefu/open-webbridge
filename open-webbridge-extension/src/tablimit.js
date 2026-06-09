export function hostOf(u) {
  try {
    return new URL(u || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function domainMatches(host, ruleDomain) {
  const h = (host || "").toLowerCase();
  const d = (ruleDomain || "").toLowerCase().trim();
  if (!d) return false;
  return h === d || h.endsWith("." + d);
}

export function rulesToCheck(limits, targetUrl) {
  if (!Array.isArray(limits) || limits.length === 0) return [];

  const hasTarget = targetUrl != null && String(targetUrl).trim() !== "";
  if (!hasTarget) return limits.filter((lim) => lim && lim.domain && lim.max > 0);

  const targetHost = hostOf(targetUrl);
  if (!targetHost) return [];

  let best = null;
  let bestLen = -1;
  for (const lim of limits) {
    const domain = (lim && lim.domain ? lim.domain : "").toLowerCase().trim();
    if (lim && domain && lim.max > 0 && domainMatches(targetHost, domain)) {
      if (domain.length > bestLen) {
        best = lim;
        bestLen = domain.length;
      }
    }
  }
  return best ? [best] : [];
}

export function assertDomainTabLimits(limits, targetUrl, tabUrls) {
  for (const lim of rulesToCheck(limits, targetUrl)) {
    let count = 0;
    for (const tabURL of tabUrls || []) {
      if (tabURL && domainMatches(hostOf(tabURL), lim.domain)) count++;
    }
    if (count >= lim.max) {
      throw new Error(
        `per-domain tab limit reached for ${lim.domain}: ${count}/${lim.max} Open WebBridge tab(s) are open for this site; close a tab/session or run \`open-webbridge tablimit set ${lim.domain} --max <larger>\``
      );
    }
  }
}
