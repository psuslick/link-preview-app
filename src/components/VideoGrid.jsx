import { useEffect, useState } from "react";

export default function VideoGrid({ videos }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!videos || videos.length === 0) {
      setResults([]);
      return;
    }

    const fetchData = async () => {
      setLoading(true);

      const newResults = await Promise.all(
        videos.map(async (url) => {
          if (!url || url.trim() === "") {
            return { url, title: null, thumbnail: null, error: true };
          }

          try {
            const res = await fetch("http://localhost:4000/scrape", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url }),
            });

            if (!res.ok) {
              return { url, title: null, thumbnail: null, error: true };
            }

            const data = await res.json();
            return { ...data, error: false };
          } catch (err) {
            return { url, title: null, thumbnail: null, error: true };
          }
        })
      );

      setResults(newResults);
      setLoading(false);
    };

    fetchData();
  }, [videos]);

  return (
    <div className="video-grid">
      {loading && <p>Fetching previews…</p>}

      {results.map((item, idx) => (
        <div key={idx} className="video-tile">
          {item.error || !item.thumbnail ? (
            <div className="error-box">
              <p>Error loading</p>
            </div>
          ) : (
            <img
              src={item.thumbnail}
              alt={item.title || "Video thumbnail"}
              className="thumbnail"
              onClick={() => window.open(item.url, "_blank")}
            />
          )}

          <p className="video-title">{item.title || "No title found"}</p>
        </div>
      ))}
    </div>
  );
}