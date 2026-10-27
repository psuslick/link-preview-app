// Browser-memory-only scheduling decisions. No URL, title or hostname is exported.
export function pendingSiteRecoveryItems(previews, siteKey, sourceId, siteKeyFor, needsRetry) {
  return (previews || []).filter((item) =>
    item.id !== sourceId && siteKeyFor(item.url) === siteKey && needsRetry(item)
  );
}

export function recoveryFailureCount(previousCount, succeeded) {
  return succeeded ? 0 : Math.max(0, previousCount) + 1;
}

export function siteRecoveryDelayMs(consecutiveFailures, baseMs = 850) {
  return Math.min(5000, Math.max(500, baseMs) * Math.pow(2, Math.min(3, Math.max(0, consecutiveFailures))));
}
