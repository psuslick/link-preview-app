import { useState } from "react";
import { fetchPreviewBatch } from "./api.js";
import PreviewGrid from "./components/PreviewGrid.jsx";

export default function App() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const urls = input
      .split("\n")
      .map(u => u.trim())
      .filter(Boolean);

    if (urls.length === 0) return;

    setLoading(true);
    const data = await fetchPreviewBatch(urls);
    setResults(data.results || []);
    setLoading(false);
  }

  return (
    <div className="app">
      <h1>Hybrid Link Preview Generator</h1>

      <form onSubmit={handleSubmit}>
        <textarea
          placeholder="Enter one URL per line"
          value={input}
          onChange={e => setInput(e.target.value)}
        />

        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Generate Previews"}
        </button>
      </form>

      <PreviewGrid results={results} />
    </div>
  );
}