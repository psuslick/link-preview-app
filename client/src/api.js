const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:3000/api";

export async function fetchPreview(url, { signal, allowBrowserFallback = true, privacy } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, allowBrowserFallback, privacy: privacy || null }),
      signal
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: "invalid_json_response" };
    }

    return {
      ...data,
      url: data?.url || url,
      clientStatus: response.status,
      clientOk: response.ok,
      clientMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      url,
      image: null,
      title: null,
      description: null,
      error: error?.name === "AbortError" ? "cancelled" : "backend_unreachable",
      clientNetworkError: error?.message || "Failed to fetch",
      clientStatus: 0,
      clientOk: false,
      clientMs: Math.round(performance.now() - started)
    };
  }
}

export async function fetchAlternates(source, { signal, privacy } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE}/alternates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: source.url,
        title: source.title || null,
        description: source.description || null,
        provider: source.provider || null,
        durationSeconds: source.durationSeconds || null,
        privacy: privacy || null
      }),
      signal
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: "invalid_json_response" };
    }

    return {
      ...data,
      clientStatus: response.status,
      clientOk: response.ok,
      clientMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      results: [],
      error: error?.name === "AbortError" ? "cancelled" : "backend_unreachable",
      clientNetworkError: error?.message || "Failed to fetch",
      clientStatus: 0,
      clientOk: false,
      clientMs: Math.round(performance.now() - started)
    };
  }
}

export function imageProxyUrl(url, sourceUrl) {
  if (!url) return null;
  const params = new URLSearchParams({ url });
  if (sourceUrl) params.set("source", sourceUrl);
  return `${API_BASE}/image?${params.toString()}`;
}

export async function compareVideoSamples(sourceUrl, candidateUrl, { signal, privacy } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE}/compare-video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl, candidateUrl, privacy: privacy || null }),
      signal
    });
    let data;
    try { data = await response.json(); } catch { data = { error: "invalid_json_response" }; }
    return {
      ...data,
      clientStatus: response.status,
      clientOk: response.ok,
      clientMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "cancelled" : "backend_unreachable",
      clientNetworkError: error?.message || "Failed to fetch",
      clientStatus: 0,
      clientOk: false,
      clientMs: Math.round(performance.now() - started)
    };
  }
}

export async function authorizePreviewHost(url, { privacy } = {}) {
  const response = await fetch(`${API_BASE}/authorize-host`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, privacy: privacy || null })
  });
  let data;
  try { data = await response.json(); } catch { data = { error: "invalid_json_response" }; }
  return { ...data, clientStatus: response.status, clientOk: response.ok };
}

export async function authorizationStatus(url) {
  try {
    const response = await fetch(`${API_BASE}/authorization-status?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    return { ...data, clientStatus: response.status, clientOk: response.ok };
  } catch (error) {
    return { status: "unknown", ready: false, clientOk: false, error: error?.message || "Failed to fetch" };
  }
}
