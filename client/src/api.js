const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000/api";

export async function fetchPreview(url, { signal, allowBrowserFallback = true } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, allowBrowserFallback }),
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
      error: error?.name === "AbortError" ? "cancelled" : error?.message || "backend_unreachable",
      clientStatus: 0,
      clientOk: false,
      clientMs: Math.round(performance.now() - started)
    };
  }
}

export async function fetchAlternates(source, { signal } = {}) {
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
        durationSeconds: source.durationSeconds || null
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
      error: error?.name === "AbortError" ? "cancelled" : error?.message || "backend_unreachable",
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
