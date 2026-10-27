// Conservative same-host sampling: enough to avoid treating one difficult
// URL as representative, without repeatedly probing a known inaccessible host.
const browserInfrastructureErrors = new Set([
  "edge_fallback_unavailable", "edge_helper_timeout", "edge_fallback_timeout",
  "edge_challenge_circuit_open", "passive_browser_timeout"
]);
export function shouldContinueHostProbes(result, completed, maxCount = 3) {
  if (completed >= maxCount || !result?.clientOk || result.image) return false;
  if (result.challengeDetected || result.manualVerificationRequired) return false;
  if (browserInfrastructureErrors.has(result.browserFallbackError)) return false;
  return true;
}
