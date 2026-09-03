const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000/api";

export async function fetchPreview(url, { signal } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
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

export function imageProxyUrl(url) {
  if (!url) return null;
  return `${API_BASE}/image?url=${encodeURIComponent(url)}`;
}
