const API_BASE = "http://localhost:4000/api";

export async function fetchPreview(url) {
  const res = await fetch(`${API_BASE}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  return res.json();
}

export async function fetchPreviewBatch(urls) {
  const res = await fetch(`${API_BASE}/preview/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls })
  });

  return res.json();
}