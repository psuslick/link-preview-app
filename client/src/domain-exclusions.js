// Domain exclusions are deliberately session-only. They are evaluated before
// any preview/network work and include every subdomain, but not lookalike hosts.
export function normalizeExcludedDomain(input) {
  let raw = String(input || "").trim().replace(/^\*\./, "");
  if (!raw || /\s/.test(raw)) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname.includes(".") || hostname.length > 253 || hostname.includes("..")) return null;
    if (!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return hostname;
  } catch { return null; }
}

export function isExcludedUrl(rawUrl, domains = []) {
  let host;
  try { host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { return false; }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function excludeUrls(urls, domains = []) {
  const kept = [], removed = [];
  for (const url of urls) (isExcludedUrl(url, domains) ? removed : kept).push(url);
  return { kept, removed };
}
