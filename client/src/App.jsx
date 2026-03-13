import React, { useState } from "react";
import PreviewGrid from "./components/PreviewGrid";

export default function App() {
  const [urls, setUrls] = useState("");
  const [loading, setLoading] = useState(false);
  const [previews, setPreviews] = useState([]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setPreviews([]);

    const list = urls
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);

    const results = [];

    for (const url of list) {
      try {
        const res = await fetch("/api/screenshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url })
        });

        const data = await res.json();

        if (data.success) {
          results.push({ url, screenshot: data.screenshot });
        } else {
          results.push({ url, screenshot: null });
        }
      } catch {
        results.push({ url, screenshot: null });
      }
    }

    setPreviews(results);
    setLoading(false);
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Video Screenshot Preview</h1>

      <form onSubmit={handleSubmit}>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder="Enter one URL per line"
          rows={6}
          style={{ width: "100%", marginBottom: 12 }}
        />

        <button type="submit" disabled={loading}>
          {loading ? "Processing..." : "Generate Previews"}
        </button>
      </form>

      {loading && <p>Generating screenshots…</p>}

      <PreviewGrid items={previews.filter((p) => p.screenshot)} />
    </div>
  );
}