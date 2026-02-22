import { useEffect, useState } from "react";
import axios from "axios";

export default function VideoGrid({ videos }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const API_URL = import.meta.env.VITE_API_URL;

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);

      try {
        const results = await Promise.all(
          videos.map(async (url) => {
            try {
              const res = await axios.post(`${API_URL}/scrape`, { url });
              return {
                url,
                title: res.data.title,
                thumbnail: res.data.thumbnail,
                error: false
              };
            } catch (err) {
              return {
                url,
                title: null,
                thumbnail: null,
                error: true
              };
            }
          })
        );

        setItems(results);
      } finally {
        setLoading(false);
      }
    };

    if (videos.length > 0) {
      fetchAll();
    } else {
      setItems([]);
    }
  }, [videos, API_URL]);

  return (
    <div className="video-grid">
      {loading && <div className="loading">Fetching thumbnails…</div>}

      {items.map((item, i) => (
        <div
          key={i}
          className="video-tile"
          onClick={() => window.open(item.url, "_blank")}
        >
          {item.thumbnail ? (
            <img src={item.thumbnail} alt={item.title || "Thumbnail"} />
          ) : (
            <div className="unsupported">
              {item.error ? "Error loading" : "No thumbnail found"}
            </div>
          )}

          <div className="title">
            {item.title || "Untitled"}
          </div>
        </div>
      ))}
    </div>
  );
}