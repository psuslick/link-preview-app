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
  const [inputText, setInputText] = useState("");
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [importSummary, setImportSummary] = useState(null);

  const API_URL = "http://localhost:3000/api/preview";

  async function fetchPreview(url) {
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
          url,
          diagnostics,
          compatibility
        },
        ...prev
      ]);
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
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    // Split into lines, trim, remove empties
    const urls = inputText
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    // Normalize existing URLs
    const existing = new Set(
      previews.map((p) => p.url?.toLowerCase().trim()).filter(Boolean)
    );

    // Filter new URLs
    const newUrls = urls.filter((u) => !existing.has(u.toLowerCase()));

    const summary = {
      added: newUrls.length,
      skipped: urls.length - newUrls.length
    };

    setImportSummary(summary);

    if (newUrls.length === 0) {
      setInputText("");
      return;
    }

    setLoading(true);

    for (const url of newUrls) {
      await fetchPreview(url);
    }

    setLoading(false);
    setInputText("");
  };

  return (
    <div className="container">
      <h1>Hybrid Link Preview Engine</h1>

      <form onSubmit={handleSubmit} className="input-form">
        <textarea
          placeholder="Enter one URL per line..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="multi-input"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Preview"}
        </button>
      </form>

      {importSummary && (
        <div className="import-summary">
          Added {importSummary.added} new links, skipped {importSummary.skipped} duplicates
        </div>
      )}

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