// Side-effect-free page-readiness decision for the disposable Edge inspector.
// Avoid accepting the first completed DOM as final while the player initializes.
export function hasPosterEvidence(html = "") {
  const sample = String(html || "").slice(0, 2 * 1024 * 1024);
  return /<video\b[^>]*\bposter\s*=|<meta\b[^>]*\b(?:og:image|twitter:image|thumbnail)\b|["'](?:thumbnailUrl|thumbnail_url|posterUrl|poster_url|previewImage|preview_image)["']\s*:\s*["'](?:https?:|\/)/i.test(sample);
}

export function shouldStopPassiveScan({ html = "", iteration = 0, action = "none" } = {}) {
  if (action === "manual_required") return true;
  if (action === "clicked_cookie_control") return false;
  // A real image hint can be captured immediately; give scripts at least a
  // couple of refresh ticks to avoid racing UI hydration.
  return iteration >= 1 && hasPosterEvidence(html);
}

export function shouldTryLegacyDomDump(result) {
  if (result == null) return true;
  if (result.ok || result.challenge) return false;
  // Only retry when DevTools machinery failed, not when a site itself is
  // inaccessible or slow. This prevents multiplying requests under congestion.
  return new Set([
    "passive_browser_worker_error", "passive_browser_bad_output",
    "websocket_api_unavailable", "debugger_connection_failed",
    "debugger_not_ready", "debugger_socket_missing", "empty_browser_dom"
  ]).has(result.error);
}
