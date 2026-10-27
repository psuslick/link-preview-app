// Privacy-safe, aggregate-only diagnostic report. Never serialize any preview
// object, source URL, hostname, title, metadata, content, ID, or error string.
const METHODS = ["metadata-no-thumbnail", "edge-no-thumbnail", "edge-fallback-queued", "blocked-no-thumbnail", "retrying"];
const KEYS = ["queued", "loading", "ready", "failed"];
export function buildSafePreviewDiagnosticReport({ previews = [], networkState = {}, workspaceLoaded = false, processing = false, capturedAt = new Date() } = {}) {
  const methods = Object.fromEntries(METHODS.map((name) => [name, 0]));
  const counts = { total: previews.length, thumb: 0, withoutThumb: 0, queued: 0, loading: 0, ready: 0, failed: 0,
    fallbackQueued: 0, fallbackAttempted: 0, fallbackUsed: 0, skippedByHostPolicy: 0,
    verificationDetected: 0, sessionRecommended: 0, approvedSession: 0,
    http200NoThumb: 0, htmlBodyRead: 0, extraHtmlFetch: 0, interruptedByReload: 0 };
  let totalClientMs = 0, timed = 0;
  for (const item of previews) {
    if (KEYS.includes(item.state)) counts[item.state]++;
    const hasImage = Boolean(item.image || item.images?.length);
    if (hasImage) counts.thumb++; else counts.withoutThumb++;
    if (METHODS.includes(item.method)) methods[item.method]++;
    if (item.browserFallbackQueued) counts.fallbackQueued++;
    if (item.browserFallbackAttempted) counts.fallbackAttempted++;
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
    "Link Preview App v2.8.1 — privacy-safe diagnostic summary",
    `Capture time: ${capturedAt.toISOString()}`,
    `Workspace: ${workspaceLoaded ? "ready" : "restoring"}`,
    `Processing: ${processing ? "active" : "idle"}`,
    ...Object.entries(counts).map(([name, value]) => `${name}: ${value}`),
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
