// Only forward messages from the Sandbox app's development/preview UI ports.
// The page cannot call tabs.query itself; this optional user-loaded extension can.
if (["localhost", "127.0.0.1"].includes(location.hostname) && ["5173", "4173"].includes(location.port)) {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type !== "SANDBOX_APP_COLLECT_TABS_V1" || event.data?.source !== "sandbox-link-preview-app") return;
    const requestId = event.data.requestId;
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) return;
    chrome.runtime.sendMessage({ type: "SANDBOX_COLLECT_TABS_V1" }, (response) => {
      const error = chrome.runtime.lastError?.message || response?.error || null;
      window.postMessage({
        source: "sandbox-link-preview-tab-collector",
        type: "SANDBOX_TAB_RESULTS_V1",
        requestId,
        urls: error ? [] : response?.urls || [],
        error
      }, location.origin);
    });
  });
}
