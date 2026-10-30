// Privacy-safe, aggregate-only diagnostic report. Never serialize preview
// objects, URLs, hostnames, titles, metadata, content, IDs or raw errors.
const METHODS = ["metadata-no-thumbnail", "edge-no-thumbnail", "edge-fallback-queued", "blocked-no-thumbnail", "retrying"];
const KEYS = ["queued", "loading", "ready", "failed"];
const FALLBACK_CATEGORIES = ["unavailable", "launch", "timeout", "debugger", "empty_dom", "challenge", "resource_limit", "network", "other", "none"];

// Match only known INTERNAL error codes. Unknown strings are collapsed to a
// fixed "other" category, never copied verbatim or partially into a report.
export function classifySafeBrowserFailure(value) {
  if (typeof value !== "string" || !value.trim()) return "none";
  if (/^(?:edge_fallback_unavailable|edge_unavailable)$/.test(value)) return "unavailable";
  if (/^(?:edge_launch_failed|edge_helper_launch_failed|passive_browser_worker_error|authorized_session_probe_launch_failed|edge_helper_exit_(?:unknown|\d+))$/.test(value)) return "launch";
  if (/^(?:edge_helper_timeout|edge_fallback_timeout|passive_browser_timeout|authorized_session_probe_timeout|debugger_command_timeout)$/.test(value)) return "timeout";
  if (/^(?:debugger_not_ready|debugger_socket_missing|debugger_connection_failed|debugger_closed|websocket_api_unavailable|target_attach_failed|devtools_browser_socket_missing|debugger_command_failed|passive_browser_bad_output|headless_dom_failed)$/.test(value)) return "debugger";
  if (/^(?:empty_browser_dom|edge_empty_dom|edge_empty_dom_(?:unknown|\d+))$/.test(value)) return "empty_dom";
  if (/^(?:edge_challenge_page|edge_challenge_circuit_open|authorized_session_challenge_page)$/.test(value)) return "challenge";
  if (/^(?:edge_dom_too_large|browser_dom_too_large|edge_helper_output_too_large|passive_browser_output_too_large|authorized_session_output_too_large)$/.test(value)) return "resource_limit";
  if (/^(?:private_network_url_blocked|private_network_dns_blocked|proxy_http_only)$/.test(value)) return "network";
  return "other";
}

function httpStatusCategory(status) {
  // Upstream status only. Never include response text or a page URL.
  if (status === 200) return "http200";
  if ([401, 403].includes(status)) return "http401_403";
  if ([404, 410].includes(status)) return "http404_410";
  if ([429, 503].includes(status)) return "http429_503";
  if (Number.isInteger(status) && status >= 100 && status <= 599) return "httpOther";
  return "httpUnknown";
}

export function buildSafePreviewDiagnosticReport({ previews = [], networkState = {}, workspaceLoaded = false, processing = false, capturedAt = new Date() } = {}) {
  const methods = Object.fromEntries(METHODS.map((name) => [name, 0]));
  const failures = Object.fromEntries(FALLBACK_CATEGORIES.map((name) => [`fallbackFailure_${name}`, 0]));
  const statuses = Object.fromEntries(["http200", "http401_403", "http404_410", "http429_503", "httpOther", "httpUnknown"].map((name) => [`missing_${name}`, 0]));
  const counts = { total: previews.length, thumb: 0, withoutThumb: 0, queued: 0, loading: 0, ready: 0, failed: 0,
    fallbackQueued: 0, fallbackAttempted: 0, fallbackUsed: 0, fallbackAttemptedWithoutImage: 0,
    fallbackNotAttemptedWithoutImage: 0, skippedByHostPolicy: 0,
    verificationDetected: 0, sessionRecommended: 0, approvedSession: 0,
    http200NoThumb: 0, htmlBodyRead: 0, extraHtmlFetch: 0, interruptedByReload: 0 };
  let totalClientMs = 0, timed = 0;
  for (const item of previews) {
    if (KEYS.includes(item.state)) counts[item.state]++;
    const hasImage = Boolean(item.image || item.images?.length);
    if (hasImage) counts.thumb++;
    else { counts.withoutThumb++; statuses[`missing_${httpStatusCategory(item.upstreamStatus)}`]++; }
    if (METHODS.includes(item.method)) methods[item.method]++;
    if (item.browserFallbackQueued) counts.fallbackQueued++;
    if (item.browserFallbackAttempted) {
      counts.fallbackAttempted++;
      if (!hasImage) counts.fallbackAttemptedWithoutImage++;
      failures[`fallbackFailure_${classifySafeBrowserFailure(item.browserFallbackError)}`]++;
    } else if (!hasImage) counts.fallbackNotAttemptedWithoutImage++;
    if (item.browserFallback) counts.fallbackUsed++;
    if (item.browserFallbackSkippedReason === "same_host_public_probe_unresolved") counts.skippedByHostPolicy++;
    if (item.manualVerificationRequired) counts.verificationDetected++;
    if (item.siteSessionRecommended) counts.sessionRecommended++;
    if (item.authorizedBrowserProfile || item.authorizedBrowserSession) counts.approvedSession++;
    if (item.upstreamStatus === 200 && !hasImage) counts.http200NoThumb++;
    if (item.passiveBodyRead) counts.htmlBodyRead++;
    if (item.passiveBodyRetry) counts.extraHtmlFetch++;
    if (item.error === "Interrupted by app-tab reload; use Retry failed to resume.") counts.interruptedByReload++;
    if (Number.isFinite(item.clientMs)) { totalClientMs += item.clientMs; timed++; }
  }
  const dns = networkState?.dns || {}, http = networkState?.http || {}, traffic = networkState?.traffic || {};
  return [
    "Link Preview App v2.8.3 — privacy-safe diagnostic summary",
    `Capture time: ${capturedAt.toISOString()}`,
    `Workspace: ${workspaceLoaded ? "ready" : "restoring"}`,
    `Processing: ${processing ? "active" : "idle"}`,
    ...Object.entries(counts).map(([name, value]) => `${name}: ${value}`),
    ...Object.entries(statuses).map(([name, value]) => `${name}: ${value}`),
    ...Object.entries(failures).map(([name, value]) => `${name}: ${value}`),
    ...Object.entries(methods).map(([name, value]) => `method_${name}: ${value}`),
    `Mean preview response: ${timed ? Math.round(totalClientMs / timed) : 0} ms`,
    `DNS queued: ${Number(dns.queued) || 0}`,
    `DNS fresh/s: ${Number(dns.recentFreshLookupsPerSecond) || 0}`,
    `DNS errors: ${Number(dns.errors) || 0}`,
    `HTTP active: ${Number(http.active) || 0}`,
    `HTTP queued: ${Number(http.queued) || 0}`,
    `Backend bytes: ${Number(traffic.backendResponseBytesTotal) || 0}`,
    `Browser proxy bytes: ${Number(traffic.browserProxyBytesTotal) || 0}`,
    "Contains fixed categories, aggregate counts and timestamps only.",
    "Contains no URLs, domains, titles, IDs, free-text errors or extracted content."
  ].join("\n");
}
