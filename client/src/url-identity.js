// WHATWG URL normalizes scheme and hostname without changing case-sensitive
// paths, queries or SPA fragment routes on unfamiliar video hosts.
export function normalizeVideoUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch { return null; }
}

export function videoUrlIdentity(raw) {
  return normalizeVideoUrl(raw) || String(raw || "");
}

export function extractVideoUrls(text) {
  const candidates = String(text || "")
    .split(/\s+/)
    .map((value) => value.trim().replace(/^[<\[("']+|[>\])}"',;]+$/g, ""))
    .filter(Boolean);
  const seen = new Set();
  const urls = [];
  let invalid = 0;
  for (const candidate of candidates) {
    const normalized = normalizeVideoUrl(candidate);
    if (!normalized) { invalid += 1; continue; }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return { urls, invalid };
}
