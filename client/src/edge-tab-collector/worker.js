// Runs only when a user presses Collect open Edge tabs in the localhost app.
// No fetch, webRequest, persistent storage, host integration or background crawl.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "SANDBOX_COLLECT_TABS_V1") return;
  let origin;
  try { origin = new URL(sender?.url || ""); } catch { sendResponse({ error: "untrusted_sender" }); return; }
  if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname) || !["5173", "4173"].includes(origin.port)) {
    sendResponse({ error: "untrusted_sender" });
    return;
  }
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) { sendResponse({ error: "tab_query_failed" }); return; }
    const seen = new Set();
    const urls = [];
    for (const tab of tabs || []) {
      const value = tab.url || tab.pendingUrl || "";
      let link;
      try { link = new URL(value); } catch { continue; }
      if (!["http:", "https:"].includes(link.protocol)) continue;
      if (["localhost", "127.0.0.1"].includes(link.hostname) && ["5173", "4173"].includes(link.port)) continue;
      if (seen.has(link.toString())) continue;
      seen.add(link.toString());
      urls.push(link.toString());
    }
    sendResponse({ urls });
  });
  return true;
});
