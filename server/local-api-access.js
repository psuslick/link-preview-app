// Only a loopback-served app UI may drive the local fetch/browser APIs.
// An arbitrary web page visited in the Sandbox must not be able to invoke the
// preview engine or read sensitive response metadata through permissive CORS.
function trustedLocalOrigin(raw) {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      !url.username && !url.password;
  } catch { return false; }
}

export function checkLocalApiAccess({ host, origin, referer, fetchSite }, port = 3000) {
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(String(host || "").toLowerCase())) {
    return { allowed: false, reason: "unexpected_host" };
  }
  // All JS fetches from the UI have an Origin on POST; allow localhost and
  // 127.0.0.1 Vite ports but never arbitrary internet/file:// origins.
  if (origin !== undefined) {
    return trustedLocalOrigin(origin)
      ? { allowed: true, origin }
      : { allowed: false, reason: "untrusted_origin" };
  }
  // HTML images don't normally carry Origin. Their Referrer-Policy is 'origin'
  // so the local UI is distinguishable from an embedded image on a remote page.
  if (referer !== undefined) {
    return trustedLocalOrigin(referer)
      ? { allowed: true }
      : { allowed: false, reason: "untrusted_referer" };
  }
  if (fetchSite === "cross-site") return { allowed: false, reason: "cross_site_request" };
  // CLI clients and local child processes omit all three browser-only headers.
  return { allowed: true };
}
