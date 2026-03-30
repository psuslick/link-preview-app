import { useState } from "react";
import "./App.css";

function deriveGenericThumbnail(url) {
  try {
    const u = new URL(url);
    const origin = u.origin;
    const path = u.pathname.toLowerCase();

    // 1. Favicon fallback
    const favicon = `${origin}/favicon.ico`;

    // 2. Generic thumbnail-ish patterns
    const patterns = [
      "/cdn/",
      "/static/",
      "/assets/",
      "/media/",
      "/preview/",
      "/previews/",
      "/thumb/",
      "/thumbs/",
      "/thumbnail/",
      "/thumbnails/",
      "/images/",
      "/img/"
    ];

    if (patterns.some((p) => path.includes(p))) {
      return `${origin}${path}`;
    }

    // 3. Numeric ID guess
    const id = path.match(/\d+/)?.[0];
    if (id) {
      return `${origin}/images/${id}.jpg`;
    }

    // 4. Favicon fallback
    return favicon;
  } catch {
    return null;
  }
}

function App() {
  const [url, setUrl] = useState("");
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(false);

  const API_URL = "http://localhost:3000/api/preview";

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);

    const start = performance.now();
    let diagnostics = {
      requestUrl: url,
      startTime: new Date().toISOString(),
      timing: {},
      headers: {},
      status: null,
      ok: false,
      blocked: false,
      error: null,
      raw: null
    };

    try {
      const response = await fetch(
        `${API_URL}?url=${encodeURIComponent(url)}`
      );

      diagnostics.status = response.status;
      diagnostics.ok = response.ok;

      response.headers.forEach((value, key) => {
        diagnostics.headers[key] = value;
      });

      let json = null;
      try {
        json = await response.json();
      } catch (err) {
        json = { error: "invalid_json", message: err.message };
      }

      diagnostics.raw = json;
      diagnostics.blocked = json?.blocked || false;
      diagnostics.error = json?.error || null;

      const end = performance.now();
      diagnostics.timing.totalMs = Math.round(end - start);

      const compatibility =
        diagnostics.status === 200 && !diagnostics.blocked
          ? "Compatible"
          : diagnostics.status === 403
          ? "Site does not allow automated previews"
          : diagnostics.status === 502
          ? "Upstream error"
          : diagnostics.status === "NETWORK_ERROR"
          ? "Backend unreachable"
          : "Unknown / Limited";

      setPreviews((prev) => [
        {
          ...json,
          diagnostics,
          compatibility
        },
        ...prev
      ]);

      setUrl("");
    } catch (error) {
      const end = performance.now();

      diagnostics.status = "NETWORK_ERROR";
      diagnostics.ok = false;
      diagnostics.error = error.message;
      diagnostics.timing.totalMs = Math.round(end - start);

      setPreviews((prev) => [
        {
          title: null,
          description: null,
          image: null,
          url,
          diagnostics,
          compatibility: "Backend unreachable"
        },
        ...prev
      ]);
    }

    setLoading(false);
  };

  return (
    <div className="container">
      <h1>Hybrid Link Preview Engine</h1>

      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="text"
          placeholder="Enter a URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Preview"}
        </button>
      </form>

      <div className="preview-grid">
        {previews.map((preview, index) => {
          const fallbackThumb = preview.url
            ? deriveGenericThumbnail(preview.url)
            : null;

          return (
            <div key={index} className="preview-card">
              {preview.image ? (
                <img
                  src={preview.image}
                  alt="Preview"
                  className="preview-image"
                />
              ) : fallbackThumb ? (
                <img
                  src={fallbackThumb}
                  alt="Fallback"
                  className="preview-image"
                />
              ) : (
                <div className="fallback-image">
                  <span>No Image</span>
                </div>
              )}

              <div className="preview-content">
                <h2>{preview.title || "No title found"}</h2>
                <p>{preview.description || "No description available"}</p>

                {preview.url && (
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit Site →
                  </a>
                )}
              </div>

              <div className="compatibility">
                <strong>Compatibility:</strong> {preview.compatibility}
              </div>

              <div className="diagnostic-panel">
                <h3>Diagnostics</h3>

                <p>
                  <strong>Status:</strong> {preview.diagnostics.status}
                </p>

                <p>
                  <strong>Time:</strong>{" "}
                  {preview.diagnostics.timing.totalMs} ms
                </p>

                <p>
                  <strong>Blocked:</strong>{" "}
                  {preview.diagnostics.blocked ? "Yes" : "No"}
                </p>

                <p>
                  <strong>Error:</strong>{" "}
                  {preview.diagnostics.error || "None"}
                </p>

                <details>
                  <summary>Headers</summary>
                  <pre>
                    {JSON.stringify(
                      preview.diagnostics.headers,
                      null,
                      2
                    )}
                  </pre>
                </details>

                <details>
                  <summary>Raw JSON</summary>
                  <pre>
                    {JSON.stringify(
                      preview.diagnostics.raw,
                      null,
                      2
                    )}
                  </pre>
                </details>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;