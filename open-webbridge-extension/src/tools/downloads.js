// downloads.js — file downloads via the extension's native chrome.downloads
// API. (The CDP Browser/Page.setDownloadBehavior commands are browser-level and
// not reachable from a tab-attached chrome.debugger session, so we use the
// proper extension API instead — it also auto-updates state and survives the
// loopback-only model.)
//
//   cmd:"start" url:<href>   begin a download, returns its id
//   cmd:"list"  [limit]      recent downloads with state/filename/bytes
//   cmd:"cancel" id:<id>     cancel an in-progress download

export async function download(args, _session) {
  const cmd = args.cmd || "list";

  if (cmd === "start") {
    if (!args.url) throw new Error("download start requires url");
    const opts = { url: args.url };
    if (args.filename) opts.filename = args.filename;
    if (args.saveAs != null) opts.saveAs = !!args.saveAs;
    const id = await chrome.downloads.download(opts);
    return { success: true, id };
  }

  if (cmd === "list") {
    const items = await chrome.downloads.search({
      limit: args.limit || 20,
      orderBy: ["-startTime"],
    });
    return {
      downloads: items.map((d) => ({
        id: d.id,
        url: d.url,
        filename: d.filename,
        state: d.state, // in_progress | interrupted | complete
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        exists: d.exists,
      })),
    };
  }

  if (cmd === "cancel") {
    if (args.id == null) throw new Error("download cancel requires id");
    await chrome.downloads.cancel(args.id);
    return { success: true };
  }

  throw new Error(`download cmd must be start|list|cancel (got ${cmd})`);
}
